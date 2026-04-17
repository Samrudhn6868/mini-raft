const express = require("express")
const http = require("http")
const WebSocket = require("ws")
const axios = require("axios")
const cors = require("cors")

const app = express()
app.use(express.json())
app.use(cors())

const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

const PORT = process.env.PORT || 4000
const strictRaftMode = String(process.env.RAFT_STRICT || "").toLowerCase() === "true"

const replicaUrls = (process.env.REPLICA_URLS
  ? process.env.REPLICA_URLS.split(",").map(url => url.trim()).filter(Boolean)
  : [
    "http://node1:5001",
    "http://node2:5002",
    "http://node3:5003"
  ])

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Store connected clients and metadata.
const clients = new Set()
const clientMeta = new Map()

// -----------------------------
// Utils: Messaging
// -----------------------------
function sendToClient(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function broadcastAll(payload) {
  clients.forEach(ws => sendToClient(ws, payload))
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
        user: meta.user,
        avatar: meta.avatar,
        userId: meta.userId
      })
    }
  })
  return users
}

function updateRoomState(room) {
  if (!room) return

  const users = getUserList(room)

  broadcastRoom(room, {
    type: "user-list",
    room,
    users,
    count: users.length
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

// -----------------------------
// Helper: Find Leader
// -----------------------------
async function getLeader() {
  for (let replicaUrl of replicaUrls) {
    try {
      const res = await axios.get(`${replicaUrl}/log-state`, { timeout: 800 })
      if (res.data.state === "leader") {
        return replicaUrl
      }
    } catch (err) {}
  }
  return null
}

// Global health status for debugging
app.get("/health", async (req, res) => {
  const leader = await getLeader();
  const replicaStatus = await Promise.all(replicaUrls.map(async url => {
    try {
      const s = await axios.get(`${url}/log-state`, { timeout: 500 });
      return { url, online: true, ...s.data };
    } catch (e) {
      return { url, online: false };
    }
  }));

  res.json({
    gateway: "online",
    clients: clients.size,
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
        await sleep(500);
    }
    
    if (!leader) {
      console.log(`[Gateway] No leader found for INIT_STATE`);
      return;
    }

    const res = await axios.get(`${leader}/committed-log`);
    const data = res.data;

    if (ws.readyState === WebSocket.OPEN) {
      // If a room is specified, we could filter here, but we'll let the client filter for now 
      // as they have all the room logic.
      ws.send(JSON.stringify({
        type: "INIT_STATE",
        entries: data.entries || []
      }));
      console.log(`[Gateway] Sent INIT_STATE (${(data.entries || []).length} entries)`);
    }
  } catch (err) {
    console.error("INIT_STATE failed", err.message);
  }
}

// -----------------------------
// Send entry to leader
// -----------------------------
async function sendToLeader(data, options = {}) {
  const leaderTimeoutMs = Number(options.leaderTimeoutMs) > 0 ? Number(options.leaderTimeoutMs) : 5000 // Increased default
  const pollIntervalMs = 300
  const startedAt = Date.now()

  while (Date.now() - startedAt < leaderTimeoutMs) {
    const leader = await getLeader()

    if (!leader) {
      await sleep(pollIntervalMs)
      continue
    }

    try {
      const res = await axios.post(
        `${leader}/add-entry`,
        data,
        { timeout: 1000 }
      )
      return res.data
    } catch (err) {
      // If leader check failed during request or leader stepped down
      await sleep(pollIntervalMs)
    }
  }

  return { success: false, error: "Leader timeout" }
}

// -----------------------------
// Drawing Normalizer
// -----------------------------
function normalizeDrawMessage(data, meta) {
  return {
    type: "draw",
    eventId: data.eventId || meta.eventId || `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
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

// -----------------------------
// WebSocket Logic
// -----------------------------
wss.on("connection", (ws, req) => {
  clients.add(ws)
  console.log(`[Gateway] New connection. Total clients: ${clients.size}`)

  ws.on("message", async (msg) => {
    try {
      const payload = JSON.parse(msg)
      const opType = payload.type
      const meta = clientMeta.get(ws) || {}
      const room = payload.room || meta.room

      if (opType === "join") {
        clientMeta.set(ws, {
          user: payload.user,
          avatar: payload.avatar,
          room: payload.room,
          userId: payload.userId || `usr-${Date.now()}`
        })
        console.log(`[Gateway] User ${payload.user} joined room ${payload.room}`)
        updateRoomState(payload.room)
        broadcastRoomStats()
        
        // Fetch and send initial state history
        await sendInitialState(ws, payload.room)
        return
      }

      if (!room) return

      // Handle RTC signalling (No RAFT required for this)
      if (opType === "rtc-signal") {
        broadcastRoom(room, payload)
        return
      }

      // Handle Cursor positions (No RAFT required for this)
      if (opType === "cursor") {
        broadcastRoom(room, payload)
        return
      }

      // -------------------------------
      // RAFT-COMMITTED OPERATIONS
      // -------------------------------
      // Prepare RAFT message
      const data = payload
      const baseEvent = {
        eventId: data.eventId || `evt-${Date.now()}`,
        user: data.user || meta.user,
        avatar: data.avatar || meta.avatar,
        userId: data.userId || meta.userId
      }

      const drawPayload = normalizeDrawMessage(data, {
        ...meta,
        room,
        ...baseEvent
      })

      const raftPayload = opType === "draw"
        ? drawPayload
        : {
          type: opType,
          ...baseEvent,
          data: data.data
        }

      if (!raftPayload) return

      // Send to RAFT leader.
      const result = await sendToLeader(raftPayload, {
        leaderTimeoutMs: strictRaftMode ? 15000 : 800
      })

      const raftCommitted = Boolean(result && result.success)
      if (!raftCommitted) {
        console.log("⚠️ RAFT unavailable, operation dropped")
        return
      }

      if (opType === "draw") {
        broadcastRoom(room, drawPayload)
      } else if (opType === "clear") {
        broadcastRoom(room, {
          type: "clear",
          ...baseEvent
        })
      } else if (opType === "undo") {
        broadcastRoom(room, {
          type: "undo",
          ...baseEvent
        })
      } else if (opType === "redo") {
        broadcastRoom(room, {
          type: "redo",
          ...baseEvent
        })
      } else if (opType === "ai-draw") {
        broadcastRoom(room, {
          type: "ai-draw",
          ...baseEvent,
          data: data.data
        })
      }

    } catch (err) {
      console.error("[Gateway] Message error:", err.message)
    }
  })

  ws.on("close", () => {
    const meta = clientMeta.get(ws)
    clients.delete(ws)
    clientMeta.delete(ws)
    if (meta && meta.room) {
      updateRoomState(meta.room)
    }
    broadcastRoomStats()
    console.log(`[Gateway] Connection closed. Total clients: ${clients.size}`)
  })
})

// HTTP Status endpoint
app.get("/status", (req, res) => {
  res.json({
    status: "ok",
    clients: clients.size,
    rooms: Array.from(new Set(Array.from(clientMeta.values()).map(m => m.room)))
  })
})

server.listen(PORT, () => {
  console.log(`[Gateway] RAFT Gateway listening on port ${PORT}`)
  console.log(`[Gateway] Replicas configured: ${replicaUrls.join(", ")}`)
})