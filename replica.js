const express = require("express")
const axios = require("axios")

const app = express()
app.use(express.json())

const PORT = String(process.argv[2] || process.env.PORT || "5001")
const ID = String(process.env.REPLICA_ID || PORT)

const peerUrls = [
  "http://localhost:5001",
  "http://localhost:5002",
  "http://localhost:5003"
]

const peers = peerUrls.filter(peerUrl => !peerUrl.endsWith(`:${PORT}`))
const portNumber = Number(PORT) || 0

let state = "follower"
let currentTerm = 0
let votedFor = null
let votesReceived = 0
let log = []
let commitIndex = -1
let lastApplied = -1
let electionInProgress = false
let entryQueue = Promise.resolve()

let nextIndex = {}
let matchIndex = {}
let catchupInFlight = {}

let electionTimeout = null
let heartbeatInterval = null

console.log(`[Replica ${PORT}] Starting node (id=${ID})`)
setTimeout(() => {
  resetElectionTimer()
}, 1000)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getLastLogInfo() {
  const lastLogIndex = log.length - 1
  const lastLogTerm = lastLogIndex >= 0 ? log[lastLogIndex].term : -1
  return { lastLogIndex, lastLogTerm }
}

function applyCommittedEntries() {
  while (lastApplied < commitIndex) {
    lastApplied++
    const entry = log[lastApplied]
    if (entry) {
      console.log(`[Replica ${PORT}][Term ${currentTerm}] Applied index ${lastApplied}`)
    }
  }
}

function getCommittedEntries() {
  return log.slice(0, commitIndex + 1);
}

function resetElectionTimer() {
  clearTimeout(electionTimeout)
  const portOffset = Math.max(0, portNumber - 5001) * 2000
  const timeout = 1000 + portOffset + Math.random() * 500

  electionTimeout = setTimeout(async () => {
    if (state === "follower") {
      console.log(`[Replica ${PORT}][Term ${currentTerm}] Election timeout - starting election`)
      await startElection()
    }
  }, timeout)
}

function stepDownToFollower(term, reason) {
  currentTerm = term
  state = "follower"
  votedFor = null
  electionInProgress = false
  clearInterval(heartbeatInterval)
  resetElectionTimer()
}

async function startElection() {
  if (state !== "follower" || electionInProgress) return
  electionInProgress = true
  state = "candidate"
  currentTerm++
  votedFor = ID
  votesReceived = 1

  const { lastLogIndex, lastLogTerm } = getLastLogInfo()
  peers.forEach(peer => {
    axios.post(peer + "/request-vote", {
      term: currentTerm, candidateId: ID, lastLogIndex, lastLogTerm
    }, { timeout: 800 }).then(res => {
      if (res.data && res.data.voteGranted) {
        votesReceived++
        if (state === "candidate" && votesReceived >= 2) becomeLeader()
      }
    }).catch(() => {})
  })
}

function becomeLeader() {
  electionInProgress = false
  state = "leader"
  console.log(`[Replica ${PORT}][Term ${currentTerm}] ★★★ BECAME LEADER ★★★`)
  nextIndex = {}; matchIndex = {};
  peers.forEach(peer => {
    const p = new URL(peer).port
    nextIndex[p] = log.length; matchIndex[p] = -1;
  })
  startHeartbeat()
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  heartbeatInterval = setInterval(async () => {
    if (state !== "leader") return clearInterval(heartbeatInterval)
    peers.forEach(async peer => {
      try {
        const p = new URL(peer).port
        const ni = nextIndex[p] || 0
        const prevIndex = ni - 1
        const prevTerm = prevIndex >= 0 ? log[prevIndex].term : -1
        const res = await axios.post(peer + "/append-entries", {
          term: currentTerm, leaderId: ID, prevLogIndex: prevIndex, prevLogTerm: prevTerm, entries: log.slice(ni), leaderCommit: commitIndex
        }, { timeout: 500 })
        if (res.data && res.data.success) {
          matchIndex[p] = log.length - 1; nextIndex[p] = log.length
          advanceCommitIndex()
        }
      } catch (err) {}
    })
  }, 200)
}

function advanceCommitIndex() {
  for (let n = log.length - 1; n > commitIndex; n--) {
    let replicated = 1
    peers.forEach(peer => { if ((matchIndex[new URL(peer).port] ?? -1) >= n) replicated++ })
    if (replicated >= 2 && log[n].term === currentTerm) {
      commitIndex = n; applyCommittedEntries(); break;
    }
  }
}

app.post("/request-vote", (req, res) => {
  const { term, candidateId, lastLogIndex = -1, lastLogTerm = -1 } = req.body
  if (term < currentTerm) return res.json({ voteGranted: false })
  if (term > currentTerm) stepDownToFollower(term)
  const local = getLastLogInfo()
  const upToDate = lastLogTerm > local.lastLogTerm || (lastLogTerm === local.lastLogTerm && lastLogIndex >= local.lastLogIndex)
  if ((votedFor === null || votedFor === candidateId) && upToDate) {
    votedFor = candidateId; resetElectionTimer(); return res.json({ voteGranted: true })
  }
  res.json({ voteGranted: false })
})

app.post("/append-entries", (req, res) => {
  const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = req.body
  if (term < currentTerm) return res.json({ success: false })
  if (term >= currentTerm) {
    if (term > currentTerm) currentTerm = term
    state = "follower"; votedFor = null; resetElectionTimer()
  }
  if (prevLogIndex >= 0 && (prevLogIndex >= log.length || log[prevLogIndex].term !== prevLogTerm)) {
    return res.json({ success: false })
  }
  if (entries && entries.length > 0) {
    log = log.slice(0, prevLogIndex + 1).concat(entries)
  }
  if (typeof leaderCommit === "number" && leaderCommit > commitIndex) {
    commitIndex = Math.min(leaderCommit, log.length - 1); applyCommittedEntries()
  }
  res.json({ success: true })
})

app.post("/add-entry", async (req, res) => {
  if (state !== "leader") return res.status(400).json({ error: "Not leader" })
  const entry = { term: currentTerm, data: req.body }
  log.push(entry)
  const index = log.length - 1
  const start = Date.now()
  while (Date.now() - start < 5000) {
    advanceCommitIndex()
    if (commitIndex >= index) return res.json({ success: true, entryIndex: index })
    await sleep(200)
  }
  res.status(503).json({ success: false, error: "Commit timeout" })
})

app.get("/committed-log", (req, res) => res.json({ success: true, entries: getCommittedEntries() }))
app.get("/log-state", (req, res) => res.json({ node: PORT, state, term: currentTerm, commitIndex, logLength: log.length }))

app.listen(PORT, () => console.log(`[Replica ${PORT}] Listening`))
