import { initAuth } from "./auth.js"
import { RTCMesh } from "./rtc.js"

// Global error handler to catch startup crashes
window.onerror = function(msg, url, lineNo, columnNo, error) {
  const errStr = `Error: ${msg}\nLine: ${lineNo}\nColumn: ${columnNo}\n${error && error.stack}`;
  console.error("GLOBAL CRASH:", errStr);
  alert("CRITICAL ERROR DURING STARTUP:\n" + msg + "\nCheck console for full stack.");
  return false;
};

// Fallback for crypto.randomUUID for broader browser support
const generateUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

const isLocalHost = window.location.hostname === "localhost" || 
                   window.location.hostname === "127.0.0.1" || 
                   window.location.protocol === "file:";

// Priority: Localhost -> Railway -> Render (Fallback)
let WS_URL = "wss://raft-gateway-production.up.railway.app" 

if (isLocalHost) {
  // Use port 3000 for the local Docker Gateway
  WS_URL = `ws://localhost:3000`
}

const loginOverlay = document.getElementById("loginOverlay")
const appShell = document.getElementById("appShell")
const loginForm = document.getElementById("loginForm")
const usernameInput = document.getElementById("usernameInput")
const avatarInput = document.getElementById("avatarInput")
const roomInput = document.getElementById("roomInput")

const canvas = document.getElementById("drawCanvas")
const ctx = canvas.getContext("2d")
const brushSizeInput = document.getElementById("brushSize")
const brushValue = document.getElementById("brushValue")
const brushColorInput = document.getElementById("brushColor")
const snapBtn = document.getElementById("snapBtn")
const undoBtn = document.getElementById("undoBtn")
const redoBtn = document.getElementById("redoBtn")
const saveBtn = document.getElementById("saveBtn")
const exportPngBtn = document.getElementById("exportPngBtn")
const exportSvgBtn = document.getElementById("exportSvgBtn")
const exportJsonBtn = document.getElementById("exportJsonBtn")
const debugToggleBtn = document.getElementById("debugToggleBtn")
const clearBtn = document.getElementById("clearBtn")
const statusEl = document.getElementById("status")
const userCountEl = document.getElementById("userCount")
const identityChip = document.getElementById("identityChip")
const userList = document.getElementById("userList")
const roomList = document.getElementById("roomList")
const brushPreview = document.getElementById("brushPreview")
const cursorLayer = document.getElementById("cursorLayer")
const networkToast = document.getElementById("networkToast")
const debugPanel = document.getElementById("debugPanel")
const debugSummary = document.getElementById("debugSummary")
const debugLogList = document.getElementById("debugLogList")

const state = {
  session: null,
  selfId: generateUUID(),
  ws: null,
  reconnectTimer: null,
  toastTimer: null,
  rtc: null,
  isDrawing: false,
  currentStroke: [],
  history: [],
  redoStack: [],
  seenEvents: new Set(),
  cursors: new Map(),
  brushSize: brushSizeInput ? Number(brushSizeInput.value) : 2,
  brushColor: brushColorInput ? brushColorInput.value : "#6ee7ff",
  lastPoint: null,
  snapToGrid: false,
  debugVisible: false,
  debug: {
    wsState: "closed",
    wsIn: 0,
    wsOut: 0,
    rtcSignalsIn: { offer: 0, answer: 0, ice: 0 },
    rtcSignalsOut: { offer: 0, answer: 0, ice: 0 },
    drawViaRtc: 0,
    drawViaWs: 0,
    peerState: "idle",
    peersConnected: 0,
    logs: []
  }
}

function createId() {
  return generateUUID()
}

function markSeen(id) {
  if (!id) return
  state.seenEvents.add(id)
  if (state.seenEvents.size > 5000) {
    const oldest = state.seenEvents.values().next().value
    state.seenEvents.delete(oldest)
  }
}

function hasSeen(id) {
  return Boolean(id && state.seenEvents.has(id))
}

function storageKey(kind) {
  return `drawing:${state.session.room}:${kind}`
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

function setStatus(connected) {
  if (!statusEl) return;
  statusEl.classList.toggle("connected", connected)
  statusEl.classList.toggle("disconnected", !connected)
  statusEl.textContent = connected ? "Connected" : "Disconnected"
}

function showToast(message, tone = "warning", autoHideMs = 0) {
  if (!networkToast) return;
  if (state.toastTimer) {
    clearTimeout(state.toastTimer)
    state.toastTimer = null
  }

  networkToast.textContent = message
  networkToast.classList.add("visible")
  networkToast.classList.toggle("warning", tone === "warning")
  networkToast.classList.toggle("connected", tone === "connected")

  if (autoHideMs > 0) {
    state.toastTimer = setTimeout(() => {
      networkToast.classList.remove("visible")
    }, autoHideMs)
  }
}

function renderIdentity() {
  if (!identityChip || !state.session) return;
  const { username, avatar, room } = state.session
  identityChip.textContent = `${avatar} ${username} | Room: ${room}`
}

function pushDebugLog(message) {
  const stamp = new Date().toLocaleTimeString()
  state.debug.logs.unshift(`${stamp} | ${message}`)
  if (state.debug.logs.length > 24) {
    state.debug.logs.length = 24
  }
  renderDebugPanel(); // Fix: Ensure panel updates when log is added
}

function renderDebugPanel() {
  if (!debugSummary || !debugLogList) return;
  const peers = state.rtc ? state.rtc.peers.size : 0
  state.debug.peersConnected = peers

  debugSummary.textContent = [
    `WS: ${state.debug.wsState} | in=${state.debug.wsIn} out=${state.debug.wsOut}`,
    `RTC peers: ${state.debug.peersConnected} | peer-state: ${state.debug.peerState}`,
    `Signals in: offer=${state.debug.rtcSignalsIn.offer} answer=${state.debug.rtcSignalsIn.answer} ice=${state.debug.rtcSignalsIn.ice}`,
    `Signals out: offer=${state.debug.rtcSignalsOut.offer} answer=${state.debug.rtcSignalsOut.answer} ice=${state.debug.rtcSignalsOut.ice}`,
    `Draw transport: rtc=${state.debug.drawViaRtc} ws=${state.debug.drawViaWs}`
  ].join("\n")

  debugLogList.innerHTML = ""
  state.debug.logs.forEach(entry => {
    const item = document.createElement("li")
    item.textContent = entry
    debugLogList.appendChild(item)
  })
}

function updateDebug(partial = {}) {
  Object.assign(state.debug, partial)
  renderDebugPanel()
}

function resizeCanvas() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()

  canvas.width = Math.floor(rect.width * dpr)
  canvas.height = Math.floor(rect.height * dpr)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.scale(dpr, dpr)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.shadowBlur = 8
  ctx.shadowColor = "rgba(110, 231, 255, 0.24)"

  redrawCanvas()
}

function redrawCanvas() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  state.history.forEach(action => draw(action))
}

function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  }
}

function snapPoint(point) {
  if (!state.snapToGrid) return point
  const grid = 16
  return {
    x: Math.round(point.x / grid) * grid,
    y: Math.round(point.y / grid) * grid
  }
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function pointToLineDistance(p, a, b) {
  const lineLength = dist(a, b)
  if (lineLength === 0) return dist(p, a)

  const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (lineLength * lineLength)
  const clamped = Math.max(0, Math.min(1, t))
  const projection = {
    x: a.x + clamped * (b.x - a.x),
    y: a.y + clamped * (b.y - a.y)
  }
  return dist(p, projection)
}

function circleFromPoints(points) {
  const center = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
  center.x /= points.length
  center.y /= points.length

  const distances = points.map(p => dist(p, center))
  const radius = distances.reduce((a, b) => a + b, 0) / distances.length
  const variance = distances.reduce((acc, d) => acc + Math.pow(d - radius, 2), 0) / distances.length

  return { center, radius, variance }
}

function normalizeStroke(points) {
  if (points.length < 3) return points

  const start = points[0]
  const end = points[points.length - 1]

  const maxDeviation = points.reduce((max, point) => {
    return Math.max(max, pointToLineDistance(point, start, end))
  }, 0)

  if (maxDeviation < 4 && dist(start, end) > 22) {
    return [start, end]
  }

  if (dist(start, end) < 18 && points.length > 10) {
    const { center, radius, variance } = circleFromPoints(points)
    if (variance < 64) {
      const circle = []
      for (let i = 0; i <= 30; i++) {
        const theta = (Math.PI * 2 * i) / 30
        circle.push({
          x: center.x + Math.cos(theta) * radius,
          y: center.y + Math.sin(theta) * radius
        })
      }
      return circle
    }
  }

  return points
}

function drawSegment(a, b, color, size) {
  if (!ctx) return;
  ctx.strokeStyle = color || "#6ee7ff"
  ctx.lineWidth = Math.max(1, Number(size) || 1)
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
}

function drawRemote(data) {
  if (!data) return
  if (Array.isArray(data.points) && data.points.length > 1) {
    for (let i = 1; i < data.points.length; i++) {
      drawSegment(data.points[i - 1], data.points[i], data.color, data.size)
    }
    return
  }
}

function handleRemoteDrawMessage(payload) {
  const room = payload.room || (payload.data && payload.data.room)
  if (!state.session || room !== state.session.room) return

  if (payload.data) {
    if (Array.isArray(payload.data.points) && payload.data.points.length > 1) {
      state.history.push({
        id: payload.eventId || createId(),
        kind: "stroke",
        user: payload.user,
        avatar: payload.avatar,
        userId: payload.userId,
        color: payload.data.color,
        size: payload.data.size,
        points: payload.data.points
      })
    }
  }
  drawRemote(payload.data)
}

function draw(action) {
  if (!action || action.kind !== "stroke" || !Array.isArray(action.points)) return
  for (let i = 1; i < action.points.length; i++) {
    drawSegment(action.points[i - 1], action.points[i], action.color, action.size)
  }
}

function pushHistory(action) {
  state.history.push(action)
  state.redoStack = []
}

function updateBrushPreview(clientX, clientY) {
  if (!brushPreview) return;
  brushPreview.style.left = `${clientX}px`
  brushPreview.style.top = `${clientY}px`
}

function refreshBrushPreviewSize() {
  if (!brushPreview) return;
  const previewSize = Math.max(8, state.brushSize)
  brushPreview.style.width = `${previewSize}px`
  brushPreview.style.height = `${previewSize}px`
  brushPreview.style.borderColor = state.brushColor
}

function sendWs(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
  state.debug.wsOut += 1
  pushDebugLog(`WS -> ${payload.type || "draw"}`)
  renderDebugPanel()
  state.ws.send(JSON.stringify(payload))
}

function wsEnvelope(payload) {
  return {
    ...payload,
    room: state.session.room,
    user: state.session.username,
    avatar: state.session.avatar,
    userId: state.selfId
  }
}

function broadcastOperation(operation) {
  if (!state.session) return;
  if (operation.eventId) {
    markSeen(operation.eventId)
  }
  state.debug.drawViaWs += 1
  sendWs(wsEnvelope(operation))
  renderDebugPanel()
}

function handleUndo({ broadcast = true, data = null } = {}) {
  let targetActionId = data && data.targetActionId
  if (!targetActionId && state.history.length > 0) {
    targetActionId = state.history[state.history.length - 1].id
  }
  if (!targetActionId) return

  const index = [...state.history].map(action => action.id).lastIndexOf(targetActionId)
  if (index === -1) return

  const [removed] = state.history.splice(index, 1)
  state.redoStack.push(removed)
  redrawCanvas()

  if (broadcast) {
    const id = createId()
    markSeen(id)
    broadcastOperation({ type: "undo", eventId: id, data: { targetActionId } })
  }
}

function handleRedo({ broadcast = true, data = null } = {}) {
  let action = data && data.action
  if (!action) {
    action = state.redoStack.pop()
  }
  if (!action) return

  state.history.push(action)
  redrawCanvas()

  if (broadcast) {
    const id = createId()
    markSeen(id)
    broadcastOperation({ type: "redo", eventId: id, data: { action } })
  }
}

function applyClear({ broadcast = true } = {}) {
  state.history = []
  state.redoStack = []
  redrawCanvas()

  if (broadcast) {
    const id = createId()
    markSeen(id)
    broadcastOperation({ type: "clear", eventId: id })
  }
}

function saveDrawing() {
  if (!state.session) return;
  localStorage.setItem(storageKey("png"), canvas.toDataURL("image/png"))
  localStorage.setItem(storageKey("json"), JSON.stringify({ actions: state.history }))
  showToast("Saved to local storage.", "connected", 1200)
}

function restoreDrawing() {
  if (!state.session) return;
  try {
    const raw = localStorage.getItem(storageKey("json"))
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.actions)) {
      state.history = parsed.actions
      redrawCanvas()
    }
  } catch { /* ignore */ }
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function exportPng() {
  const link = document.createElement("a")
  link.href = canvas.toDataURL("image/png")
  link.download = `raft-draw-${state.session.room}.png`
  link.click()
}

function exportSvg() {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const paths = state.history
    .filter(action => action.kind === "stroke" && Array.isArray(action.points) && action.points.length > 1)
    .map(action => {
      const d = action.points
        .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
        .join(" ")
      return `<path d="${d}" fill="none" stroke="${action.color || "#6ee7ff"}" stroke-width="${action.size || 2}" stroke-linecap="round" stroke-linejoin="round" />`
    })
    .join("\n")

  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${paths}\n</svg>`
  downloadFile(`raft-draw-${state.session.room}.svg`, svg, "image/svg+xml")
}

function exportJson() {
  const payload = {
    room: state.session.room,
    exportedAt: new Date().toISOString(),
    actions: state.history
  }
  downloadFile(`raft-draw-${state.session.room}.json`, JSON.stringify(payload, null, 2), "application/json")
}

function handleCursor(payload) {
  if (!payload || !state.session || payload.room !== state.session.room) return
  if (!payload.userId || payload.userId === state.selfId) return

  let cursor = state.cursors.get(payload.userId)

  if (!cursor) {
    const root = document.createElement("div")
    root.className = "remote-cursor"
    const dot = document.createElement("div")
    dot.className = "remote-cursor-dot"
    const label = document.createElement("div")
    label.className = "remote-cursor-label"
    label.textContent = `${payload.avatar || "🙂"} ${payload.user || "User"}`
    root.appendChild(dot)
    root.appendChild(label)
    cursorLayer.appendChild(root)
    cursor = { root, timeout: null }
    state.cursors.set(payload.userId, cursor)
  }

  const rect = canvas.getBoundingClientRect()
  cursor.root.style.left = `${rect.left + payload.x}px`
  cursor.root.style.top = `${rect.top + payload.y}px`

  if (cursor.timeout) clearTimeout(cursor.timeout)
  cursor.timeout = setTimeout(() => {
    if (cursor.root.parentNode) cursor.root.parentNode.removeChild(cursor.root)
    state.cursors.delete(payload.userId)
  }, 1800)
}

function sendCursor(point) {
  sendWs(wsEnvelope({ type: "cursor", x: point.x, y: point.y }))
}
const throttledCursor = createThrottle(sendCursor, 30)

function renderUsers(users = []) {
  if (!userCountEl || !userList) return;
  userCountEl.textContent = String(users.length)
  userList.innerHTML = ""
  users.forEach(user => {
    const item = document.createElement("li")
    item.textContent = `${user.avatar || "🙂"} ${user.user || "Guest"}`
    if (user.userId === state.selfId) {
      item.classList.add("current-user")
      item.textContent += " (You)"
    }
    userList.appendChild(item)
  })
  if (state.rtc) state.rtc.syncPeers(users.map(u => u.userId))
}

function renderRooms(rooms = []) {
  if (!roomList) return;
  roomList.innerHTML = ""
  rooms.forEach(room => {
    const item = document.createElement("li")
    item.textContent = `${room.room} (${room.count})`
    roomList.appendChild(item)
  })
}

function scheduleReconnect() {
  if (state.reconnectTimer) return
  showToast("Attempting reconnect...", "warning")
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    connectSocket()
  }, 1200)
}

function handleIncomingOperation(payload, source = "ws") {
  if (!payload || !state.session || payload.room !== state.session.room) return
  const eventId = payload.eventId || (payload.data && payload.data.id);
  if (!eventId || hasSeen(eventId)) return
  markSeen(eventId)

  if (payload.type === "draw") handleRemoteDrawMessage(payload)
  else if (payload.type === "clear") applyClear({ broadcast: false })
  else if (payload.type === "undo") handleUndo({ broadcast: false, data: payload.data })
  else if (payload.type === "redo") handleRedo({ broadcast: false, data: payload.data })
}

function connectSocket() {
  state.ws = new WebSocket(WS_URL)
  updateDebug({ wsState: "connecting" })
  pushDebugLog("WS connecting")

  state.ws.addEventListener("open", () => {
    updateDebug({ wsState: "open" })
    pushDebugLog("WS open")
    setStatus(true)
    showToast("Back online. Sync restored.", "connected", 1300)
    sendWs(wsEnvelope({ type: "join" }))
    if (state.rtc) state.rtc.close()
    state.rtc = new RTCMesh({
      selfId: state.selfId,
      room: state.session.room,
      wsSignalSend: payload => sendWs(wsEnvelope({ type: "rtc-signal", ...payload })),
      onData: packet => handleIncomingOperation(packet.payload, "rtc"),
      onPeerStateChange: ({ peerId, state: ps }) => {
        state.debug.peerState = ps
        renderDebugPanel()
      }
    })
  })

  state.ws.addEventListener("close", () => {
    updateDebug({ wsState: "closed" })
    setStatus(false)
    scheduleReconnect()
  })

  state.ws.addEventListener("message", async event => {
    try {
      const payload = JSON.parse(event.data)
      state.debug.wsIn += 1
      if (payload.type === "welcome" && payload.clientId) {
        state.selfId = payload.clientId
        renderIdentity()
        sendWs(wsEnvelope({ type: "join" }))
      } else if (payload.type === "user-list") renderUsers(payload.users)
      else if (payload.type === "room-stats") renderRooms(payload.rooms)
      else if (payload.type === "rtc-signal" && state.rtc) await state.rtc.handleSignal(payload)
      else if (payload.type === "cursor") handleCursor(payload)
      else if (payload.type === "INIT_STATE") {
        state.history = []; redrawCanvas();
        for (const entry of payload.entries) if (entry && entry.data) handleIncomingOperation(entry.data, "initial")
      } else handleIncomingOperation(payload)
      renderDebugPanel()
    } catch { /* ignore */ }
  })
}

function startStroke(event) {
  state.isDrawing = true
  document.body.classList.add("is-drawing")
  const point = snapPoint(pointFromEvent(event))
  state.currentStroke = [point]
  state.lastPoint = point
}

function continueStroke(event) {
  const point = snapPoint(pointFromEvent(event))
  updateBrushPreview(event.clientX, event.clientY)
  throttledCursor(point)
  if (!state.isDrawing || !state.lastPoint) return
  drawSegment(state.lastPoint, point, state.brushColor, state.brushSize)
  state.currentStroke.push(point)
  state.lastPoint = point
}

function endStroke() {
  if (!state.isDrawing) return
  state.isDrawing = false
  document.body.classList.remove("is-drawing")
  if (state.currentStroke.length > 1) {
    const action = {
      id: createId(),
      kind: "stroke",
      userId: state.selfId,
      user: state.session.username,
      avatar: state.session.avatar,
      color: state.brushColor,
      size: state.brushSize,
      points: [...state.currentStroke]
    }
    pushHistory(action)
    broadcastOperation({ type: "draw", eventId: action.id, data: action })
  }
}

function bindUI() {
  brushSizeInput.addEventListener("input", () => {
    state.brushSize = Number(brushSizeInput.value)
    brushValue.textContent = `${state.brushSize} px`
    refreshBrushPreviewSize()
  })
  brushColorInput.addEventListener("input", () => {
    state.brushColor = brushColorInput.value
    refreshBrushPreviewSize()
  })
  snapBtn.addEventListener("click", () => {
    state.snapToGrid = !state.snapToGrid
    snapBtn.textContent = `Snap Grid: ${state.snapToGrid ? "On" : "Off"}`
  })
  undoBtn.addEventListener("click", () => handleUndo())
  redoBtn.addEventListener("click", () => handleRedo())
  clearBtn.addEventListener("click", () => applyClear())
  saveBtn.addEventListener("click", saveDrawing)
  exportPngBtn.addEventListener("click", exportPng)
  exportSvgBtn.addEventListener("click", exportSvg)
  exportJsonBtn.addEventListener("click", exportJson)
  debugToggleBtn.addEventListener("click", () => {
    state.debugVisible = !state.debugVisible
    debugPanel.classList.toggle("hidden", !state.debugVisible)
  })
  canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); startStroke(e); })
  canvas.addEventListener("pointermove", continueStroke)
  canvas.addEventListener("pointerup", endStroke)
  window.addEventListener("resize", resizeCanvas)
}

function boot(session) {
  try {
    state.session = session
    renderIdentity(); bindUI(); resizeCanvas(); refreshBrushPreviewSize(); restoreDrawing();
    setStatus(false); renderDebugPanel(); showToast("Connecting to RAFT...", "warning")
    connectSocket();
  } catch (err) { alert(`Boot failure: ${err.message}`); }
}

try {
  console.log("Mini-RAFT initializing auth...");
  initAuth({
    loginOverlay, appShell, loginForm, usernameInput, avatarInput, roomInput,
    onReady: boot
  });
  console.log("Auth initialized");
} catch (err) {
  console.error("Auth boot failed", err);
}
