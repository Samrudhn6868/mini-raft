const express = require("express")
const axios = require("axios")

const app = express()
app.use(express.json())

// ===== CONFIG =====
const PORT = process.argv[2]
const ID = PORT

const peerUrls = process.env.REPLICA_PEERS
  ? process.env.REPLICA_PEERS.split(",").map(url => url.trim()).filter(Boolean)
  : [
    "http://localhost:5001",
    "http://localhost:5002",
    "http://localhost:5003"
  ]

const peers = peerUrls.filter(peerUrl => !peerUrl.endsWith(`:${PORT}`))

// ===== RAFT STATE =====
let state = "follower"
let currentTerm = 0
let votedFor = null
let votesReceived = 0
let log = []
let commitIndex = -1
let electionInProgress = false

// RAFT Leader State
let nextIndex = {}
let matchIndex = {}
let catchupInFlight = {}

let electionTimeout = null
let heartbeatInterval = null

console.log(`Node ${PORT} started`)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getLastLogInfo() {
  const lastLogIndex = log.length - 1
  const lastLogTerm = lastLogIndex >= 0 ? log[lastLogIndex].term : -1
  return { lastLogIndex, lastLogTerm }
}

function resetElectionTimer() {
  clearTimeout(electionTimeout)

  const timeout = Math.random() * 300 + 500
  console.log(`[Replica ${PORT}][Term ${currentTerm}] Election timer reset: ${timeout.toFixed(0)}ms`)

  electionTimeout = setTimeout(() => {
    if (state === "follower") startElection()
  }, timeout)
}

function stepDownToFollower(term, reason) {
  const wasLeader = state === "leader"
  const oldTerm = currentTerm
  currentTerm = term
  state = "follower"
  votedFor = null
  electionInProgress = false
  clearInterval(heartbeatInterval)
  clearTimeout(electionTimeout)

  if (reason) {
    console.log(`[Replica ${PORT}][Term ${oldTerm}→${term}] Stepped down: ${reason}`)
  }

  resetElectionTimer()
}

async function startElection() {
  if (state !== "follower") return
  if (electionInProgress) return

  electionInProgress = true
  state = "candidate"
  currentTerm++
  votedFor = ID
  votesReceived = 1

  console.log(`[Replica ${PORT}][Term ${currentTerm}] ELECTION STARTED - requesting votes from ${peers.length} peers`)

  const { lastLogIndex, lastLogTerm } = getLastLogInfo()
  const voteRequests = peers.map(peer =>
    axios.post(peer + "/request-vote", {
      term: currentTerm,
      candidateId: ID,
      lastLogIndex,
      lastLogTerm
    }, { timeout: 500 })
      .then(res => {
        if (res.data && res.data.voteGranted) {
          votesReceived++
          console.log(`[Replica ${PORT}][Term ${currentTerm}] VOTE GRANTED from ${new URL(peer).port} (votes: ${votesReceived})`)
        }
        return res.data && res.data.voteGranted
      })
      .catch(e => {
        console.log(`[Replica ${PORT}][Term ${currentTerm}] Vote request to ${new URL(peer).port} failed`)
        return false
      })
  )

  await Promise.all(voteRequests)

  if (state === "candidate" && votesReceived >= 2) {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] LEADER ELECTED - collected ${votesReceived} votes`)
    becomeLeader()
  } else if (state === "candidate") {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] Election failed - only ${votesReceived} votes`)
    electionInProgress = false
    state = "follower"
    resetElectionTimer()
  }
}

function becomeLeader() {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  if (electionTimeout) clearTimeout(electionTimeout)

  electionInProgress = false
  state = "leader"
  console.log(`[Replica ${PORT}][Term ${currentTerm}] ★ BECAME LEADER ★`)

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

  nextIndex = {}
  matchIndex = {}
  peers.forEach(peer => {
    const peerPort = new URL(peer).port
    nextIndex[peerPort] = log.length
    matchIndex[peerPort] = -1
    catchupInFlight[peerPort] = false
  })

  // Leader always has all local entries.
  matchIndex[PORT] = log.length - 1

  startHeartbeat()
}

function advanceCommitIndex() {
  for (let n = log.length - 1; n > commitIndex; n--) {
    let replicated = 1 // leader itself

    for (const peer of peers) {
      const peerPort = new URL(peer).port
      if ((matchIndex[peerPort] ?? -1) >= n) {
        replicated++
      }
    }

    if (replicated >= 2) {
      if (log[n] && log[n].term === currentTerm) {
        commitIndex = n
        console.log(`Commit index advanced to ${commitIndex}`)
        break
      }
      console.log("Skipping commit due to term mismatch")
    } else {
      console.log("Majority not reached, skipping commit")
    }
  }
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  const heartbeatDelay = 150
  console.log(`[Replica ${PORT}][Term ${currentTerm}] Starting heartbeat broadcast (${heartbeatDelay}ms interval)`)

  const sendHeartbeats = () => {
    if (state !== "leader") return


    peers.forEach(async peer => {
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
        })

        if (res.data && res.data.success) {
          matchIndex[peerPort] = Math.max(matchIndex[peerPort] ?? -1, prevLogIndex)
          nextIndex[peerPort] = Math.max(nextIndex[peerPort] ?? 0, prevLogIndex + 1)

          // Heartbeat succeeded but follower is still behind: drive catch-up in background.
          if ((nextIndex[peerPort] ?? 0) < log.length) {
            scheduleCatchup(peer)
          }
        } else if (res.data && res.data.needSync) {
          await triggerSyncLog(peer, res.data.currentIndex)
        } else {
          nextIndex[peerPort] = Math.max(0, ni - 1)
          console.log(`Backtracking nextIndex for peer ${peerPort} to ${nextIndex[peerPort]}`)
          console.log(`Retrying AppendEntries to peer ${peerPort}`)
          scheduleCatchup(peer)
        }
      } catch (e) {}
    })
  }, heartbeatDelay)
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

  console.log(`Triggering sync-log for follower ${peerPort}`)

  try {
    const res = await axios.post(peer + "/sync-log", {
      fromIndex: safeFromIndex,
      entries: log.slice(safeFromIndex),
      commitIndex
    })

    if (res.data && res.data.success) {
      nextIndex[peerPort] = log.length
      matchIndex[peerPort] = log.length - 1
      console.log(`Sync-log completed for follower ${peerPort}`)
      advanceCommitIndex()
      return true
    }
  } catch (e) {
    console.log(`Sync-log failed for follower ${peerPort}: ${e.message}`)
  }

  return false
}

async function replicateEntry(entry) {
  log.push(entry)
  console.log(`Node ${PORT} appended entry to log`)

  const entryIndex = log.length - 1
  matchIndex[PORT] = entryIndex

  const replicationTasks = peers.map(peer => replicateToPeer(peer, entryIndex).catch(() => false))

  // Wait a bounded time for majority-driven commit while background replication keeps running.
  const committed = await waitForCommit(entryIndex, 3000)
  if (!committed) {
    console.log("Majority not reached, skipping commit")
  }

  await Promise.allSettled(replicationTasks)
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
      })

      if (res.data && res.data.success) {
        const replicatedLastIndex = ni + entriesToSend.length - 1
        matchIndex[peerPort] = replicatedLastIndex
        nextIndex[peerPort] = ni + entriesToSend.length

        console.log(`Replication success from ${peerPort}, matchIndex=${matchIndex[peerPort]}`)
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
      console.log(`Backtracking nextIndex for peer ${peerPort} to ${nextIndex[peerPort]}`)
      console.log(`Retrying AppendEntries to peer ${peerPort}`)
    } catch (e) {
      console.log(`Network error to ${peerPort}: ${e.message}`)
      console.log(`Retrying AppendEntries to peer ${peerPort}`)
      await sleep(150)
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
    console.log(`[Replica ${PORT}][Term ${currentTerm}] ✓ VOTE GRANTED to replica ${candidateId}`)
    resetElectionTimer()
    return res.json({ voteGranted: true })
  }

  if (!canVote) {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] ✗ VOTE DENIED to replica ${candidateId} (already voted for ${votedFor})`)
  } else if (!candidateUpToDate) {
    console.log(`[Replica ${PORT}][Term ${currentTerm}] ✗ VOTE DENIED to replica ${candidateId} (log not up-to-date)`)
  }
  return res.json({ voteGranted: false })
})

app.post("/heartbeat", (req, res) => {
  const { term } = req.body

  if (term >= currentTerm) {
    console.log(`Election cancelled by heartbeat on node ${PORT}`)
    stepDownToFollower(term, `heartbeat term ${term}`)
  }

  res.sendStatus(200)
})

app.post("/append-entries", (req, res) => {
  const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = req.body

  if (term < currentTerm) {
    console.log(`AppendEntries rejected: term ${term} < currentTerm ${currentTerm}`)
    return res.json({ success: false })
  }

  if (term > currentTerm) {
    stepDownToFollower(term, `new term ${term} in append-entries`)
  } else {
    stepDownToFollower(term, `append-entries from leader ${leaderId}`)
  }

  if (prevLogIndex >= 0 && prevLogIndex >= log.length) {
    console.log(`Follower requesting sync from index ${log.length}`)
    console.log(`AppendEntries rejected: prevLogIndex ${prevLogIndex} >= log.length ${log.length}`)
    return res.json({ success: false, needSync: true, currentIndex: log.length })
  }

  if (prevLogIndex >= 0 && log[prevLogIndex].term !== prevLogTerm) {
    console.log(`Follower requesting sync from index ${log.length}`)
    console.log(`AppendEntries rejected: term mismatch at prevLogIndex ${prevLogIndex}`)
    console.log(`  Expected term ${prevLogTerm}, got ${log[prevLogIndex].term}`)
    log.splice(prevLogIndex + 1)
    return res.json({ success: false, needSync: true, currentIndex: log.length })
  }

  if (entries && entries.length > 0) {
    const appendStartIndex = prevLogIndex + 1
    if (appendStartIndex < log.length) {
      log.splice(appendStartIndex)
    }
    log.push(...entries)
    console.log(`Node ${PORT} appended ${entries.length} entries, log length now ${log.length}`)
  }

  if (typeof leaderCommit === "number") {
    const followerCommit = Math.min(leaderCommit, log.length - 1)
    if (followerCommit > commitIndex) {
      commitIndex = followerCommit
      console.log(`Follower ${PORT} advanced commitIndex to ${commitIndex}`)
    }
  }

  return res.json({ success: true })
})

app.post("/sync-log", (req, res) => {
  const { fromIndex = 0, entries, commitIndex: leaderCommit } = req.body
  const safeFromIndex = Math.max(0, Math.min(fromIndex, log.length))

  // Assignment compatibility: follower can either serve or apply sync.
  if (Array.isArray(entries)) {
    log = log.slice(0, safeFromIndex).concat(entries)

    if (typeof leaderCommit === "number") {
      commitIndex = Math.min(leaderCommit, log.length - 1)
    }

    console.log(`Follower synced from index ${safeFromIndex}`)
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

  const entry = {
    term: currentTerm,
    data: req.body
  }

  await replicateEntry(entry)

  return res.json({ success: true, entry, commitIndex })
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

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`)
  setTimeout(() => {
    resetElectionTimer()
\n  sendHeartbeats()
  heartbeatInterval = setInterval(sendHeartbeats, heartbeatDelay)
}
})
