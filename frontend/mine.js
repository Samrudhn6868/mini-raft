const axios = require("axios")

const NODE_URLS = [5001, 5002, 5003].map(port => `http://localhost:${port}`)
const REQUEST_TIMEOUT = 900
const POLL_INTERVAL = 200
const DEFAULT_WAIT = 5000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeNode(input) {
  if (!input) return null
  if (typeof input === "number") return `http://localhost:${input}`
  if (typeof input === "string" && /^\d+$/.test(input)) return `http://localhost:${input}`
  if (typeof input === "string" && input.startsWith("http://")) return input
  if (typeof input === "string" && input.startsWith("https://")) return input
  return `http://localhost:${input}`
}

function nodeLabel(state) {
  return `${state.node}:${state.state}:t${state.term}:c${state.commitIndex}:l${state.logLength}`
}

function summarizeStates(states) {
  return states.map(nodeLabel).join(" | ")
}

async function requestJson(method, url, data, timeout = REQUEST_TIMEOUT) {
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
      error: error.message
    }
  }
}

async function getState(portOrUrl) {
  const url = `${normalizeNode(portOrUrl)}/log-state`
  const response = await requestJson("get", url)
  if (!response.ok || !response.data) return null
  return { ...response.data, __url: normalizeNode(portOrUrl) }
}

async function getAllStates() {
  const states = await Promise.all(NODE_URLS.map(node => getState(node)))
  return states.filter(Boolean)
}

async function detectLeader(states = null) {
  const snapshot = states || await getAllStates()
  const leaders = snapshot.filter(state => state.state === "leader")
  if (leaders.length !== 1) return null
  return leaders[0]
}

async function getLeaderUrl() {
  const leader = await detectLeader()
  if (!leader) return null
  return leader.__url || normalizeNode(leader.node)
}

async function addEntry(portOrUrl, data) {
  const url = `${normalizeNode(portOrUrl)}/add-entry`
  return requestJson("post", url, data)
}

async function appendEntries(portOrUrl, payload) {
  const url = `${normalizeNode(portOrUrl)}/append-entries`
  return requestJson("post", url, payload)
}

async function sendHeartbeat(portOrUrl, term) {
  const url = `${normalizeNode(portOrUrl)}/heartbeat`
  return requestJson("post", url, { term })
}

async function waitFor(predicate, { timeoutMs = DEFAULT_WAIT, intervalMs = POLL_INTERVAL, label = "condition" } = {}) {
  const startedAt = Date.now()
  let lastValue = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = await predicate()
      if (lastValue) return lastValue
    } catch (error) {
      lastValue = error
    }
    await sleep(intervalMs)
  }

  throw new Error(`Timed out waiting for ${label}`)
}

function printResult(name, passed, details = "") {
  const status = passed ? "PASS" : "FAIL"
  console.log(`[${status}] ${name}`)
  if (!passed && details) {
    console.log(`  ${details}`)
  }
}

function entrySuffixMatches(state, expectedEntries) {
  if (!state.log || state.log.length < expectedEntries.length) return false
  const suffix = state.log.slice(-expectedEntries.length)
  return suffix.every((entry, index) => {
    const expected = expectedEntries[index]
    return JSON.stringify(entry.data) === JSON.stringify(expected)
  })
}

async function waitForClusterConsensus(expectedEntries, { timeoutMs = DEFAULT_WAIT } = {}) {
  return waitFor(async () => {
    const states = await getAllStates()
    if (states.length !== NODE_URLS.length) return null

    const baselineLength = states[0].logLength
    const sameLength = states.every(state => state.logLength === baselineLength)
    const sameCommit = states.every(state => state.commitIndex === states[0].commitIndex)
    const sameSuffix = states.every(state => entrySuffixMatches(state, expectedEntries))

    if (sameLength && sameCommit && sameSuffix) {
      return states
    }

    return null
  }, { timeoutMs, label: "cluster consensus" })
}

async function waitForLeaderChange(previousLeaderNode, { timeoutMs = DEFAULT_WAIT } = {}) {
  return waitFor(async () => {
    const states = await getAllStates()
    const leaders = states.filter(state => state.state === "leader")
    if (leaders.length !== 1) return null
    const leader = leaders[0]
    if (leader.node === previousLeaderNode) return null
    return leader
  }, { timeoutMs, label: "new leader" })
}

async function waitForClusterReady({ timeoutMs = 10000 } = {}) {
  return waitFor(async () => {
    const states = await getAllStates()
    return states.length === NODE_URLS.length ? states : null
  }, { timeoutMs, label: "cluster readiness" })
}

async function withHeartbeatSuppression(nodeUrl, term, action, intervalMs = 250) {
  const timer = setInterval(() => {
    sendHeartbeat(nodeUrl, term).catch(() => {})
  }, intervalMs)

  try {
    return await action()
  } finally {
    clearInterval(timer)
  }
}

async function testLeaderDetection() {
  const states = await getAllStates()
  if (states.length !== NODE_URLS.length) {
    printResult("Leader Election", false, `Expected ${NODE_URLS.length} nodes, got ${states.length}: ${summarizeStates(states)}`)
    return false
  }

  const leaders = states.filter(state => state.state === "leader")
  if (leaders.length === 1) {
    printResult("Leader Election", true, `Leader ${leaders[0].node} term ${leaders[0].term}`)
    return true
  }

  printResult("Leader Election", false, `Expected exactly 1 leader, found ${leaders.length}: ${summarizeStates(states)}`)
  return false
}

async function testBasicReplication() {
  const leaderUrl = await getLeaderUrl()
  if (!leaderUrl) {
    printResult("Replication", false, "No leader available")
    return false
  }

  const payload = {
    test: "basic-replication",
    runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    value: "single-entry"
  }

  const result = await addEntry(leaderUrl, payload)
  if (!result.ok) {
    printResult("Replication", false, `Add entry failed: ${JSON.stringify(result.data || result.error)}`)
    return false
  }

  try {
    const states = await waitForClusterConsensus([payload], { timeoutMs: 6000 })
    printResult("Replication", true, `All nodes aligned at log length ${states[0].logLength}, commitIndex ${states[0].commitIndex}`)
    return true
  } catch (error) {
    const states = await getAllStates()
    printResult("Replication", false, `${error.message}. Current: ${summarizeStates(states)}`)
    return false
  }
}

async function testMultiEntryOrder() {
  const leaderUrl = await getLeaderUrl()
  if (!leaderUrl) {
    printResult("Multi-Entry Order", false, "No leader available")
    return false
  }

  const entries = [
    { test: "multi-order", runId: `${Date.now()}-A`, value: "A" },
    { test: "multi-order", runId: `${Date.now()}-B`, value: "B" },
    { test: "multi-order", runId: `${Date.now()}-C`, value: "C" }
  ]

  for (const entry of entries) {
    const response = await addEntry(leaderUrl, entry)
    if (!response.ok) {
      printResult("Multi-Entry Order", false, `Failed while adding ${entry.value}: ${JSON.stringify(response.data || response.error)}`)
      return false
    }
  }

  try {
    const states = await waitFor(async () => {
      const currentStates = await getAllStates()
      if (currentStates.length !== NODE_URLS.length) return null
      const suffixOk = currentStates.every(state => entrySuffixMatches(state, entries))
      const sameLength = currentStates.every(state => state.logLength === currentStates[0].logLength)
      return suffixOk && sameLength ? currentStates : null
    }, { timeoutMs: 6000, label: "ordered replication" })

    printResult("Multi-Entry Order", true, `Preserved A -> B -> C on all nodes at length ${states[0].logLength}`)
    return true
  } catch (error) {
    const states = await getAllStates()
    printResult("Multi-Entry Order", false, `${error.message}. Current: ${summarizeStates(states)}`)
    return false
  }
}

async function testFailover() {
  const leader = await detectLeader()
  if (!leader) {
    printResult("Leader Failover", false, "No leader available")
    return false
  }

  const targetTerm = leader.term + 1
  try {
    const newLeader = await withHeartbeatSuppression(leader.__url || normalizeNode(leader.node), targetTerm, async () => {
      return waitForLeaderChange(leader.node, { timeoutMs: 7000 })
    })

    printResult("Leader Failover", true, `Leader moved from ${leader.node} to ${newLeader.node} at term ${newLeader.term}`)
    return true
  } catch (error) {
    const states = await getAllStates()
    printResult("Leader Failover", false, `${error.message}. Current: ${summarizeStates(states)}`)
    return false
  }
}

async function testInvalidAppendEntries() {
  const leader = await detectLeader()
  if (!leader) {
    printResult("Consistency Check", false, "No leader available")
    return false
  }

  const invalidPayload = {
    term: leader.term,
    leaderId: leader.node,
    prevLogIndex: 999999,
    prevLogTerm: -1,
    entries: []
  }

  const response = await appendEntries(leader.__url || normalizeNode(leader.node), invalidPayload)
  const rejected = response.ok && response.data && response.data.success === false

  if (rejected) {
    printResult("Consistency Check", true, `Leader rejected invalid prevLogIndex ${invalidPayload.prevLogIndex}`)
    return true
  }

  printResult("Consistency Check", false, `Expected { success: false }, got ${JSON.stringify(response.data || response.error)}`)
  return false
}

async function testLogRepair() {
  const leader = await detectLeader()
  if (!leader) {
    printResult("Log Repair", false, "No leader available")
    return false
  }

  const states = await getAllStates()
  const followers = states.filter(state => state.state !== "leader")
  if (followers.length < 2) {
    printResult("Log Repair", false, `Need two followers to simulate lag, got ${followers.length}`)
    return false
  }

  const laggingFollower = followers[0]
  const leaderUrl = leader.__url || normalizeNode(leader.node)
  const followerUrl = laggingFollower.__url || normalizeNode(laggingFollower.node)
  const lagTerm = leader.term + 1
  const repairPayload = {
    test: "log-repair",
    runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    value: "catch-up"
  }

  let addResult = null
  let repairStates = null

  await withHeartbeatSuppression(followerUrl, lagTerm, async () => {
    addResult = await Promise.race([
      addEntry(leaderUrl, repairPayload),
      sleep(2500).then(() => ({ timeout: true }))
    ])

    const afterLagStates = await getAllStates()
    const leaderAfterLag = afterLagStates.find(state => state.node === leader.node)
    const followerAfterLag = afterLagStates.find(state => state.node === laggingFollower.node)

    if (!leaderAfterLag || !followerAfterLag) {
      throw new Error("Lost node state while checking lag simulation")
    }

    const lagObserved = followerAfterLag.logLength < leaderAfterLag.logLength || followerAfterLag.commitIndex < leaderAfterLag.commitIndex
    if (!lagObserved) {
      throw new Error(`Follower did not lag: leader=${leaderAfterLag.logLength}/${leaderAfterLag.commitIndex}, follower=${followerAfterLag.logLength}/${followerAfterLag.commitIndex}`)
    }

    await sendHeartbeat(leaderUrl, lagTerm + 1)

    repairStates = await waitFor(async () => {
      const currentStates = await getAllStates()
      if (currentStates.length !== NODE_URLS.length) return null
      const currentLeader = currentStates.find(state => state.state === "leader")
      if (!currentLeader) return null
      const laggingState = currentStates.find(state => state.node === laggingFollower.node)
      if (!laggingState) return null
      const leaderState = currentStates.find(state => state.node === currentLeader.node)
      if (!leaderState) return null
      const repaired = laggingState.logLength === leaderState.logLength && entrySuffixMatches(laggingState, [repairPayload])
      return repaired ? currentStates : null
    }, { timeoutMs: 8000, label: "log repair" })
  })

  if (repairStates) {
    printResult("Log Repair", true, `Lagging node ${laggingFollower.node} caught up; log length ${repairStates[0].logLength}`)
    return true
  }

  const currentStates = await getAllStates()
  printResult("Log Repair", false, `${addResult && addResult.timeout ? "Timed out waiting for add-entry completion" : "Log repair failed"}. Current: ${summarizeStates(currentStates)}`)
  return false
}

async function testDebugStateValidation() {
  const leader = await detectLeader()
  if (!leader) {
    printResult("Debug State Validation", false, "No leader available")
    return false
  }

  const leaderState = await getState(leader.__url || normalizeNode(leader.node))
  if (!leaderState) {
    printResult("Debug State Validation", false, "Leader state unavailable")
    return false
  }

  const hasNextIndex = Object.prototype.hasOwnProperty.call(leaderState, "nextIndex")
  const hasMatchIndex = Object.prototype.hasOwnProperty.call(leaderState, "matchIndex")
  const validObjects = hasNextIndex && hasMatchIndex && leaderState.nextIndex && leaderState.matchIndex && typeof leaderState.nextIndex === "object" && typeof leaderState.matchIndex === "object"

  if (validObjects) {
    printResult("Debug State Validation", true, `Leader exposes nextIndex and matchIndex for ports ${Object.keys(leaderState.nextIndex).join(",")}`)
    return true
  }

  printResult("Debug State Validation", false, `Missing leader debug fields: nextIndex=${hasNextIndex}, matchIndex=${hasMatchIndex}`)
  return false
}

async function testCommitRule() {
  const leader = await detectLeader()
  if (!leader) {
    printResult("Commit Rule Check", false, "No leader available")
    return false
  }

  const states = await getAllStates()
  const followers = states.filter(state => state.state !== "leader")
  if (followers.length < 2) {
    printResult("Commit Rule Check", false, "Need two followers to validate majority commit")
    return false
  }

  const followerTerms = followers.map(state => state.term + 1)
  const blockOne = followers[0]
  const blockTwo = followers[1]
  const beforeLeaderState = leader.__url ? await getState(leader.__url) : await getState(leader.node)
  const beforeCommit = beforeLeaderState ? beforeLeaderState.commitIndex : leader.commitIndex

  const partitionPayload = {
    test: "partition-safety",
    runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    value: "no-majority"
  }

  let addResult = null
  await withHeartbeatSuppression(blockOne.__url || normalizeNode(blockOne.node), followerTerms[0], async () => {
    await withHeartbeatSuppression(blockTwo.__url || normalizeNode(blockTwo.node), followerTerms[1], async () => {
      addResult = await Promise.race([
        addEntry(leader.__url || normalizeNode(leader.node), partitionPayload),
        sleep(2500).then(() => ({ timeout: true }))
      ])
    })
  })

  await sleep(500)
  const afterStates = await getAllStates()
  const afterLeader = afterStates.find(state => state.node === leader.node) || await getState(leader.__url || normalizeNode(leader.node))
  const commitAdvanced = afterLeader && afterLeader.commitIndex > beforeCommit

  if (!commitAdvanced && (!addResult || addResult.timeout || !addResult.ok)) {
    printResult("Partition Safety", true, `Leader commitIndex stayed at ${beforeCommit}; followers were blocked from majority`)
    return true
  }

  printResult("Partition Safety", false, `commitIndex advanced to ${afterLeader ? afterLeader.commitIndex : "unknown"}; state: ${summarizeStates(afterStates)}`)
  return false
}

async function runTest(name, fn) {
  try {
    return await fn()
  } catch (error) {
    printResult(name, false, error.message)
    return false
  }
}

async function runAllTests() {
  console.log("RAFT Validation Tool")
  console.log(`Targets: ${NODE_URLS.join(", ")}`)
  console.log("")

  let initialStates = []
  try {
    initialStates = await waitForClusterReady({ timeoutMs: 10000 })
  } catch (error) {
    initialStates = await getAllStates()
    console.log(`System unavailable: expected ${NODE_URLS.length} nodes, got ${initialStates.length}`)
    process.exitCode = 1
    return
  }

  const results = []
  results.push(await runTest("Leader Election", testLeaderDetection))
  results.push(await runTest("Replication", testBasicReplication))
  results.push(await runTest("Multi-Entry Order", testMultiEntryOrder))
  results.push(await runTest("Leader Failover", testFailover))
  results.push(await runTest("Consistency Check", testInvalidAppendEntries))
  results.push(await runTest("Log Repair", testLogRepair))
  results.push(await runTest("Debug State Validation", testDebugStateValidation))
  results.push(await runTest("Partition Safety", testCommitRule))

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
  console.error("Unhandled test runner failure:", error)
  process.exitCode = 1
})
