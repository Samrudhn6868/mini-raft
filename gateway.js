const express = require("express")
const http = require("http")
const WebSocket = require("ws")
const axios = require("axios")
const cors = require("cors")
const { spawn } = require("child_process")
const path = require("path")

const app = express()
app.use(express.json())
app.use(cors())

const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

// CONFIG: Allow environment variables to override for Docker-Compose compatibility
const PORT = process.env.PORT || 4000
const replicaUrls = (process.env.REPLICA_URLS 
  ? process.env.REPLICA_URLS.split(",") 
  : ["http://127.0.0.1:5001", "http://127.0.0.1:5002", "http://127.0.0.1:5003"])

// Mono-Cluster Fallback: If not running in Docker-Compose, spawn replicas locally
if (process.env.IS_DOCKER_COMPOSE !== "true" && process.env.SKIP_CLUSTER_SPAWN !== "true") {
  console.log("[Gateway] Local Mode: Spawning internal RAFT cluster...");
  [5001, 5002, 5003].forEach(port => {
    const cp = spawn("node", ["replica.js", String(port)], { 
      cwd: process.cwd(), 
      stdio: "inherit",
      env: { ...process.env, PORT: undefined } // Ensure inheriting process does NOT override the port if handled by arg
    });
    cp.on("error", (err) => console.error(`[Gateway] Failed to spawn replica on ${port}:`, err));
    cp.on("close", (code) => console.log(`[Gateway] Replica on ${port} exited with code ${code}`));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const clients = new Set()
const clientMeta = new Map()

async function getLeader() {
  for (let url of replicaUrls) {
    try {
      const res = await axios.get(`${url}/log-state`, { timeout: 800 })
      if (res.data.state === "leader") return url
    } catch (err) {}
  }
  return null
}

app.get("/health", async (req, res) => {
  const leader = await getLeader();
  const replicas = await Promise.all(replicaUrls.map(async url => {
    try {
      const s = await axios.get(`${url}/log-state`, { timeout: 1500 });
      return { url, online: true, ...s.data };
    } catch (e) { return { url, online: false, error: e.message }; }
  }));
  res.json({ gateway: "online", leader: leader || "none", replicas });
});

async function sendInitialState(ws, room) {
  try {
    let leader = await getLeader();
    if (!leader) return;
    const res = await axios.get(`${leader}/committed-log`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "INIT_STATE", entries: res.data.entries || [] }));
    }
  } catch (err) {}
}

async function sendToLeader(data) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    const leader = await getLeader()
    if (!leader) { await sleep(400); continue; }
    try {
      const res = await axios.post(`${leader}/add-entry`, data, { timeout: 2000 })
      return res.data
    } catch (err) { await sleep(400); }
  }
  return { success: false, error: "Leader timeout" }
}

wss.on("connection", (ws) => {
  clients.add(ws)
  ws.on("message", async (msg) => {
    try {
      const payload = JSON.parse(msg)
      const meta = clientMeta.get(ws) || {}
      const room = payload.room || meta.room

      if (payload.type === "join") {
        clientMeta.set(ws, { ...payload, userId: payload.userId || `usr-${Date.now()}` })
        await sendInitialState(ws, payload.room); return
      }
      if (!room) return
      if (payload.type === "rtc-signal" || payload.type === "cursor") {
        clients.forEach(c => { if (clientMeta.get(c)?.room === room && c !== ws) c.send(msg); }); return;
      }

      const result = await sendToLeader(payload)
      if (result?.success) {
        clients.forEach(c => { if (clientMeta.get(c)?.room === room) c.send(msg); });
      }
    } catch (err) {}
  })
  ws.on("close", () => { clients.delete(ws); clientMeta.delete(ws); })
})

server.listen(PORT, () => console.log(`[Gateway] Listening on ${PORT}`))