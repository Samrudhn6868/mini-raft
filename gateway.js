const express = require("express")
const http = require("http")
const WebSocket = require("ws")
const axios = require("axios") // Added back
const cors = require("cors")
const { spawn } = require("child_process")
const path = require("path")

const app = express()
app.use(express.json())
app.use(cors())

const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

const PORT = process.env.PORT || 4000
const strictRaftMode = String(process.env.RAFT_STRICT || "").toLowerCase() === "true"

const replicaUrls = [
  "http://localhost:5001",
  "http://localhost:5002",
  "http://localhost:5003"
]

// Auto-spawn replicas if running in Master mode (single container)
if (process.env.SKIP_CLUSTER_SPAWN !== "true") {
  console.log("[Gateway] Master Mode: Spawning RAFT cluster nodes...");
  [5001, 5002, 5003].forEach(port => {
    const child = spawn("node", ["replica.js", String(port)], {
      cwd: process.cwd(),
      stdio: "inherit" 
    });
    console.log(`[Gateway] Spawned replica on port ${port} (PID: ${child.pid})`);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const clients = new Set()
const clientMeta = new Map()

function sendToClient(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function broadcastRoom(room, payload) {
  clients.forEach(ws => {
    const meta = clientMeta.get(ws)
    if (meta && meta.room === room) {
      sendToClient(ws, payload)
    }
  })
}

function getUserList(room) {
  const users = []
  clients.forEach(ws => {
    const meta = clientMeta.get(ws)
    if (meta && meta.room === room) {
      users.push({
        user: meta.user, avatar: meta.avatar, userId: meta.userId
      })
    }
  })
  return users
}

function updateRoomState(room) {
  if (!room) return
  const users = getUserList(room)
  broadcastRoom(room, {
    type: "user-list", room, users, count: users.length
  })
}

function broadcastRoomStats() {
  const roomCount = new Map()
  clients.forEach(client => {
    const meta = clientMeta.get(client)
    if (!meta || !meta.room) return
    roomCount.set(meta.room, (roomCount.get(meta.room) || 0) + 1)
  })
  const rooms = Array.from(roomCount.entries()).map(([room, count]) => ({ room, count }))
  clients.forEach(client => {
    sendToClient(client, { type: "room-stats", rooms })
  })
}

async function getLeader() {
  for (let replicaUrl of replicaUrls) {
    try {
      const res = await axios.get(`${replicaUrl}/log-state`, { timeout: 800 })
      if (res.data.state === "leader") return replicaUrl
    } catch (err) {}
  }
  return null
}

app.get("/health", async (req, res) => {
  const leader = await getLeader();
  const replicaStatus = await Promise.all(replicaUrls.map(async url => {
    try {
      const s = await axios.get(`${url}/log-state`, { timeout: 1500 });
      return { url, online: true, ...s.data };
    } catch (e) {
      return { url, online: false, error: e.message };
    }
  }));
  res.json({
    gateway: "online",
    leader: leader || "none",
    replicas: replicaStatus
  });
});

async function sendInitialState(ws, room = null) {
  try {
    let leader = null;
    for (let i = 0; i < 5; i++) {
        leader = await getLeader();
        if (leader) break;
        await sleep(1000);
    }
    if (!leader) return;
    const res = await axios.get(`${leader}/committed-log`);
    const data = res.data;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "INIT_STATE",
        entries: data.entries || []
      }));
    }
  } catch (err) { }
}

async function sendToLeader(data, options = {}) {
  const leaderTimeoutMs = Number(options.leaderTimeoutMs) > 0 ? Number(options.leaderTimeoutMs) : 5000
  const startedAt = Date.now()
  while (Date.now() - startedAt < leaderTimeoutMs) {
    const leader = await getLeader()
    if (!leader) { await sleep(400); continue; }
    try {
      const res = await axios.post(`${leader}/add-entry`, data, { timeout: 1500 })
      return res.data
    } catch (err) { await sleep(400); }
  }
  return { success: false, error: "Leader timeout" }
}

function normalizeDrawMessage(data, meta) {
  return {
    type: "draw",
    eventId: data.eventId || meta.eventId || `evt-${Date.now()}`,
    room: data.room || meta.room,
    user: data.user || meta.user,
    avatar: data.avatar || meta.avatar,
    userId: data.userId || meta.userId,
    data: {
      points: data.points || (data.data && data.data.points),
      color: data.color || (data.data && data.data.color),
      size: data.size || (data.data && data.data.size)
    }
  }
}

wss.on("connection", (ws, req) => {
  clients.add(ws)
  ws.on("message", async (msg) => {
    try {
      const payload = JSON.parse(msg)
      const opType = payload.type
      const meta = clientMeta.get(ws) || {}
      const room = payload.room || meta.room

      if (opType === "join") {
        clientMeta.set(ws, {
          user: payload.user, avatar: payload.avatar, room: payload.room,
          userId: payload.userId || `usr-${Date.now()}`
        })
        updateRoomState(payload.room)
        broadcastRoomStats()
        await sendInitialState(ws, payload.room)
        return
      }

      if (!room) return
      if (opType === "rtc-signal" || opType === "cursor") {
        broadcastRoom(room, payload); return;
      }

      const data = payload
      const baseEvent = {
        eventId: data.eventId || `evt-${Date.now()}`,
        user: data.user || meta.user, avatar: data.avatar || meta.avatar, userId: data.userId || meta.userId
      }
      const drawPayload = normalizeDrawMessage(data, { ...meta, room, ...baseEvent })
      const raftPayload = opType === "draw" ? drawPayload : { type: opType, ...baseEvent, data: data.data }

      const result = await sendToLeader(raftPayload)
      if (result && result.success) {
        if (opType === "draw") broadcastRoom(room, drawPayload)
        else broadcastRoom(room, { type: opType, ...baseEvent, data: data.data })
      }
    } catch (err) { }
  })
  ws.on("close", () => {
    const meta = clientMeta.get(ws)
    clients.delete(ws); clientMeta.delete(ws)
    if (meta && meta.room) updateRoomState(meta.room)
    broadcastRoomStats()
  })
})

app.get("/status", (req, res) => {
  res.json({ status: "ok", clients: clients.size })
})

server.listen(PORT, () => {
  console.log(`[Gateway] RAFT Mono-Cluster listening on port ${PORT}`)
})