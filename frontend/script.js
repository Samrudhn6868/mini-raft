const canvas = document.getElementById("drawCanvas")
const ctx = canvas.getContext("2d")

const brushSizeInput = document.getElementById("brushSize")
const brushValue = document.getElementById("brushValue")
const brushColorInput = document.getElementById("brushColor")
const undoBtn = document.getElementById("undoBtn")
const redoBtn = document.getElementById("redoBtn")
const saveBtn = document.getElementById("saveBtn")
const exportBtn = document.getElementById("exportBtn")
const clearBtn = document.getElementById("clearBtn")
const statusEl = document.getElementById("status")
const userCountEl = document.getElementById("userCount")
const identityText = document.getElementById("identityText")
const brushPreview = document.getElementById("brushPreview")
const cursorLayer = document.getElementById("cursorLayer")
const networkToast = document.getElementById("networkToast")

let ws = null
let reconnectTimer = null
let toastTimer = null

const username = (window.prompt("Enter your name", "Guest") || "Guest").trim() || "Guest"
const roomId = (window.prompt("Enter room ID", "room1") || "room1").trim() || "room1"
identityText.textContent = `👤 ${username} | Room: ${roomId}`

let isDrawing = false
let lastPoint = null
let currentStroke = []
let brushSize = Number(brushSizeInput.value)
let brushColor = brushColorInput.value

let history = []
let redoStack = []

const cursors = {}

function roomStorageKey() {
  return `drawing:${roomId}`
}

function createThrottle(fn, wait) {
  let lastCall = 0
  return (...args) => {
    const now = Date.now()
    if (now - lastCall >= wait) {
      lastCall = now
      fn(...args)
    }
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()

  canvas.width = Math.floor(rect.width * dpr)
  canvas.height = Math.floor(rect.height * dpr)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.scale(dpr, dpr)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.shadowBlur = 10
  ctx.shadowColor = "rgba(110, 231, 255, 0.25)"

  redrawCanvas()
}

function setStatus(connected) {
  statusEl.classList.toggle("connected", connected)
  statusEl.classList.toggle("disconnected", !connected)
  statusEl.textContent = connected ? "Connected" : "Disconnected"
}

function showToast(message, tone = "warning", autoHideMs = 0) {
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }

  networkToast.textContent = message
  networkToast.classList.add("visible")
  networkToast.classList.toggle("warning", tone === "warning")
  networkToast.classList.toggle("connected", tone === "connected")

  if (autoHideMs > 0) {
    toastTimer = setTimeout(() => {
      networkToast.classList.remove("visible")
    }, autoHideMs)
  }
}

function isSameRoom(payload) {
  return payload && payload.room === roomId
}

function sendPayload(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ room: roomId, user: username, ...payload }))
  }
}

function connectSocket() {
  ws = new WebSocket("wss://raft-gateway.onrender.com")

  ws.addEventListener("open", () => {
    setStatus(true)
    sendPayload({ type: "join" })
    showToast("Back online. Sync restored.", "connected", 1300)
  })

  ws.addEventListener("close", () => {
    setStatus(false)
    showToast("Connection lost. Reconnecting...", "warning")
    scheduleReconnect()
  })

  ws.addEventListener("error", () => {
    setStatus(false)
    showToast("Network error. Retrying shortly...", "warning")
  })

  ws.addEventListener("message", event => {
    try {
      const payload = JSON.parse(event.data)

      if (payload.type === "presence") {
        userCountEl.textContent = String(payload.count)
        return
      }

      if (payload.type === "room-presence" && payload.room === roomId) {
        userCountEl.textContent = String(payload.count)
        return
      }

      if (payload.type === "cursor") {
        handleCursor(payload)
        return
      }

      if (payload.type === "draw" && payload.data && isSameRoom(payload.data)) {
        applyRemoteStroke(payload.data)
        return
      }

      if (payload.type === "clear" && isSameRoom(payload)) {
        applyClear(false)
        return
      }

      if (payload.type === "undo" && isSameRoom(payload)) {
        handleUndo(false)
        return
      }

      if (payload.type === "redo" && isSameRoom(payload)) {
        handleRedo(false)
      }
    } catch (error) {
      console.error("Invalid WS message:", error)
    }
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return

  showToast("Attempting reconnect...", "warning")

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectSocket()
  }, 1200)
}

function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  }
}

function drawSegment(segment) {
  const { x, y, lastX, lastY, color, size } = segment
  if ([x, y, lastX, lastY].some(v => typeof v !== "number")) return

  ctx.strokeStyle = color || "#6ee7ff"
  ctx.lineWidth = Math.max(1, Number(size) || 1)

  ctx.beginPath()
  ctx.moveTo(lastX, lastY)
  ctx.lineTo(x, y)
  ctx.stroke()
}

function draw(action) {
  if (!action) return

  if (action.type === "stroke" && Array.isArray(action.segments)) {
    action.segments.forEach(drawSegment)
  }

  if (action.type === "clear") {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }
}

function redrawCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  history.forEach(draw)
}

function pushHistory(action) {
  history.push(action)
  redoStack = []
}

function beginStroke(event) {
  isDrawing = true
  currentStroke = []
  document.body.classList.add("is-drawing")
  lastPoint = pointFromEvent(event)
}

function moveStroke(event) {
  const point = pointFromEvent(event)
  updateBrushPreview(event.clientX, event.clientY)
  throttledCursor(point)

  if (!isDrawing || !lastPoint) return

  const segment = {
    x: point.x,
    y: point.y,
    lastX: lastPoint.x,
    lastY: lastPoint.y,
    color: brushColor,
    size: brushSize
  }

  currentStroke.push(segment)
  drawSegment(segment)
  sendPayload(segment)

  lastPoint = point
}

function endStroke() {
  if (currentStroke.length > 0) {
    pushHistory({
      type: "stroke",
      user: username,
      room: roomId,
      segments: [...currentStroke]
    })
  }

  isDrawing = false
  currentStroke = []
  lastPoint = null
  document.body.classList.remove("is-drawing")
}

function applyRemoteStroke(segment) {
  drawSegment(segment)
  pushHistory({
    type: "stroke",
    user: segment.user || "remote",
    room: segment.room,
    segments: [segment]
  })
}

function applyClear(shouldBroadcast) {
  const clearAction = { type: "clear", room: roomId, user: username }
  pushHistory(clearAction)
  redrawCanvas()

  if (shouldBroadcast) {
    sendPayload({ type: "clear" })
  }
}

function handleUndo(shouldBroadcast = true) {
  if (history.length === 0) return
  const action = history.pop()
  redoStack.push(action)
  redrawCanvas()

  if (shouldBroadcast) {
    sendPayload({ type: "undo" })
  }
}

function handleRedo(shouldBroadcast = true) {
  if (redoStack.length === 0) return
  const action = redoStack.pop()
  history.push(action)
  redrawCanvas()

  if (shouldBroadcast) {
    sendPayload({ type: "redo" })
  }
}

function saveDrawing() {
  const data = canvas.toDataURL("image/png")
  localStorage.setItem(roomStorageKey(), data)
  showToast("Drawing saved locally.", "connected", 1100)
}

function loadSavedDrawing() {
  const saved = localStorage.getItem(roomStorageKey())
  if (!saved) return

  const image = new Image()
  image.onload = () => {
    ctx.drawImage(image, 0, 0, canvas.clientWidth, canvas.clientHeight)
  }
  image.src = saved
}

function exportImage() {
  const data = canvas.toDataURL("image/png")
  const link = document.createElement("a")
  link.href = data
  link.download = `raft-draw-${roomId}.png`
  link.click()
}

function handleCursor(payload) {
  if (!isSameRoom(payload)) return
  if (!payload.user || payload.user === username) return
  if (typeof payload.x !== "number" || typeof payload.y !== "number") return

  let cursor = cursors[payload.user]

  if (!cursor) {
    const root = document.createElement("div")
    root.className = "remote-cursor"

    const dot = document.createElement("div")
    dot.className = "remote-cursor-dot"

    const label = document.createElement("div")
    label.className = "remote-cursor-label"
    label.textContent = payload.user

    root.appendChild(dot)
    root.appendChild(label)
    cursorLayer.appendChild(root)

    cursor = { root, timeout: null }
    cursors[payload.user] = cursor
  }

  const rect = canvas.getBoundingClientRect()
  cursor.root.style.left = `${rect.left + payload.x}px`
  cursor.root.style.top = `${rect.top + payload.y}px`

  if (cursor.timeout) clearTimeout(cursor.timeout)
  cursor.timeout = setTimeout(() => {
    if (cursor.root.parentNode) {
      cursor.root.parentNode.removeChild(cursor.root)
    }
    delete cursors[payload.user]
  }, 1800)
}

function sendCursor(point) {
  sendPayload({ type: "cursor", x: point.x, y: point.y })
}

const throttledCursor = createThrottle(sendCursor, 30)

function updateBrushPreview(clientX, clientY) {
  brushPreview.style.left = `${clientX}px`
  brushPreview.style.top = `${clientY}px`
}

function refreshBrushPreviewSize() {
  const previewSize = Math.max(8, brushSize)
  brushPreview.style.width = `${previewSize}px`
  brushPreview.style.height = `${previewSize}px`
  brushPreview.style.borderColor = brushColor
}

brushSizeInput.addEventListener("input", () => {
  brushSize = Number(brushSizeInput.value)
  brushValue.textContent = `${brushSize} px`
  refreshBrushPreviewSize()
})

brushColorInput.addEventListener("input", () => {
  brushColor = brushColorInput.value
  refreshBrushPreviewSize()
})

undoBtn.addEventListener("click", () => handleUndo(true))
redoBtn.addEventListener("click", () => handleRedo(true))
saveBtn.addEventListener("click", saveDrawing)
exportBtn.addEventListener("click", exportImage)
clearBtn.addEventListener("click", () => applyClear(true))

canvas.addEventListener("pointerdown", event => {
  canvas.setPointerCapture(event.pointerId)
  beginStroke(event)
})

canvas.addEventListener("pointermove", moveStroke)
canvas.addEventListener("pointerup", endStroke)
canvas.addEventListener("pointercancel", endStroke)
canvas.addEventListener("pointerleave", () => {
  brushPreview.classList.remove("visible")
})
canvas.addEventListener("pointerenter", () => {
  brushPreview.classList.add("visible")
})
canvas.addEventListener("pointermove", () => {
  brushPreview.classList.add("visible")
})

window.addEventListener("resize", resizeCanvas)

resizeCanvas()
refreshBrushPreviewSize()
setStatus(false)
showToast("Connecting to RAFT gateway...", "warning")
loadSavedDrawing()
connectSocket()
