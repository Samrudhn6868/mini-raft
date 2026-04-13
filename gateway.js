const express = require("express")
const http = require("http")
const WebSocket = require("ws")
const axios = require("axios")
const path = require("path")
const crypto = require("crypto")
const cors = require("cors")

const app = express()
app.use(cors())

const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

const PORT = process.env.PORT || 4000

const replicaUrls = (process.env.REPLICA_URLS
  ? process.env.REPLICA_URLS.split(",").map(url => url.trim()).filter(Boolean)
  : [
    "http://localhost:5001",
    "http://localhost:5002",
    "http://localhost:5003"
  ])

// Store connected clients and metadata.
const clients = new Set()
const clientMeta = new Map()

function sendToClient(client, payload) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(payload))
  }
}

function getRoomClients(room) {
  if (!room) return []

  const roomClients = []
  clients.forEach(client => {
    const meta = clientMeta.get(client)
    if (meta && meta.room === room) {
      roomClients.push(client)
    }
  })
  return roomClients
}

function broadcastRoom(room, payload, exceptClient = null) {
  getRoomClients(room).forEach(client => {
    if (client !== exceptClient) {
      sendToClient(client, payload)
    }
  })
}

function getUserList(room) {
  const userMap = new Map()

  getRoomClients(room).forEach(client => {
    const meta = clientMeta.get(client)
    if (!meta) return

    const userId = meta.userId || meta.clientId
    if (!userMap.has(userId)) {
      userMap.set(userId, {
        userId,
        user: meta.user || "Guest",
        avatar: meta.avatar || "🙂"
      })
    }
  })

  return Array.from(userMap.values())
}

function broadcastUserList(room) {
  if (!room) return

  broadcastRoom(room, {
    type: "user-list",
    room,
    users: getUserList(room),
    count: getUserList(room).length
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
      const res = await axios.get(`${replicaUrl}/log-state`, { timeout: 500 })
      if (res.data.state === "leader") {
        return replicaUrl
      }
    } catch (err) {}
  }
  return null
}

// -----------------------------
// Send entry to leader
// -----------------------------
async function sendToLeader(data) {
  let leader = await getLeader()

  if (!leader) {
    console.log("❌ No leader found")
    return { success: false }
  }

  try {
    const res = await axios.post(
      `${leader}/add-entry`,
      data,
      { timeout: 1000 }
    )
    return res.data
  } catch (err) {
    console.log("⚠️ Leader failed, retrying...")
    
    // Retry once after re-detecting leader
    leader = await getLeader()
    if (!leader) return { success: false }

    try {
      const res = await axios.post(
        `${leader}/add-entry`,
        data
      )
      return res.data
    } catch {
      return { success: false }
    }
  }
}

function normalizeDrawMessage(raw, meta) {
  if (!raw || typeof raw !== "object") return null

  if (raw.type === "draw" && raw.data) {
    return {
      type: "draw",
      room: raw.room || meta.room,
      eventId: raw.eventId,
      user: raw.user || meta.user,
      avatar: raw.avatar || meta.avatar,
      userId: raw.userId || meta.userId,
      data: raw.data
    }
  }

  if (typeof raw.x === "number" && typeof raw.y === "number") {
    return {
      type: "draw",
      room: raw.room || meta.room,
      eventId: raw.eventId,
      user: raw.user || meta.user,
      avatar: raw.avatar || meta.avatar,
      userId: raw.userId || meta.userId,
      data: {
        x: raw.x,
        y: raw.y,
        lastX: raw.lastX,
        lastY: raw.lastY,
        size: raw.size,
        color: raw.color,
        points: raw.points
      }
    }
  }

  return null
}

function operationNeedsRaft(type) {
  return ["draw", "clear", "undo", "redo", "ai-draw"].includes(type)
}

function getMessageType(data) {
  if (!data || typeof data !== "object") return null
  if (typeof data.type === "string") return data.type
  if (typeof data.x === "number" && typeof data.y === "number") return "draw"
  return null
}

// -----------------------------
// WebSocket Connection
// -----------------------------
wss.on("connection", (ws) => {
  console.log("🟢 Client connected")

  clients.add(ws)
  const clientId = crypto.randomUUID()
  clientMeta.set(ws, {
    clientId,
    userId: clientId,
    room: null,
    user: "Guest",
    avatar: "🙂"
  })

  sendToClient(ws, { type: "welcome", clientId })
  broadcastRoomStats()

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message)
      const meta = clientMeta.get(ws) || {}
      const messageType = getMessageType(data)

      if (messageType === "join") {
        const nextMeta = {
          ...meta,
          room: typeof data.room === "string" ? data.room : null,
          user: typeof data.user === "string" ? data.user : "Guest",
          avatar: typeof data.avatar === "string" ? data.avatar : "🙂",
          userId: typeof data.userId === "string" ? data.userId : meta.userId
        }
        clientMeta.set(ws, nextMeta)

        if (nextMeta.room) {
          broadcastUserList(nextMeta.room)
        }
        broadcastRoomStats()
        return
      }

      if (messageType === "rtc-signal") {
        const room = data.room || meta.room
        const targetId = data.target
        if (!room || !targetId || !data.signal) return

        getRoomClients(room).forEach(client => {
          const targetMeta = clientMeta.get(client)
          if (targetMeta && targetMeta.userId === targetId) {
            sendToClient(client, {
              type: "rtc-signal",
              room,
              from: meta.userId,
              signal: data.signal
            })
          }
        })
        return
      }

      // Cursor updates are ephemeral and do not need RAFT persistence.
      if (messageType === "cursor") {
        const room = data.room || meta.room
        if (!room) return

        broadcastRoom(room, {
          type: "cursor",
          room,
          user: data.user || meta.user,
          avatar: data.avatar || meta.avatar,
          userId: data.userId || meta.userId,
          x: data.x,
          y: data.y
        }, ws)
        return
      }

      const opType = messageType
      if (!opType) return

      if (!operationNeedsRaft(opType)) return

      const room = data.room || meta.room
      if (!room) return

      const baseEvent = {
        room,
        eventId: data.eventId,
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
      const result = await sendToLeader(raftPayload)

      if (result && result.success) {
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
      }
    } catch (err) {
      console.log("Error handling message:", err.message)
    }
  })

  ws.on("close", () => {
    console.log("🔴 Client disconnected")
    const meta = clientMeta.get(ws)
    clients.delete(ws)
    clientMeta.delete(ws)

    if (meta && meta.room) {
      broadcastUserList(meta.room)
    }
    broadcastRoomStats()
  })
})

// -----------------------------
// Static frontend
// -----------------------------
app.use(express.static(path.join(__dirname, "frontend")))

// -----------------------------
// Health check
// -----------------------------
app.get("/health", (req, res) => {
  res.send("OK")
})

// -----------------------------
server.listen(PORT, () => {
  console.log(`Gateway running on ${PORT}`)
})