function getRtcConfig() {
  return {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  }
}

export class RTCMesh {
  constructor({ selfId, room, wsSignalSend, onData, onPeerStateChange }) {
    this.selfId = selfId
    this.room = room
    this.wsSignalSend = wsSignalSend
    this.onData = onData
    this.onPeerStateChange = onPeerStateChange
    this.peers = new Map()
  }

  setContext({ selfId, room }) {
    this.selfId = selfId
    this.room = room
  }

  ensurePeer(peerId, initiator) {
    if (peerId === this.selfId) return null

    const existing = this.peers.get(peerId)
    if (existing) return existing

    const connection = new RTCPeerConnection(getRtcConfig())
    const peer = {
      id: peerId,
      pc: connection,
      channel: null
    }

    connection.onicecandidate = event => {
      if (!event.candidate) return
      this.wsSignalSend({
        room: this.room,
        target: peerId,
        signal: { kind: "ice", candidate: event.candidate }
      })
    }

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState
      if (this.onPeerStateChange) {
        this.onPeerStateChange({ peerId, state })
      }

      if (["failed", "closed", "disconnected"].includes(state)) {
        this.dropPeer(peerId)
      }
    }

    connection.ondatachannel = event => {
      this.attachChannel(peerId, event.channel)
    }

    this.peers.set(peerId, peer)

    if (initiator) {
      const channel = connection.createDataChannel("draw")
      this.attachChannel(peerId, channel)
      this.createOffer(peerId)
    }

    return peer
  }

  attachChannel(peerId, channel) {
    const peer = this.peers.get(peerId)
    if (!peer) return

    peer.channel = channel

    channel.onmessage = event => {
      try {
        const payload = JSON.parse(event.data)
        if (this.onData) {
          this.onData(payload)
        }
      } catch {
        // Ignore malformed rtc payloads.
      }
    }
  }

  async createOffer(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer) return

    const offer = await peer.pc.createOffer()
    await peer.pc.setLocalDescription(offer)

    this.wsSignalSend({
      room: this.room,
      target: peerId,
      signal: { kind: "offer", sdp: offer }
    })
  }

  async handleSignal({ from, signal }) {
    if (!from || !signal) return

    const initiator = this.selfId > from
    const peer = this.ensurePeer(from, initiator)
    if (!peer) return

    if (signal.kind === "offer") {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)
      this.wsSignalSend({
        room: this.room,
        target: from,
        signal: { kind: "answer", sdp: answer }
      })
      return
    }

    if (signal.kind === "answer") {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
      return
    }

    if (signal.kind === "ice" && signal.candidate) {
      await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {})
    }
  }

  syncPeers(activePeerIds) {
    const activeSet = new Set(activePeerIds.filter(id => id && id !== this.selfId))

    activeSet.forEach(peerId => {
      const shouldInitiate = this.selfId > peerId
      this.ensurePeer(peerId, shouldInitiate)
    })

    this.peers.forEach((_, peerId) => {
      if (!activeSet.has(peerId)) {
        this.dropPeer(peerId)
      }
    })
  }

  broadcast(payload) {
    let delivered = false
    this.peers.forEach(peer => {
      if (peer.channel && peer.channel.readyState === "open") {
        peer.channel.send(JSON.stringify(payload))
        delivered = true
      }
    })
    return delivered
  }

  dropPeer(peerId) {
    const peer = this.peers.get(peerId)
    if (!peer) return

    if (peer.channel) {
      peer.channel.close()
    }
    peer.pc.close()
    this.peers.delete(peerId)
  }

  close() {
    this.peers.forEach((_, peerId) => this.dropPeer(peerId))
  }
}
