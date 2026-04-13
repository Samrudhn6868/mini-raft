const STORAGE_KEY = "raft-draw-auth"

function normalizeSession(value = {}) {
  const username = String(value.username || "").trim() || "Guest"
  const avatar = String(value.avatar || "").trim() || "🙂"
  const room = String(value.room || "").trim() || "room1"
  return { username, avatar, room }
}

export function readStoredSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return normalizeSession(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeStoredSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSession(session)))
}

export function initAuth({
  loginOverlay,
  appShell,
  loginForm,
  usernameInput,
  avatarInput,
  roomInput,
  onReady
}) {
  const existing = readStoredSession()

  // Always show login first; prefill previous identity if available.
  if (existing) {
    usernameInput.value = existing.username
    avatarInput.value = existing.avatar
    roomInput.value = existing.room
  }

  loginOverlay.classList.remove("hidden")
  appShell.classList.add("hidden")

  loginForm.addEventListener("submit", event => {
    event.preventDefault()

    const session = normalizeSession({
      username: usernameInput.value,
      avatar: avatarInput.value,
      room: roomInput.value
    })

    writeStoredSession(session)
    loginOverlay.classList.add("hidden")
    appShell.classList.remove("hidden")
    onReady(session)
  })
}
