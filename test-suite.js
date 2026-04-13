const axios = require("axios")

const NODES = [5001, 5002, 5003]
const BASE_URL = "http://localhost"
const TIMEOUT_MS = 800
const RETRIES = 3
const RETRY_DELAY_MS = 500
const CLUSTER_WAIT_MS = 10000
const POLL_INTERVAL_MS = 250

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function nodeUrl(port) {
  return `${BASE_URL}:${port}`
}

function formatError(error) {
  if (!error) return "Unknown error"
  if (error.code) return error.code
  if (error.response) return `HTTP_${error.response.status}`
  if (error.message) return error.message
  return "Unknown error"
}

function printResult(name, passed, details = "") {
  const status = passed ? "PASS" : "FAIL"
  console.log(`[${status}] ${name}`)
  if (!passed && details) {
    console.log(`  ${details}`)
  }
}

function summarizeStates(states) {
  return states.map(state => `${state.node}:${state.state}:t${state.term}:c${state.commitIndex}:l${state.logLength}`).join(" | ")
}

async function request(method, url, data = undefined, timeout = TIMEOUT_MS) {
  try {
    const response = await axios.request({
      method,
      url,
      data,
      timeout,
      validateStatus: () => true
    })

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      data: response.data
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: formatError(error)
    }
  }
}

async function getState(port) {
  const response = await request("get", `${nodeUrl(port)}/log-state`)
  if (!response.ok || !response.data) return null
  return { ...response.data, __port: port }
}

async function getAllStates() {
  const states = await Promise.all(NODES.map(port => getState(port)))
  return states.filter(Boolean)
}

async function waitForCluster() {
  const startedAt = Date.now()

  while (Date.now() - startedAt < CLUSTER_WAIT_MS) {
    const states = await getAllStates()
    if (states.length === NODES.length) return states
    await sleep(POLL_INTERVAL_MS)
  }

  return await getAllStates()
}

async function detectLeader(states = null) {
  const snapshot = states || await getAllStates()
  const leaders = snapshot.filter(state => state.state === "leader")
  if (leaders.length !== 1) return null
  return leaders[0]
}

async function waitForLeader(timeoutMs = 8000) {
  return waitFor(async () => detectLeader(), timeoutMs)
}

async function addEntry(port, data) {
  return request("post", `${nodeUrl(port)}/add-entry`, data)
}

async function appendEntries(port, payload) {
  return request("post", `${nodeUrl(port)}/append-entries`, payload)
}

async function sendHeartbeat(port, term) {
  return request("post", `${nodeUrl(port)}/heartbeat`, { term })
}

async function waitFor(predicate, timeoutMs, intervalMs = POLL_INTERVAL_MS) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

function entryMatches(entry, expected) {
  if (!entry || !entry.data) return false
  return Object.entries(expected).every(([key, value]) => entry.data[key] === value)
}

function suffixMatches(state, expectedEntries) {
  if (!state.log || state.log.length < expectedEntries.length) return false
  const suffix = state.log.slice(-expectedEntries.length)
  return suffix.every((entry, index) => entryMatches(entry, expectedEntries[index]))
}

async function testClusterReadiness() {
  const states = await waitForCluster()
  const ready = states.length === NODES.length

  if (ready) {
    printResult("Cluster Readiness", true, `All ${NODES.length} nodes responded`)
  } else {
    printResult("Cluster Readiness", false, `Expected ${NODES.length} nodes, got ${states.length}: ${summarizeStates(states)}`)
  }

  return ready
}

async function testLeaderElection() {
  const states = await getAllStates()
  const leaders = states.filter(state => state.state === "leader")

  if (leaders.length === 1) {
    printResult("Leader Election", true, `Leader is ${leaders[0].node}`)
    return true
  }

  printResult("Leader Election", false, `Expected exactly 1 leader, found ${leaders.length}: ${summarizeStates(states)}`)
  return false
}

async function testBasicReplication() {
  const leader = await waitForLeader()
  if (!leader) {
    printResult("Basic Replication", false, "No leader detected")
    return false
  }

  const payload = {
    test: "basic-replication",
    runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    value: "single-entry"
  }

  const response = await addEntry(leader.__port, payload)
  if (!response.ok) {
    printResult("Basic Replication", false, `add-entry failed: ${response.data ? JSON.stringify(response.data) : response.error}`)
    return false
  }

  const states = await waitFor(async () => {
    const snapshot = await getAllStates()
    if (snapshot.length !== NODES.length) return null
    const sameLength = snapshot.every(state => state.logLength === snapshot[0].logLength)
    const sameLast = snapshot.every(state => entryMatches(state.log[state.log.length - 1], payload))
    return sameLength && sameLast ? snapshot : null
  }, 7000)

  if (states) {
    printResult("Basic Replication", true, `Log length ${states[0].logLength}`)
    return true
  }

  const snapshot = await getAllStates()
  printResult("Basic Replication", false, `Logs did not converge: ${summarizeStates(snapshot)}`)
  return false
}

async function testMultiEntryOrder() {
  const leader = await waitForLeader()
  if (!leader) {
    printResult("Multi-Entry Order", false, "No leader detected")
    return false
  }

  const entries = [
    { test: "multi-order", value: "A" },
    { test: "multi-order", value: "B" },
    { test: "multi-order", value: "C" }
  ]

  for (const entry of entries) {
    const response = await addEntry(leader.__port, { ...entry, runId: `${Date.now()}-${Math.random().toString(16).slice(2)}` })
    if (!response.ok) {
      printResult("Multi-Entry Order", false, `add-entry failed for ${entry.value}`)
      return false
    }
    await sleep(200)
  }

  const states = await waitFor(async () => {
    const snapshot = await getAllStates()
    if (snapshot.length !== NODES.length) return null
    const ordered = snapshot.every(state => suffixMatches(state, entries))
    return ordered ? snapshot : null
  }, 8000)

  if (states) {
    printResult("Multi-Entry Order", true, "A -> B -> C preserved on all nodes")
    return true
  }

  const snapshot = await getAllStates()
  printResult("Multi-Entry Order", false, `Order mismatch: ${summarizeStates(snapshot)}`)
  return false
}

async function testFailover() {
  const leader = await waitForLeader()
  if (!leader) {
    printResult("Failover", false, "No leader detected")
    return false
  }

  const higherTerm = leader.term + 1
  const newLeader = await withHeartbeatPressure(leader.__port, higherTerm, async () => {
    return waitFor(async () => {
      const snapshot = await getAllStates()
      const leaders = snapshot.filter(state => state.state === "leader")
      if (leaders.length !== 1) return null
      return leaders[0].node !== leader.node ? leaders[0] : null
    }, 10000)
  })

  if (newLeader) {
    printResult("Failover", true, `Leader changed from ${leader.node} to ${newLeader.node}`)
    return true
  }

  await sleep(5000)
  const recovered = await detectLeader()
  if (recovered && recovered.node !== leader.node) {
    printResult("Failover", true, `Leader changed from ${leader.node} to ${recovered.node}`)
    return true
  }

  const snapshot = await getAllStates()
  printResult("Failover", false, `No new leader elected: ${summarizeStates(snapshot)}`)
  return false
}

async function testInvalidAppend() {
  const leader = await waitForLeader()
  if (!leader) {
    printResult("Invalid Append", false, "No leader detected")
    return false
  }

  const response = await appendEntries(leader.__port, {
    term: leader.term,
    leaderId: leader.node,
    prevLogIndex: 999999,
    prevLogTerm: -1,
    entries: []
  })

  if (response.ok && response.data && response.data.success === false) {
    printResult("Invalid Append", true, "AppendEntries rejected as expected")
    return true
  }

  printResult("Invalid Append", false, `Unexpected response: ${response.data ? JSON.stringify(response.data) : response.error}`)
  return false
}

async function testLogRepair() {
  const leader = await waitForLeader()
  if (!leader) {
    printResult("Log Repair", false, "No leader detected")
    return false
  }

  const followers = (await getAllStates()).filter(state => state.node !== leader.node)
  if (followers.length < 1) {
    printResult("Log Repair", false, "No follower available")
    return false
  }

  const laggingFollower = followers[0]
  const leaderUrl = leader.__port
  const followerUrl = laggingFollower.__port
  const payloads = [
    { test: "log-repair", value: "X" },
    { test: "log-repair", value: "Y" }
  ]

  const lagTerm = leader.term + 1
  await withHeartbeatPressure(followerUrl, lagTerm, async () => {
    for (const payload of payloads) {
      await addEntry(leaderUrl, { ...payload, runId: `${Date.now()}-${Math.random().toString(16).slice(2)}` })
      await sleep(250)
    }
  })

  const repaired = await waitFor(async () => {
    const snapshot = await getAllStates()
    const leaderState = snapshot.find(state => state.node === leader.node)
    const followerState = snapshot.find(state => state.node === laggingFollower.node)
    if (!leaderState || !followerState) return null
    return leaderState.logLength === followerState.logLength ? snapshot : null
  }, 8000)

  if (repaired) {
    printResult("Log Repair", true, `Follower ${laggingFollower.node} caught up`)
    return true
  }

  const snapshot = await getAllStates()
  printResult("Log Repair", false, `Follower did not catch up: ${summarizeStates(snapshot)}`)
  return false
}

async function testCommitRule() {
  const leader = await waitForLeader()
  if (!leader) {
    printResult("Commit Rule Check", false, "No leader detected")
    return false
  }

  const before = await getAllStates()
  const commitBefore = before.map(state => state.commitIndex)

  const payload = {
    test: "commit-rule",
    runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    value: "majority"
  }

  const response = await addEntry(leader.__port, payload)
  if (!response.ok) {
    printResult("Commit Rule Check", false, "add-entry failed")
    return false
  }

  const after = await waitFor(async () => {
    const snapshot = await getAllStates()
    const commitIndices = snapshot.map(state => state.commitIndex)
    const sameAcrossAll = commitIndices.every(index => index === commitIndices[0])
    const increased = commitIndices[0] > commitBefore[0]
    return sameAcrossAll && increased ? snapshot : null
  }, 7000)

  if (after) {
    printResult("Commit Rule Check", true, `commitIndex advanced to ${after[0].commitIndex}`)
    return true
  }

  const snapshot = await getAllStates()
  printResult("Commit Rule Check", false, `commitIndex mismatch: ${summarizeStates(snapshot)}`)
  return false
}

async function testPartitionSafety() {
  const leader = await waitForLeader()
  if (!leader) {
    printResult("Partition Safety", false, "No leader detected")
    return false
  }

  const snapshot = await getAllStates()
  const followers = snapshot.filter(state => state.node !== leader.node)
  if (followers.length < 2) {
    printResult("Partition Safety", false, "Need two followers to simulate missing majority")
    return false
  }

  const beforeLeader = await getState(leader.__port)
  const beforeCommit = beforeLeader ? beforeLeader.commitIndex : leader.commitIndex

  const blockedTerm = leader.term + 1
  const payload = {
    test: "partition-safety",
    runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    value: "isolated"
  }

  let duringCommit = beforeCommit

  await withHeartbeatPressure(followers[0].__port, blockedTerm, async () => {
    await withHeartbeatPressure(followers[1].__port, blockedTerm, async () => {
      await addEntry(leader.__port, payload)
      await sleep(500)
      const leaderDuringBlock = await getState(leader.__port)
      duringCommit = leaderDuringBlock ? leaderDuringBlock.commitIndex : duringCommit
    })
  })

  if (duringCommit === beforeCommit) {
    printResult("Partition Safety", true, "Commit did not advance without majority")
    return true
  }

  const after = await getAllStates()
  printResult("Partition Safety", false, `commitIndex changed unexpectedly: ${summarizeStates(after)}`)
  return false
}

async function testDebugStateValidation() {
  const leader = await waitForLeader()
  if (!leader) {
    printResult("Debug State Validation", false, "No leader detected")
    return false
  }

  const state = await getState(leader.__port)
  if (!state) {
    printResult("Debug State Validation", false, "Could not fetch leader state")
    return false
  }

  const hasNextIndex = Object.prototype.hasOwnProperty.call(state, "nextIndex")
  const hasMatchIndex = Object.prototype.hasOwnProperty.call(state, "matchIndex")
  const validObjects = hasNextIndex && hasMatchIndex && typeof state.nextIndex === "object" && typeof state.matchIndex === "object"

  if (validObjects) {
    printResult("Debug State Validation", true, `Leader ${state.node} exposes nextIndex and matchIndex`)
    return true
  }

  printResult("Debug State Validation", false, `Missing fields: nextIndex=${hasNextIndex}, matchIndex=${hasMatchIndex}`)
  return false
}

async function withHeartbeatPressure(port, term, action, intervalMs = 250) {
  await sendHeartbeat(port, term).catch(() => {})

  const timer = setInterval(() => {
    sendHeartbeat(port, term).catch(() => {})
  }, intervalMs)

  try {
    return await action()
  } finally {
    clearInterval(timer)
  }
}

async function runAllTests() {
  const results = []

  const readiness = await testClusterReadiness()
  results.push(readiness)
  results.push(await testLeaderElection())
  results.push(await testBasicReplication())
  results.push(await testMultiEntryOrder())
  results.push(await testFailover())
  await sleep(5000)
  results.push(await testInvalidAppend())
  results.push(await testLogRepair())
  results.push(await testCommitRule())
  results.push(await testPartitionSafety())
  results.push(await testDebugStateValidation())

  console.log("")
  const failed = results.filter(result => !result).length
  if (failed === 0) {
    console.log("ALL TESTS PASSED ✅")
  } else {
    console.log(`FAILED TESTS: ${failed} ❌`) 
  }

  process.exitCode = failed === 0 ? 0 : 1
}

runAllTests().catch(error => {
  console.error(`Unhandled test suite failure: ${error.message}`)
  process.exitCode = 1
})
