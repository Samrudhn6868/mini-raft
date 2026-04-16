const { spawn, execFile } = require("child_process")
const path = require("path")
const readline = require("readline")
const axios = require("axios")
const WebSocket = require("ws")

const ROOT = __dirname
const NODE_BIN = process.execPath

const CONFIG = {
  gatewayPort: Number(process.env.GATEWAY_PORT || 3000),
  wsUrl: process.env.WS_URL || "ws://localhost:3000",
  gatewayHttpUrl: process.env.GATEWAY_HTTP_URL || "http://localhost:3000",
  replicaPorts: [5001, 5002, 5003],
  replicaTimeoutMs: Number(process.env.REPLICA_TIMEOUT_MS || 1500),
  startTimeoutMs: Number(process.env.START_TIMEOUT_MS || 30000),
  leaderTimeoutMs: Number(process.env.LEADER_TIMEOUT_MS || 20000),
  failoverTimeoutMs: Number(process.env.FAILOVER_TIMEOUT_MS || 20000),
  syncTimeoutMs: Number(process.env.SYNC_TIMEOUT_MS || 20000),
  stressEvents: Number(process.env.STRESS_EVENTS || 250),
  clientCount: Number(process.env.CLIENT_COUNT || 3),
  roomId: process.env.TEST_ROOM || `test-room-${Date.now()}`,
  cleanupPorts: [3000, 5001, 5002, 5003],
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 250)
}

const childProcesses = new Map()
const clients = []
const testResults = []

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function log(message) {
  console.log(message)
}

function formatError(error) {
  if (!error) return "Unknown error"
  if (error.response) return `HTTP_${error.response.status}`
  if (error.code) return error.code
  if (error.message) return error.message
  return "Unknown error"
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function stableSort(value) {
  if (Array.isArray(value)) {
    return value.map(stableSort)
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableSort(value[key])
        return acc
      }, {})
  }

  return value
}

function stableStringify(value) {
  return JSON.stringify(stableSort(value))
}

function createSeededRandom(seed) {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomInt(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function colorFromSeed(seed) {
  const random = createSeededRandom(seed)
  const red = randomInt(random, 50, 230).toString(16).padStart(2, "0")
  const green = randomInt(random, 50, 230).toString(16).padStart(2, "0")
  const blue = randomInt(random, 50, 230).toString(16).padStart(2, "0")
  return `#${red}${green}${blue}`
}

function buildStroke(seed, sender, index) {
  const random = createSeededRandom(seed)
  const pointCount = randomInt(random, 4, 9)
  const points = []
  let x = randomInt(random, 40, 900)
  let y = randomInt(random, 40, 600)

  for (let i = 0; i < pointCount; i++) {
    x = clamp(x + randomInt(random, -36, 36), 8, 1180)
    y = clamp(y + randomInt(random, -28, 28), 8, 760)
    points.push({ x, y })
  }

  const first = points[0]
  const last = points[points.length - 1]

  return {
    type: "draw",
    room: CONFIG.roomId,
    eventId: `stroke-${Date.now()}-${index}-${seed}`,
    user: sender.user,
    avatar: sender.avatar,
    userId: sender.userId,
    data: {
      x: last.x,
      y: last.y,
      lastX: first.x,
      lastY: first.y,
      size: randomInt(random, 2, 12),
      color: colorFromSeed(seed),
      points
    }
  }
}

function canonicalizeMessage(message) {
  if (!message || typeof message !== "object") return null

  if (!["draw", "clear", "undo", "redo", "ai-draw"].includes(message.type)) {
    return null
  }

  if (message.type === "draw") {
    const data = message.data || {}
    return {
      type: message.type,
      room: message.room || null,
      eventId: message.eventId || null,
      user: message.user || null,
      avatar: message.avatar || null,
      userId: message.userId || null,
      data: {
        x: data.x,
        y: data.y,
        lastX: data.lastX,
        lastY: data.lastY,
        size: data.size,
        color: data.color,
        points: Array.isArray(data.points)
          ? data.points.map(point => ({ x: point.x, y: point.y }))
          : []
      }
    }
  }

  return {
    type: message.type,
    room: message.room || null,
    eventId: message.eventId || null,
    user: message.user || null,
    avatar: message.avatar || null,
    userId: message.userId || null,
    data: message.data ?? null
  }
}

async function requestJson(url, method = "GET", data = undefined, timeout = 2000) {
  try {
    const response = await axios.request({
      url,
      method,
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

async function getPidsOnPort(port) {
  const command = `netstat -ano -p tcp | findstr :${port}`

  return new Promise(resolve => {
    execFile("cmd.exe", ["/c", command], { windowsHide: true }, (error, stdout) => {
      if (error && !stdout) {
        resolve([])
        return
      }

      const pids = new Set()
      stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .forEach(line => {
          const match = line.match(/\s+(\d+)$/)
          if (match) {
            pids.add(Number(match[1]))
          }
        })

      resolve([...pids])
    })
  })
}

async function killPid(pid) {
  return new Promise(resolve => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
      resolve()
    })
  })
}

async function cleanupPorts(ports) {
  const uniquePorts = [...new Set(ports)]

  for (const port of uniquePorts) {
    const pids = await getPidsOnPort(port)
    for (const pid of pids) {
      await killPid(pid)
    }
  }

  await sleep(1000)
}

function attachProcessLogging(label, child) {
  const attach = stream => {
    const reader = readline.createInterface({ input: stream })
    reader.on("line", line => {
      const trimmed = line.trim()
      if (!trimmed) return

      if (
        /Leader|Follower synced|Sync-log|Election|commitIndex|replicated|step|error|Gateway running|Running on port|No leader found|retrying/i.test(trimmed)
      ) {
        log(`[${label}] ${trimmed}`)
      }
    })
  }

  if (child.stdout) attach(child.stdout)
  if (child.stderr) attach(child.stderr)
}

function spawnProcess(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  })

  childProcesses.set(label, child)
  attachProcessLogging(label, child)

  child.on("exit", (code, signal) => {
    log(`[proc] ${label} exited code=${code} signal=${signal || "none"}`)
  })

  return child
}

function startReplica(port) {
  const peers = CONFIG.replicaPorts.map(peerPort => `http://localhost:${peerPort}`).join(",")
  return spawnProcess(
    `replica-${port}`,
    NODE_BIN,
    [path.join(ROOT, "replica.js"), String(port)],
    {
      REPLICA_PEERS: peers
    }
  )
}

function startGateway() {
  const replicaUrls = CONFIG.replicaPorts.map(port => `http://localhost:${port}`).join(",")
  return spawnProcess(
    "gateway",
    NODE_BIN,
    [path.join(ROOT, "gateway.js")],
    {
      PORT: String(CONFIG.gatewayPort),
      REPLICA_URLS: replicaUrls
    }
  )
}

async function waitFor(predicate, timeoutMs, intervalMs = CONFIG.pollIntervalMs) {
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await predicate()
      if (value) {
        return value
      }
    } catch (error) {
      lastError = error
    }

    await sleep(intervalMs)
  }

  if (lastError) {
    throw lastError
  }

  return null
}

async function getReplicaState(port) {
  const response = await requestJson(`http://localhost:${port}/log-state`, "GET", undefined, CONFIG.replicaTimeoutMs)
  if (!response.ok || !response.data) return null
  return { ...response.data, port }
}

async function getAllReplicaStates() {
  const states = await Promise.all(CONFIG.replicaPorts.map(port => getReplicaState(port)))
  return states.filter(Boolean)
}

async function waitForClusterReady() {
  return waitFor(async () => {
    const gateway = await requestJson(`${CONFIG.gatewayHttpUrl}/health`, "GET", undefined, 2000)
    if (!gateway.ok) return null

    const states = await getAllReplicaStates()
    return states.length === CONFIG.replicaPorts.length ? states : null
  }, CONFIG.startTimeoutMs)
}

function summarizeStates(states) {
  return states
    .map(state => `${state.port}:${state.state}:t${state.term}:c${state.commitIndex}:l${state.logLength}`)
    .join(" | ")
}

async function detectLeader(states = null) {
  const snapshot = states || await getAllReplicaStates()
  const leaders = snapshot.filter(state => state.state === "leader")
  if (leaders.length !== 1) return null
  return leaders[0]
}

async function waitForLeader(timeoutMs = CONFIG.leaderTimeoutMs, excludePort = null) {
  return waitFor(async () => {
    const leader = await detectLeader()
    if (!leader) return null
    if (excludePort && leader.port === excludePort) return null
    return leader
  }, timeoutMs)
}

function printReplicaSnapshot(states) {
  log(`[replicas] ${summarizeStates(states)}`)
}

function trackReplicaChanges(previousStates, nextStates) {
  const previousByPort = new Map(previousStates.map(state => [state.port, state]))

  nextStates.forEach(state => {
    const previous = previousByPort.get(state.port)
    if (!previous) {
      log(`[state] replica ${state.port} online as ${state.state} term=${state.term}`)
      return
    }

    if (previous.term !== state.term) {
      log(`[term] replica ${state.port} term ${previous.term} -> ${state.term}`)
    }

    if (previous.state !== state.state) {
      log(`[state] replica ${state.port} ${previous.state} -> ${state.state}`)
    }
  })
}

async function killChildProcess(child) {
  if (!child || child.killed) return

  try {
    child.kill("SIGTERM")
  } catch {}

  const exited = await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000, 100)
  if (!exited) {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
}

async function stopManagedCluster() {
  for (const child of childProcesses.values()) {
    await killChildProcess(child)
  }
  childProcesses.clear()
}

async function restartReplica(port) {
  const label = `replica-${port}`
  const oldChild = childProcesses.get(label)
  if (oldChild) {
    await killChildProcess(oldChild)
    childProcesses.delete(label)
  }

  const child = startReplica(port)
  await waitFor(async () => {
    const state = await getReplicaState(port)
    return state && state.state ? state : null
  }, CONFIG.startTimeoutMs)
  return child
}

function createClient(index) {
  const clientId = `client-${index}-${Date.now()}`
  const profile = {
    user: `User ${index}`,
    avatar: ["🙂", "🚀", "🎨", "🧪", "🛰️"][index % 5],
    userId: clientId
  }
  const ws = new WebSocket(CONFIG.wsUrl)
  const received = []
  const closeEvents = []
  let opened = false
  let openResolve
  let openReject

  const openPromise = new Promise((resolve, reject) => {
    openResolve = resolve
    openReject = reject
  })

  ws.on("open", () => {
    opened = true
    ws.send(JSON.stringify({
      type: "join",
      room: CONFIG.roomId,
      ...profile
    }))
    openResolve()
  })

  ws.on("message", raw => {
    try {
      const message = JSON.parse(raw.toString())
      const canonical = canonicalizeMessage(message)
      if (canonical) {
        received.push(stableStringify(canonical))
      }
    } catch (error) {
      log(`[client ${clientId}] invalid message: ${formatError(error)}`)
    }
  })

  ws.on("close", (code, reason) => {
    closeEvents.push({ code, reason: reason.toString() })
  })

  ws.on("error", error => {
    if (!opened) {
      openReject(error)
      return
    }
    log(`[client ${clientId}] websocket error: ${formatError(error)}`)
  })

  return {
    clientId,
    profile,
    ws,
    received,
    closeEvents,
    openPromise,
    isOpen: () => ws.readyState === WebSocket.OPEN,
    send: payload => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`WebSocket not open for ${clientId}`))
        return
      }

      ws.send(JSON.stringify(payload), error => {
        if (error) reject(error)
        else resolve()
      })
    }),
    close: () => new Promise(resolve => {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        resolve()
        return
      }

      ws.once("close", () => resolve())
      ws.close()
    })
  }
}

async function createClients(count) {
  const created = []
  for (let i = 0; i < count; i++) {
    created.push(createClient(i))
  }

  await Promise.all(created.map(client => client.openPromise))
  await sleep(750)
  return created
}

async function sendStroke(client, stroke) {
  await client.send(stroke)
}

async function waitForClientBroadcastCount(expectedCount, timeoutMs = CONFIG.syncTimeoutMs) {
  return waitFor(async () => {
    return clients.every(client => client.received.length >= expectedCount) ? true : null
  }, timeoutMs)
}

function assertNoClientDisconnects() {
  const disconnects = clients.filter(client => client.closeEvents.length > 0)
  assert(disconnects.length === 0, `Unexpected client disconnects: ${disconnects.map(client => client.clientId).join(", ")}`)
}

function assertClientLogsAligned(expectedLabel) {
  const logs = clients.map(client => client.received)
  const baseline = logs[0] || []

  logs.forEach((logEntries, index) => {
    assert(
      logEntries.length === baseline.length,
      `${expectedLabel}: client ${index} received ${logEntries.length} events, expected ${baseline.length}`
    )

    for (let i = 0; i < baseline.length; i++) {
      assert(
        logEntries[i] === baseline[i],
        `${expectedLabel}: client ${index} diverged at index ${i}`
      )
    }
  })
}

function assertUniqueStrokeIds(expectedLabel) {
  for (const client of clients) {
    const seen = new Set()
    for (const entry of client.received) {
      const parsed = JSON.parse(entry)
      if (!parsed.eventId) continue
      assert(!seen.has(parsed.eventId), `${expectedLabel}: client ${client.clientId} duplicated eventId ${parsed.eventId}`)
      seen.add(parsed.eventId)
    }
  }
}

async function sendBroadcastStrokeBatch(count, concurrency = clients.length) {
  const tasks = []
  for (let i = 0; i < count; i++) {
    const client = clients[i % concurrency]
    const stroke = buildStroke(1000 + i * 17, client.profile, i)

    tasks.push(sendStroke(client, stroke))
  }

  await Promise.all(tasks)
}

async function observeReplicaConvergence(timeoutMs = CONFIG.syncTimeoutMs) {
  return waitFor(async () => {
    const states = await getAllReplicaStates()
    if (states.length < 2) return null

    const leader = await detectLeader(states)
    if (!leader) return null

    // After failover one replica may be intentionally down; enforce strict equality for all reachable nodes.
    const aligned = states.every(state =>
      state.logLength === leader.logLength && state.commitIndex === leader.commitIndex
    )
    return aligned ? { states, leader } : null
  }, timeoutMs)
}

async function waitForReplicaSync(port, timeoutMs = CONFIG.syncTimeoutMs) {
  return waitFor(async () => {
    const states = await getAllReplicaStates()
    const leader = await detectLeader(states)
    if (!leader) return null
    const follower = states.find(state => state.port === port)
    if (!follower) return null
    return follower.logLength === leader.logLength && follower.commitIndex === leader.commitIndex ? { leader, follower } : null
  }, timeoutMs)
}

async function runTest(name, fn) {
  try {
    const result = await fn()
    testResults.push({ name, passed: true, details: result || "" })
    log(`[PASS] ${name}${result ? ` - ${result}` : ""}`)
    return true
  } catch (error) {
    testResults.push({ name, passed: false, details: formatError(error) })
    log(`[FAIL] ${name} - ${formatError(error)}`)
    return false
  }
}

async function testClusterReadiness() {
  const states = await waitForClusterReady()
  printReplicaSnapshot(states)
  assert(states.length === CONFIG.replicaPorts.length, `Expected ${CONFIG.replicaPorts.length} replicas, got ${states.length}`)
  return `gateway and ${states.length} replicas responded`
}

async function testLeaderDetection() {
  const states = await getAllReplicaStates()
  const leader = await detectLeader(states)
  assert(leader, `Leader not detected: ${summarizeStates(states)}`)
  log(`[leader] current leader is ${leader.port} term=${leader.term}`)
  return `leader=${leader.port} term=${leader.term}`
}

async function testInitialDrawingConsistency() {
  const leader = await waitForLeader()
  assert(leader, "No leader detected before initial drawing test")

  const initialCount = 12
  await sendBroadcastStrokeBatch(initialCount)
  await waitForClientBroadcastCount(initialCount)

  assertClientLogsAligned("Initial drawing consistency")
  assertUniqueStrokeIds("Initial drawing consistency")
  assertNoClientDisconnects()

  const replicaConsistency = await observeReplicaConvergence()
  assert(replicaConsistency, "Replicas did not converge after initial drawing")

  return `received ${initialCount} identical strokes on ${clients.length} clients`
}

async function testFailover() {
  const beforeStates = await getAllReplicaStates()
  const leader = await detectLeader(beforeStates)
  assert(leader, `No leader detected before failover: ${summarizeStates(beforeStates)}`)

  const leaderLabel = `replica-${leader.port}`
  const leaderProcess = childProcesses.get(leaderLabel)
  assert(leaderProcess, `Missing child process handle for ${leaderLabel}`)

  log(`[failover] killing leader ${leader.port}`)
  const startedAt = Date.now()
  await killChildProcess(leaderProcess)

  const newLeader = await waitForLeader(CONFIG.failoverTimeoutMs, leader.port)
  const elapsedMs = Date.now() - startedAt

  assert(newLeader, `No new leader elected within ${CONFIG.failoverTimeoutMs}ms`)
  assert(newLeader.port !== leader.port, `Leader did not change after killing ${leader.port}`)

  log(`[failover] new leader ${newLeader.port} elected in ${elapsedMs}ms`)
  const afterStates = await getAllReplicaStates()
  trackReplicaChanges(beforeStates, afterStates)

  return `leader ${leader.port} -> ${newLeader.port} in ${elapsedMs}ms`
}

async function testPostFailoverConsistency() {
  const leader = await waitForLeader()
  assert(leader, "No leader detected after failover")

  const startCount = clients[0].received.length
  const postFailoverCount = 18
  await sendBroadcastStrokeBatch(postFailoverCount)
  await waitForClientBroadcastCount(startCount + postFailoverCount)

  assertClientLogsAligned("Post-failover consistency")
  assertUniqueStrokeIds("Post-failover consistency")
  assertNoClientDisconnects()

  const replicaConsistency = await observeReplicaConvergence()
  assert(replicaConsistency, "Replicas diverged after failover draws")

  return `post-failover strokes accepted by leader ${leader.port}`
}

async function testReplicaRestart() {
  const leader = await waitForLeader()
  assert(leader, "No leader detected before replica restart test")

  const follower = (await getAllReplicaStates()).find(state => state.port !== leader.port)
  assert(follower, "No follower available to restart")

  const followerLabel = `replica-${follower.port}`
  const oldProcess = childProcesses.get(followerLabel)
  assert(oldProcess, `Missing child process for follower ${follower.port}`)

  log(`[restart] restarting follower ${follower.port}`)
  await killChildProcess(oldProcess)
  childProcesses.delete(followerLabel)

  const restartStartedAt = Date.now()
  const restartedChild = startReplica(follower.port)
  childProcesses.set(followerLabel, restartedChild)

  const synced = await waitForReplicaSync(follower.port)
  const elapsedMs = Date.now() - restartStartedAt
  assert(synced, `Follower ${follower.port} did not sync within timeout`)

  log(`[sync] follower ${follower.port} resynced in ${elapsedMs}ms`)
  return `follower ${follower.port} resynced in ${elapsedMs}ms`
}

async function testStress() {
  const leader = await waitForLeader()
  assert(leader, "No leader detected before stress test")

  const beforeCount = clients[0].received.length
  const eventCount = CONFIG.stressEvents
  log(`[stress] sending ${eventCount} concurrent strokes`)

  await sendBroadcastStrokeBatch(eventCount)
  await waitForClientBroadcastCount(beforeCount + eventCount, CONFIG.syncTimeoutMs + 15000)

  assertClientLogsAligned("Stress test")
  assertUniqueStrokeIds("Stress test")
  assertNoClientDisconnects()

  const replicaConsistency = await observeReplicaConvergence(CONFIG.syncTimeoutMs + 15000)
  assert(replicaConsistency, "Replicas diverged under stress")

  return `${eventCount} concurrent strokes accepted and replicated`
}

function printSummary() {
  log("")
  log("=== SUMMARY ===")
  testResults.forEach(result => {
    log(`${result.passed ? "PASS" : "FAIL"} | ${result.name}${result.details ? ` | ${result.details}` : ""}`)
  })

  const passCount = testResults.filter(result => result.passed).length
  const failCount = testResults.length - passCount
  log(`Totals: pass=${passCount} fail=${failCount}`)
}

async function main() {
  log(`WebSocket URL: ${CONFIG.wsUrl}`)
  log(`Gateway URL: ${CONFIG.gatewayHttpUrl}`)
  log(`Room: ${CONFIG.roomId}`)

  await cleanupPorts(CONFIG.cleanupPorts)

  try {
    log("Starting local cluster...")
    for (const port of CONFIG.replicaPorts) {
      startReplica(port)
    }
    startGateway()

    const readyStates = await waitForClusterReady()
    printReplicaSnapshot(readyStates)
    await waitForLeader(CONFIG.leaderTimeoutMs)
    clients.push(...await createClients(CONFIG.clientCount))

    let previousStates = []
    const currentStates = await getAllReplicaStates()
    trackReplicaChanges(previousStates, currentStates)
    previousStates = currentStates

    await runTest("Cluster readiness", testClusterReadiness)
    await runTest("Leader detection", testLeaderDetection)
    await runTest("Initial drawing consistency", testInitialDrawingConsistency)
    await runTest("Failover", async () => {
      const result = await testFailover()
      previousStates = await getAllReplicaStates()
      return result
    })
    await runTest("Post-failover consistency", testPostFailoverConsistency)
    await runTest("Replica restart", testReplicaRestart)
    await runTest("Stress test", testStress)

    const finalStates = await getAllReplicaStates()
    if (finalStates.length) {
      printReplicaSnapshot(finalStates)
    }
    assertClientLogsAligned("Final consistency")
    assertUniqueStrokeIds("Final consistency")
    assertNoClientDisconnects()

    printSummary()

    const anyFailures = testResults.some(result => !result.passed)
    process.exitCode = anyFailures ? 1 : 0
  } catch (error) {
    testResults.push({ name: "Suite fatal error", passed: false, details: formatError(error) })
    log(`[fatal] ${formatError(error)}`)
    printSummary()
    process.exitCode = 1
  } finally {
    for (const client of clients) {
      try {
        await client.close()
      } catch {}
    }

    await stopManagedCluster()
  }
}

main().catch(error => {
  log(`[fatal] ${formatError(error)}`)
  process.exitCode = 1
})