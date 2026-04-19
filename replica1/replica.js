const express = require("express")
const axios = require("axios")

const app = express()
app.use(express.json())

// ===== CONFIG =====
const PORT = process.argv[2] || process.env.PORT || 5001
const ID = `node-${PORT}`

const peerUrls = process.env.PEERS
  ? process.env.PEERS.split(",").map(url => url.trim()).filter(Boolean)
  : [
    "http://127.0.0.1:5001",
    "http://127.0.0.1:5002",
    "http://127.0.0.1:5003"
  ]

const peers = peerUrls.filter(peerUrl => !peerUrl.includes(`:${PORT}`))
const portNumber = Number(PORT) || 0

const HEARTBEAT_INTERVAL_MS = 150
const ELECTION_TIMEOUT_MIN_MS = 500
const ELECTION_TIMEOUT_MAX_MS = 800
const REQUEST_VOTE_TIMEOUT_MS = 600
const APPEND_ENTRIES_TIMEOUT_MS = 600

const knownPorts = [5001, 5002, 5003]
const nodeSlot = Math.max(0, knownPorts.indexOf(portNumber))
const slotWidthMs = Math.floor((ELECTION_TIMEOUT_MAX_MS - ELECTION_TIMEOUT_MIN_MS) / knownPorts.length)

// ===== RAFT STATE =====
let state = "follower"
let currentTerm = 0
let votedFor = null
let votesReceived = 0
let log = []
let commitIndex = -1
let lastApplied = -1
let electionInProgress = false
let entryQueue = Promise.resolve()

// RAFT Leader State
let nextIndex = {}
let matchIndex = {}
let catchupInFlight = {}

let electionTimeout = null
let heartbeatInterval = null

console.log(`[Replica ${PORT}] Starting node`)
setTimeout(() => {
  resetElectionTimer()
}, Math.random() * 1500 + 1000)

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
      console.log(`[Replica ${PORT}][Term ${currentTerm}] Applied committed entry index ${lastApplied}`)
    }
  }
}

function resetElectionTimer() {
  clearTimeout(electionTimeout)
  electionTimeout = null

  // Keep node-specific staggered windows to reduce split-vote lockstep.
  const slotStart = ELECTION_TIMEOUT_MIN_MS + nodeSlot * slotWidthMs
  const slotEnd = Math.min(ELECTION_TIMEOUT_MAX_MS, slotStart + slotWidthMs)
  const timeout = slotStart + Math.random() * Math.max(1, slotEnd - slotStart)
  console.log(`[Replica ${PORT}][Term ${currentTerm}] Election timer set: ${timeout.toFixed(0)}ms`)

  electionTimeout = setTimeout(async () => {
    if (state === "follower" || state === "candidate") {
      console.log(`[Replica ${PORT}][Term ${currentTerm}] ELECTION TIMEOUT - starting election`)
      await startElection()
    }
  }, timeout)
}

function stepDownToFollower(term, reason) {
  const oldTerm = currentTerm
  const wasLeader = state === "leader"
  currentTerm = term
  state = "follower"
  votedFor = null
  electionInProgress = false
  clearInterval(heartbeatInterval)
  clearTimeout(electionTimeout)

  if (reason) {
    console.log(`[Replica ${PORT}][Term ${oldTerm}→${term}] Demoting: ${reason}`)
  }

  resetElectionTimer()
}

async function startElection() {
  if (electionInProgress && state === "candidate") {
    // Already in election, increment term and retry
  }
  
  electionInProgress = true
  state = "candidate"
  currentTerm++
  votedFor = ID
  votesReceived = 1
  clearTimeout(electionTimeout)
  electionTimeout = null

  console.log(`[Replica ${PORT}][Term ${currentTerm}] ★ ELECTION STARTED ★ - voting for self, requesting ${peers.length} votes`)

  const { lastLogIndex, lastLogTerm } = getLastLogInfo()
  let leaderElected = false
  const voteRequests = peers.map(peer =>
    axios.post(peer + "/request-vote", {
      term: currentTerm,
      candidateId: ID,
      lastLogIndex,
      lastLogTerm
    }, { timeout: REQUEST_VOTE_TIMEOUT_MS })
      .then(res => {
        if (state !== "candidate") return false
        if (res.data && res.data.term > currentTerm) {
            stepDownToFollower(res.data.term, "Stale term in RequestVote response")
            return false
        }
        if (res.data && res.data.voteGranted) {
          votesReceived++
          const peerPort = new URL(peer).port
          console.log(`[Replica ${PORT}][Term ${currentTerm}] ✓ VOTE GRANTED by replica ${peerPort} (total: ${votesReceived}/${peers.length + 1})`)

          if (!leaderElected && state === "candidate" && votesReceived >= Math.ceil((peers.length + 1) / 2)) {
            leaderElected = true
            console.log(`[Replica ${PORT}][Term ${currentTerm}] ✦ MAJORITY REACHED ✦ - becoming leader`)
            becomeLeader()
          }
          return true
        }
        return false
      })
      .catch(err => {
        return false
      })
  )

  resetElectionTimer() // Set timer for next term in case this election fails
}

function becomeLeader() {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  if (electionTimeout) clearTimeout(electionTimeout)
  electionTimeout = null

  electionInProgress = false
  state = "leader"
  console.log(`[Replica ${PORT}][Term ${currentTerm}] ★★★ BECAME LEADER ★★★`)

  nextIndex = {}
  matchIndex = {}
  peers.forEach(peer => {
    const peerPort = new URL(peer).port
    nextIndex[peerPort] = log.length
    matchIndex[peerPort] = -1
    catchupInFlight[peerPort] = false
  })

  matchIndex[PORT] = log.length - 1

  startHeartbeat()
}

function advanceCommitIndex() {
  let updated = false
  const majoritySize = Math.ceil((peers.length + 1) / 2)
  
  for (let n = log.length - 1; n > commitIndex; n--) {
    let replicated = 1

    for (const peer of peers) {
      const peerPort = new URL(peer).port
      if ((matchIndex[peerPort] ?? -1) >= n) {
        replicated++
      }
    }

    if (replicated >= majoritySize) {
      if (log[n] && log[n].term === currentTerm) {
        commitIndex = n
        updated = true
        console.log(`[Replica ${PORT}][Term ${currentTerm}] commitIndex updated to ${commitIndex}`)
        applyCommittedEntries()
        break
      }
    }
  }

  return updated
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  const heartbeatDelay = HEARTBEAT_INTERVAL_MS

  console.log(`[Replica ${PORT}][Term ${currentTerm}] Starting heartbeat every ${heartbeatDelay}ms`)

  const sendHeartbeats = async () => {
    if (state !== "leader") {
      clearInterval(heartbeatInterval)
      return
    }

    peers.forEach(async peer => {
      try {
        const peerPort = new URL(peer).port
        const ni = nextIndex[peerPort] ?? log.length
        
        // If there are entries to send, send them. Otherwise send heartbeat.
        const prevLogIndex = ni - 1
        const prevLogTerm = prevLogIndex >= 0 ? log[prevLogIndex].term : -1
        const entriesToSend = log.slice(ni)

        const res = await axios.post(peer + "/append-entries", {
          term: currentTerm,
          leaderId: ID,
          prevLogIndex,
          prevLogTerm,
          entries: entriesToSend,
          leaderCommit: commitIndex
        }, { timeout: APPEND_ENTRIES_TIMEOUT_MS })

        if (res.data && res.data.term > currentTerm) {
            stepDownToFollower(res.data.term, "Stale term in AppendEntries response")
            return
        }

        if (res.data && res.data.success) {
          if (entriesToSend.length > 0) {
            matchIndex[peerPort] = ni + entriesToSend.length - 1
            nextIndex[peerPort] = ni + entriesToSend.length
            advanceCommitIndex()
          }
        } else if (res.data && !res.data.success) {
           // Backtrack nextIndex
           nextIndex[peerPort] = Math.max(0, ni - 1)
        }
      } catch (err) {
      }
    })
  }

  sendHeartbeats()
  heartbeatInterval = setInterval(sendHeartbeats, heartbeatDelay)
}

// ===== APIs =====

app.post("/request-vote", (req, res) => {
  const { term, candidateId, lastLogIndex = -1, lastLogTerm = -1 } = req.body

  if (term < currentTerm) {
    return res.json({ voteGranted: false, term: currentTerm })
  }

  if (term > currentTerm) {
    stepDownToFollower(term, `higher term ${term} in RequestVote`)
  }

  const localLastLog = getLastLogInfo()
  const candidateUpToDate =
    lastLogTerm > localLastLog.lastLogTerm ||
    (lastLogTerm === localLastLog.lastLogTerm && lastLogIndex >= localLastLog.lastLogIndex)

  const canVote = votedFor === null || votedFor === candidateId
  if (canVote && candidateUpToDate) {
    votedFor = candidateId
    console.log(`[Replica ${PORT}][Term ${currentTerm}] ✓ Voted for replica ${candidateId}`)
    resetElectionTimer()
    return res.json({ voteGranted: true, term: currentTerm })
  }

  return res.json({ voteGranted: false, term: currentTerm })
})

app.post("/append-entries", (req, res) => {
  const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = req.body
  const isHeartbeat = !entries || entries.length === 0

  if (term < currentTerm) {
    return res.json({ success: false, term: currentTerm })
  }

  if (term > currentTerm) {
    stepDownToFollower(term, `higher term ${term} in AppendEntries`)
  } else if (term === currentTerm) {
    if (state !== "follower" && leaderId !== ID) {
        clearInterval(heartbeatInterval)
        state = "follower"
        electionInProgress = false
    }
    resetElectionTimer()
  }

  // Log level consistency check
  if (prevLogIndex >= 0) {
      if (prevLogIndex >= log.length || log[prevLogIndex].term !== prevLogTerm) {
          return res.json({ success: false, term: currentTerm })
      }
  }

  if (entries && entries.length > 0) {
    const appendStartIndex = prevLogIndex + 1
    // Remove conflicting entries
    if (log[appendStartIndex] && log[appendStartIndex].term !== entries[0].term) {
        log.splice(appendStartIndex)
    }
    // Append new entries not already in the log
    if (log.length === appendStartIndex) {
        log.push(...entries)
    }
  }

  if (typeof leaderCommit === "number") {
    if (leaderCommit > commitIndex) {
      commitIndex = Math.min(leaderCommit, log.length - 1)
      applyCommittedEntries()
    }
  }

  return res.json({ success: true, term: currentTerm })
})

app.get("/sync-log", (req, res) => {
  const fromIndex = parseInt(req.query.n) || 0
  res.json({ entries: log.slice(fromIndex) })
})

app.post("/add-entry", async (req, res) => {
  if (state !== "leader") {
    return res.status(400).json({ error: "Not leader" })
  }

  const entry = {
    term: currentTerm,
    data: req.body
  }
  
  log.push(entry)
  const index = log.length - 1
  
  // Wait for commitment or timeout
  const startedAt = Date.now()
  while (Date.now() - startedAt < 3000) {
      if (commitIndex >= index) break
      await sleep(100)
  }

  if (commitIndex >= index) {
      res.json({ success: true, index })
  } else {
      res.status(503).json({ error: "Replication timeout", index })
  }
})

app.get("/committed-log", (req, res) => res.json({ entries: log.slice(0, commitIndex + 1) }))
app.get("/log-state", (req, res) => res.json({ 
    id: ID, state, term: currentTerm, commitIndex, logLength: log.length 
}))

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Replica ${PORT}] Listening on 0.0.0.0:${PORT}`)
})
