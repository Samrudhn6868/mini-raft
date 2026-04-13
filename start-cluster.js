const { spawn, exec } = require("child_process")
const { promisify } = require("util")
const axios = require("axios")
const path = require("path")

const execAsync = promisify(exec)
const ROOT = __dirname
const PORTS = [5001, 5002, 5003]
const NODE_TIMEOUT_MS = 800
const CHECK_RETRIES = 5
const CHECK_DELAY_MS = 700
const STARTUP_DELAY_MS = 2500
const RUN_TESTS = !process.argv.includes("--no-tests")

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatError(error) {
  if (!error) return "Unknown error"
  if (error.code) return error.code
  if (error.response) return `HTTP_${error.response.status}`
  if (error.message) return error.message
  return "Unknown error"
}

async function killOldProcesses() {
  try {
    await execAsync("pkill -f \"node replica.js\"")
  } catch (error) {
    if (error.code !== 1) {
      console.log(`pkill warning: ${formatError(error)}`)
    }
  }

  for (const port of PORTS) {
    try {
      const { stdout } = await execAsync(`lsof -ti tcp:${port}`)
      const pids = stdout.trim().split(/\s+/).filter(Boolean)
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGKILL")
        } catch {
          // Ignore processes that exited between lsof and kill.
        }
      }
    } catch {
      // lsof may not be available or no process may be bound; ignore.
    }
  }
}

function startNode(port) {
  const child = spawn("node", [path.join(ROOT, "replica.js"), String(port)], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore"
  })

  child.unref()
  return child
}

async function getState(port) {
  const url = `http://localhost:${port}/log-state`

  for (let attempt = 1; attempt <= CHECK_RETRIES; attempt++) {
    try {
      const response = await axios.get(url, { timeout: NODE_TIMEOUT_MS })
      return {
        ok: true,
        port,
        state: response.data && response.data.state,
        data: response.data
      }
    } catch (error) {
      if (attempt < CHECK_RETRIES) {
        await sleep(CHECK_DELAY_MS)
      } else {
        return {
          ok: false,
          port,
          reason: formatError(error)
        }
      }
    }
  }

  return { ok: false, port, reason: "Unknown error" }
}

async function waitForClusterReady() {
  for (let attempt = 1; attempt <= CHECK_RETRIES; attempt++) {
    const results = []
    for (const port of PORTS) {
      results.push(await getState(port))
    }

    if (results.every(result => result.ok)) {
      return results
    }

    if (attempt < CHECK_RETRIES) {
      await sleep(CHECK_DELAY_MS)
    }
  }

  const finalResults = []
  for (const port of PORTS) {
    finalResults.push(await getState(port))
  }
  return finalResults
}

function printNodeStatus(result) {
  if (result.ok) {
    console.log(`Node ${result.port} reachable - ${result.state || "unknown"}`)
  } else {
    console.log(`Node ${result.port} unreachable - ${result.reason}`)
  }
}

async function runTestsIfRequested() {
  if (!RUN_TESTS) return

  console.log("\nRunning tests...\n")

  await new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "test-suite.js")], {
      cwd: ROOT,
      stdio: "inherit"
    })

    child.on("exit", code => {
      if (code === 0) resolve()
      else reject(new Error(`test-suite.js exited with code ${code}`))
    })

    child.on("error", reject)
  }).catch(error => {
    console.error(`Test run failed: ${error.message}`)
  })
}

async function main() {
  console.log("Starting cluster...")
  console.log("Killing old processes...")
  await killOldProcesses()

  console.log("Starting nodes...")
  const children = PORTS.map(startNode)

  await sleep(STARTUP_DELAY_MS)
  const results = await waitForClusterReady()

  console.log("")
  results.forEach(printNodeStatus)

  const reachable = results.filter(result => result.ok)
  const leaders = reachable.filter(result => result.state === "leader")

  if (leaders.length === 1) {
    console.log(`\nLeader is: ${leaders[0].port}`)
  } else if (leaders.length === 0) {
    console.log("\nLeader is: not found")
  } else {
    console.log(`\nLeader is ambiguous: ${leaders.map(result => result.port).join(", ")}`)
  }

  if (reachable.length === 0) {
    console.log("\nCluster is NOT running. Start replica.js on all ports.")
  } else if (reachable.length === PORTS.length) {
    await runTestsIfRequested()
  }
}

main().catch(error => {
  console.error(`Unexpected failure: ${error.message}`)
  process.exitCode = 1
})
