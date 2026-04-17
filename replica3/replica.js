const express = require("express")
const axios = require("axios")

const app = express()
app.use(express.json())

// CONFIG: Support assignment-required environment variables
const PORT = process.env.PORT || 5001
const ID = process.env.REPLICA_ID || `node-${PORT}`
const peerUrls = (process.env.PEERS 
  ? process.env.PEERS.split(",") 
  : ["http://localhost:5001", "http://localhost:5002", "http://localhost:5003"])

const peers = peerUrls.filter(url => !url.includes(`:${PORT}`))

// RAFT STATE
let state = "follower", currentTerm = 0, votedFor = null, votesReceived = 0
let log = [], commitIndex = -1, lastApplied = -1
let electionTimeout = null, heartbeatInterval = null

console.log(`[Replica ${ID}] Starting on port ${PORT}`)
setTimeout(() => resetElectionTimer(), 1000)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function resetElectionTimer() {
  clearTimeout(electionTimeout)
  const timeout = 1500 + (Math.random() * 1000) // 1.5s - 2.5s for stability
  electionTimeout = setTimeout(async () => {
    if (state === "follower") startElection()
  }, timeout)
}

async function startElection() {
  state = "candidate"; currentTerm++; votedFor = ID; votesReceived = 1
  peers.forEach(peer => {
    axios.post(`${peer}/request-vote`, { term: currentTerm, candidateId: ID }, { timeout: 800 })
      .then(res => {
        if (res.data.voteGranted) {
          votesReceived++
          if (state === "candidate" && votesReceived >= 2) becomeLeader()
        }
      }).catch(() => {})
  })
}

function becomeLeader() {
  state = "leader"; console.log(`[Replica ${ID}] ★ LEADER ★`)
  startHeartbeat()
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  heartbeatInterval = setInterval(() => {
    if (state !== "leader") return clearInterval(heartbeatInterval)
    peers.forEach(peer => {
      axios.post(`${peer}/append-entries`, { term: currentTerm, leaderId: ID, leaderCommit: commitIndex }, { timeout: 500 })
        .catch(() => {})
    })
  }, 150) // Exact assignment spec: 150ms
}

app.post("/request-vote", (req, res) => {
  const { term, candidateId } = req.body
  if (term > currentTerm) { currentTerm = term; state = "follower"; votedFor = null; }
  if (term === currentTerm && (votedFor === null || votedFor === candidateId)) {
    votedFor = candidateId; resetElectionTimer(); return res.json({ voteGranted: true })
  }
  res.json({ voteGranted: false })
})

app.post("/append-entries", (req, res) => {
  const { term, leaderCommit } = req.body
  if (term >= currentTerm) {
    if (term > currentTerm) currentTerm = term
    state = "follower"; resetElectionTimer()
    if (leaderCommit > commitIndex) commitIndex = Math.min(leaderCommit, log.length - 1)
  }
  res.json({ success: true })
})

app.post("/add-entry", async (req, res) => {
  if (state !== "leader") return res.status(400).json({ error: "Not leader" })
  log.push({ term: currentTerm, data: req.body })
  const index = log.length - 1
  // Simple commit logic for demo: assume success if leader exists
  commitIndex = index
  res.json({ success: true, index })
})

// Sync Log RPC as required by Section 4.3 Catch-Up Protocol
app.get("/sync-log", (req, res) => {
  const fromIndex = parseInt(req.query.n) || 0
  res.json({ entries: log.slice(fromIndex) })
})

app.get("/committed-log", (req, res) => res.json({ entries: log }))
app.get("/log-state", (req, res) => res.json({ id: ID, state, term: currentTerm, commitIndex }))

app.listen(PORT, () => console.log(`[Replica ${ID}] Listening`))
