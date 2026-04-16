const express = require("express")
const axios = require("axios")

const app = express()
app.use(express.json())

// ===== CONFIG =====
const PORT = String(process.argv[2] || process.env.PORT || "5001")
const ID = String(process.env.REPLICA_ID || PORT)

const peersEnv = process.env.REPLICA_PEERS || process.env.PEERS
const peerUrls = peersEnv
  ? peersEnv.split(",").map(url => url.trim()).filter(Boolean)
  : [
    "http://localhost:5001",
    "http://localhost:5002",
    "http://localhost:5003"
  ]

const peers = peerUrls.filter(peerUrl => !peerUrl.endsWith(`:${PORT}`))
const portNumber = Number(PORT) || 0

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

console.log(`[Replica ${PORT}] Starting node (id=${ID})`)
setTimeout(() => {
  resetElectionTimer()
}, Math.random() * 15 + 10)

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

  const portOffset = Math.max(0, portNumber - 5001) * 1500
  const timeout = 250 + portOffset + Math.random() * 100
  console.log(`[Replica ${PORT}][Term ${currentTerm}] Election timer set: ${timeout.toFixed(0)}ms`)

  electionTimeout = setTimeout(async () => {
    if (state === "follower") {
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
  if (state !== "follower") {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] Cannot start election - not a follower (state=${state})`)
    return
  }
  if (electionInProgress) {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] Election already in progress`)
    return
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
    }, { timeout: 1000 })
      .then(res => {
        if (res.data && res.data.voteGranted) {
          votesReceived++
          const peerPort = new URL(peer).port
          console.log(`[Replica ${PORT}][Term ${currentTerm}] ✓ VOTE GRANTED by replica ${peerPort} (total: ${votesReceived}/3)`)

          if (!leaderElected && state === "candidate" && votesReceived >= 2) {
            leaderElected = true
            console.log(`[Replica ${PORT}][Term ${currentTerm}] ✦ MAJORITY REACHED EARLY ✦ - becoming leader immediately`)
            becomeLeader()
          }

          return true
        }
        return false
      })
      .catch(err => {
        const peerPort = new URL(peer).port
        console.log(`[Replica ${PORT}][Term ${currentTerm}] ✗ Vote request to replica ${peerPort} failed`)
        return false
      })
  )

  await Promise.all(voteRequests)

  if (state !== "candidate") {
    if (state !== "leader") {
      console.log(`[Replica ${PORT}][Term ${currentTerm}] State changed during election - aborting`)
    }
    return
  }

  if (votesReceived >= 2) {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] ✦ LEADER ELECTED ✦ - won with ${votesReceived}/3 votes`)
    becomeLeader()
  } else {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] ✗ Election FAILED - only ${votesReceived}/3 votes, retrying...`)
    electionInProgress = false
    state = "follower"
    votedFor = null
    resetElectionTimer()
  }
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
  peers.forEach(peer => scheduleCatchup(peer))
}

function advanceCommitIndex() {
  let updated = false
  for (let n = log.length - 1; n > commitIndex; n--) {
    let replicated = 1

    for (const peer of peers) {
      const peerPort = new URL(peer).port
      if ((matchIndex[peerPort] ?? -1) >= n) {
        replicated++
      }
    }

    if (replicated >= 2) {
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
  const heartbeatDelay = 50

  console.log(`[Replica ${PORT}][Term ${currentTerm}] Starting heartbeat every ${heartbeatDelay}ms`)

  const sendHeartbeats = async () => {
    if (state !== "leader") {
      console.log(`[Replica ${PORT}][Term ${currentTerm}] Stopping heartbeats - no longer leader`)
      clearInterval(heartbeatInterval)
      return
    }

    const heartbeatPromises = peers.map(async peer => {
      try {
        const peerPort = new URL(peer).port
        const ni = Math.max(0, nextIndex[peerPort] ?? log.length)
        const prevLogIndex = ni - 1
        const prevLogTerm = prevLogIndex >= 0 ? log[prevLogIndex].term : -1

        const res = await axios.post(peer + "/append-entries", {
          term: currentTerm,
          leaderId: ID,
          prevLogIndex,
          prevLogTerm,
          entries: [],
          leaderCommit: commitIndex
        }, { timeout: 500 })

        if (res.data && res.data.success) {
          matchIndex[peerPort] = Math.max(matchIndex[peerPort] ?? -1, prevLogIndex)
          nextIndex[peerPort] = Math.max(nextIndex[peerPort] ?? 0, prevLogIndex + 1)
        } else if (res.data && res.data.needSync) {
          scheduleCatchup(peer)
        }
      } catch (err) {
      }
    })

    await Promise.all(heartbeatPromises)
  }

  sendHeartbeats()
  heartbeatInterval = setInterval(sendHeartbeats, heartbeatDelay)
}

function scheduleCatchup(peer) {
  const peerPort = new URL(peer).port
  if (catchupInFlight[peerPort]) return

  catchupInFlight[peerPort] = true
  replicateToPeer(peer, log.length - 1)
    .catch(() => false)
    .finally(() => {
      catchupInFlight[peerPort] = false
    })
}

async function triggerSyncLog(peer, fromIndex) {
  const peerPort = new URL(peer).port
  const safeFromIndex = Math.max(0, Math.min(fromIndex ?? 0, log.length))

  console.log(`[Replica ${PORT}][Term ${currentTerm}] Syncing replica ${peerPort} from index ${safeFromIndex}`)

  try {
    const res = await axios.post(peer + "/sync-log", {
      fromIndex: safeFromIndex,
      entries: log.slice(safeFromIndex),
      commitIndex
    }, { timeout: 5000 })

    if (res.data && res.data.success) {
      nextIndex[peerPort] = log.length
      matchIndex[peerPort] = log.length - 1
      console.log(`[Replica ${PORT}][Term ${currentTerm}] Sync complete for replica ${peerPort}`)
      advanceCommitIndex()
      return true
    }
  } catch (e) {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] Sync failed for replica ${peerPort}`)
  }

  return false
}

async function replicateEntry(entry) {
  log.push(entry)
  const entryIndex = log.length - 1
  console.log(`[Replica ${PORT}][Term ${currentTerm}] Entry appended (index ${entryIndex})`)

  matchIndex[PORT] = entryIndex

  const replicationTasks = peers.map(peer => replicateToPeer(peer, entryIndex).catch(() => false))

  const committed = await waitForCommit(entryIndex, 5000)
  if (!committed) {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] Replication timeout - majority not reached`)
  } else {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] Entry committed (index ${entryIndex})`)
  }

  await Promise.allSettled(replicationTasks)
  return { committed, entryIndex }
}

async function waitForCommit(entryIndex, timeoutMs) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (state !== "leader") return false
    advanceCommitIndex()
    if (commitIndex >= entryIndex) {
      return true
    }
    await sleep(100)
  }

  return commitIndex >= entryIndex
}

async function replicateToPeer(peer, entryIndex) {
  const peerPort = new URL(peer).port

  while (state === "leader") {
    const ni = Math.max(0, nextIndex[peerPort] ?? log.length)
    const prevLogIndex = ni - 1
    const prevLogTerm = prevLogIndex >= 0 ? log[prevLogIndex].term : -1
    const entriesToSend = log.slice(ni)

    try {
      const res = await axios.post(peer + "/append-entries", {
        term: currentTerm,
        leaderId: ID,
        prevLogIndex,
        prevLogTerm,
        entries: entriesToSend,
        leaderCommit: commitIndex
      }, { timeout: 2000 })

      if (res.data && res.data.success) {
        const replicatedLastIndex = ni + entriesToSend.length - 1
        matchIndex[peerPort] = replicatedLastIndex
        nextIndex[peerPort] = ni + entriesToSend.length

        console.log(`[Replica ${PORT}][Term ${currentTerm}] Ack from follower ${peerPort} (matchIndex=${matchIndex[peerPort]})`)
        advanceCommitIndex()

        if (matchIndex[peerPort] >= entryIndex) {
          return true
        }
        continue
      }

      if (res.data && res.data.needSync) {
        await triggerSyncLog(peer, res.data.currentIndex)
        if ((matchIndex[peerPort] ?? -1) >= entryIndex) {
          return true
        }
        continue
      }

      nextIndex[peerPort] = Math.max(0, ni - 1)
      console.log(`[Replica ${PORT}][Term ${currentTerm}] Backtracking nextIndex for replica ${peerPort}`)
      continue
    } catch (e) {
      console.log(`[Replica ${PORT}][Term ${currentTerm}] RPC to replica ${peerPort} failed`)
      return false
    }
  }

  return false
}

// ===== APIs =====

app.post("/request-vote", (req, res) => {
  const { term, candidateId, lastLogIndex = -1, lastLogTerm = -1 } = req.body

  if (term < currentTerm) {
    return res.json({ voteGranted: false })
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
    return res.json({ voteGranted: true })
  }

  console.log(`[Replica ${PORT}][Term ${currentTerm}] ✗ Denied vote to replica ${candidateId}`)
  return res.json({ voteGranted: false })
})

app.post("/append-entries", (req, res) => {
  const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = req.body
  const isHeartbeat = !entries || entries.length === 0

  if (term < currentTerm) {
    return res.json({ success: false })
  }

  if (term > currentTerm) {
    stepDownToFollower(term, `higher term ${term} in AppendEntries`)
  } else if (term === currentTerm) {
    if (state === "leader" && leaderId !== ID) {
      console.log(`[Replica ${PORT}][Term ${currentTerm}] Ignoring conflicting same-term AppendEntries from leader ${leaderId}`)
      return res.json({ success: true })
    }

    if (state !== "follower") {
      console.log(`[Replica ${PORT}][Term ${currentTerm}] Demoting from ${state} to follower`)
      state = "follower"
      electionInProgress = false
      clearInterval(heartbeatInterval)
    }
    resetElectionTimer()
  }

  if (isHeartbeat) {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] ♥ Heartbeat from leader ${leaderId}`)
  }

  if (prevLogIndex >= 0 && prevLogIndex >= log.length) {
    return res.json({ success: false, needSync: true, currentIndex: log.length })
  }

  if (prevLogIndex >= 0 && log[prevLogIndex].term !== prevLogTerm) {
    return res.json({ success: false, needSync: true, currentIndex: log.length })
  }

  if (entries && entries.length > 0) {
    const appendStartIndex = prevLogIndex + 1
    if (appendStartIndex <= commitIndex && appendStartIndex < log.length) {
      return res.json({ success: false, needSync: true, currentIndex: commitIndex + 1 })
    }

    if (appendStartIndex < log.length) {
      log.splice(appendStartIndex)
    }
    log.push(...entries)
    console.log(`[Replica ${PORT}][Term ${currentTerm}] Appended ${entries.length} entries (log size: ${log.length})`)
  }

  if (typeof leaderCommit === "number") {
    const followerCommit = Math.min(leaderCommit, log.length - 1)
    if (followerCommit > commitIndex) {
      commitIndex = followerCommit
      console.log(`[Replica ${PORT}][Term ${currentTerm}] commitIndex updated to ${commitIndex}`)
      applyCommittedEntries()
    }
  }

  return res.json({ success: true })
})

app.post("/sync-log", (req, res) => {
  const { fromIndex = 0, entries, commitIndex: leaderCommit } = req.body
  const safeFromIndex = Math.max(0, Math.min(fromIndex, log.length))

  if (Array.isArray(entries)) {
    log = log.slice(0, safeFromIndex).concat(entries)

    if (typeof leaderCommit === "number") {
      commitIndex = Math.min(leaderCommit, log.length - 1)
      applyCommittedEntries()
    }

    console.log(`[Replica ${PORT}][Term ${currentTerm}] Synced from index ${safeFromIndex} (log size: ${log.length})`)
    return res.json({ success: true, logLength: log.length, commitIndex })
  }

  return res.json({
    entries: log.slice(safeFromIndex),
    commitIndex
  })
})

app.post("/add-entry", async (req, res) => {
  if (state !== "leader") {
    return res.status(400).json({ error: "Not leader" })
  }

  const requestBody = req.body
  const resultPromise = entryQueue.then(async () => {
    if (state !== "leader") {
      return { success: false, error: "Not leader" }
    }

    const entry = {
      term: currentTerm,
      data: requestBody
    }

    const { committed, entryIndex } = await replicateEntry(entry)
    if (!committed) {
      return { success: false, error: "Entry not committed", entryIndex }
    }

    return { success: true, entry, entryIndex, commitIndex }
  })

  entryQueue = resultPromise.catch(() => undefined)
  const result = await resultPromise

  if (!result.success) {
    return res.status(503).json(result)
  }

  return res.json(result)
})

app.get("/log-state", (req, res) => {
  const debugInfo = {
    node: PORT,
    state,
    term: currentTerm,
    votedFor,
    commitIndex,
    logLength: log.length,
    log
  }

  if (state === "leader") {
    debugInfo.nextIndex = nextIndex
    debugInfo.matchIndex = matchIndex
  }

  res.json(debugInfo)
})

app.get("/committed-log", (req, res) => {
  const safeCommitIndex = Math.min(commitIndex, log.length - 1)
  const entries = safeCommitIndex >= 0 ? log.slice(0, safeCommitIndex + 1) : []

  console.log(`[Replica ${PORT}][Term ${currentTerm}] Serving committed log up to index ${safeCommitIndex}`)
  return res.json({
    success: true,
    entries
  })
})

app.listen(PORT, () => {
  console.log(`[Replica ${PORT}] HTTP server listening on port ${PORT}`)
})
