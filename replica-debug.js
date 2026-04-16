const express = require("express")
const axios = require("axios")

const PORT = process.argv[2]
const ID = PORT
const peerUrls = process.env.REPLICA_PEERS?.split(",").map(u => u.trim()).filter(Boolean) || [
  "http://localhost:5001", "http://localhost:5002", "http://localhost:5003"
]
const peers = peerUrls.filter(p => !p.endsWith(`:${PORT}`))

// RAFT State
let state = "follower"
let currentTerm = 0
let votedFor = null
let log = []
let commitIndex = -1

let electionTimeout = null
let electionTimerID = 0
let votesReceived = 0

const app = express()
app.use(express.json())

function timeLog(msg) {
  const t = Date.now() % 10000
  console.log(`[${t.toString().padStart(5)}ms][P${PORT}][Term ${currentTerm}] ${msg}`)
}

function resetElectionTimer() {
  if (electionTimeout) {
    clearTimeout(electionTimeout)
    timeLog(`🔴 CLEARED old timer ID=${electionTimerID}`)
  }
  
  const timeout = Math.random() * 300 + 500
  const timerID = ++electionTimerID
  
  timeLog(`⏱️  SET timer ID=${timerID} for ${timeout.toFixed(0)}ms`)
  
  electionTimeout = setTimeout(() => {
    timeLog(`⏰ FIRED timer ID=${timerID}, current state=${state}`)
    
    if (state === "follower") {
      timeLog(`🔥 ELECTION TIMEOUT! Starting election...`)
      startElection()
    } else {
      timeLog(`⚠️  Timer fired but state is ${state}, not follower. Re-setting timer.`)
      resetElectionTimer()
    }
  }, timeout)
}

async function startElection() {
  if (state !== "follower") {
    timeLog(`❌ Can't start election: not a follower (state=${state})`)
    return
  }

  timeLog(`🎯 ELECTION STARTED! Incrementing term...`)
  state = "candidate"
  currentTerm++
  votedFor = ID
  votesReceived = 1
  
  timeLog(`📢 Sending RequestVote to all peers...`)
  
  const votes = await Promise.all(
    peers.map(peer => 
      axios.post(peer + "/request-vote", {
        term: currentTerm,
        candidateId: ID,
        lastLogIndex: log.length - 1,
        lastLogTerm: log.length > 0 ? log[log.length - 1].term : -1
      }, {timeout: 500})
        .then(() => {
          votesReceived++
          timeLog(`✅ Vote granted! (${votesReceived}/3)`)
          return true
        })
        .catch(err => {
          timeLog(`❌ Vote request failed: ${err.message}`)
          return false
        })
    )
  )
  
  timeLog(`🗳️  Election complete: ${votesReceived} votes out of 3`)
  
  if (votesReceived >= 2 && state === "candidate") {
    timeLog(`👑 WON ELECTION! Becoming leader!`)
    state = "leader"
    timeLog(`🔴 Starting heartbeat...`)
    startHeartbeat()
  } else {
    timeLog(`❌ Lost election (${votesReceived}/3). Back to follower.`)
    state = "follower"
    votedFor = null
    resetElectionTimer()
  }
}

function startHeartbeat() {
  if (state !== "leader") {
    timeLog(`⚠️  Not leader, not starting heartbeat`)
    return
  }
  
  timeLog(`💓 Sending heartbeats to all peers...`)
  
  peers.forEach(peer => {
    axios.post(peer + "/append-entries", {
      term: currentTerm,
      leaderId: ID,
      prevLogIndex: -1,
      prevLogTerm: -1,
      entries: [],
      leaderCommit: commitIndex,
      _heartbeatFrom: PORT
    }, {timeout: 500})
      .then(() => {
        timeLog(`✅ Heartbeat ACK from ${peer}`)
      })
      .catch(err => {
        timeLog(`❌ Heartbeat to ${peer} failed: ${err.message}`)
      })
  })
}

app.post("/request-vote", (req, res) => {
  const { term, candidateId } = req.body
  timeLog(`📥 RequestVote from ${candidateId} (term=${term})`)
  
  if (term > currentTerm) {
    timeLog(`📈 Higher term in RPC! Stepping down.`)
    currentTerm = term
    state = "follower"
    votedFor = null
  }
  
  const voteGranted = term === currentTerm && !votedFor
  if (voteGranted) {
    votedFor = candidateId
    timeLog(`✅ Granting vote to ${candidateId}`)
  } else {
    timeLog(`🚫 Denying vote (term=${term}, votedFor=${votedFor})`)
  }
  
  res.json({ voteGranted, term: currentTerm })
})

app.post("/append-entries", (req, res) => {
  const { term, leaderId, entries, _heartbeatFrom } = req.body
  const isHB = (!entries || entries.length === 0)
  
  if (isHB) {
    timeLog(`💗 Heartbeat from ${_heartbeatFrom || leaderId} (term=${term})`)
  } else {
    timeLog(`📦 AppendEntries from ${leaderId}: ${entries?.length || 0} entries`)
  }
  
  if (term > currentTerm) {
    timeLog(`📈 Higher term in heartbeat! Stepping down.`)
    currentTerm = term
    state = "follower"
    votedFor = null
  } else if (term === currentTerm && state !== "follower") {
    timeLog(`⬇️  Demoting to follower (heartbeat from leader)`)
    state = "follower"
  }
  
  if (isHB) {
    resetElectionTimer()
  }
  
  res.json({ success: true })
})

app.get("/log-state", (req, res) => {
  res.json({
    state,
    currentTerm,
    isLeader: state === "leader",
    port: PORT
  })
})

// Startup
timeLog(`🚀 Node starting...`)
setTimeout(() => {
  timeLog(`⚙️  Initial setup - resetting election timer`)
  resetElectionTimer()
}, Math.random() * 100 + 50)

app.listen(PORT, () => {
  timeLog(`✅ Listening on port ${PORT}`)
})
