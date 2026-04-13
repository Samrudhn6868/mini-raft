class Node {
  constructor(id, peers) {
    this.id = id
    this.peers = peers

    this.state = "follower"
    this.currentTerm = 0
    this.votedFor = null
    this.votesReceived = 0

    this.heartbeatInterval = null
    this.electionTimeout = null

    console.log(`Node ${this.id} started as follower`)

    this.resetElectionTimer()
  }

  // Election timeout (800–1100 ms)
  resetElectionTimer() {
    clearTimeout(this.electionTimeout)

    const timeout = Math.random() * 300 + 800

    this.electionTimeout = setTimeout(() => {
      if (this.state === "follower") {
        this.startElection()
      }
    }, timeout)
  }

  // Start election
  startElection() {
    if (this.state !== "follower") return

    this.state = "candidate"
    this.currentTerm += 1
    this.votedFor = this.id
    this.votesReceived = 1

    console.log(`Node ${this.id} → Candidate (Term ${this.currentTerm})`)

    this.requestVotes()
  }

  // Request votes
  requestVotes() {
    this.peers.forEach(peer => {
      const voteGranted = peer.receiveVoteRequest({
        term: this.currentTerm,
        candidateId: this.id
      })

      if (voteGranted) {
        this.votesReceived++
      }

      // Majority = 2 of 3
      if (this.votesReceived >= 2 && this.state === "candidate") {
        this.becomeLeader()
      }
    })
  }

  // Handle vote request
  receiveVoteRequest({ term, candidateId }) {
    if (this.state === "dead") return false

    // Reject old terms
    if (term < this.currentTerm) return false

    // New term → reset
    if (term > this.currentTerm) {
      this.currentTerm = term
      this.votedFor = null
      this.state = "follower"
    }

    // Vote only once per term
    if (this.votedFor === null || this.votedFor === candidateId) {
      this.votedFor = candidateId
      this.resetElectionTimer() // IMPORTANT
      return true
    }

    return false
  }

  // Become leader
  becomeLeader() {
    clearInterval(this.heartbeatInterval)
    clearTimeout(this.electionTimeout)

    this.state = "leader"
    console.log(`Node ${this.id} → Leader (Term ${this.currentTerm})`)

    this.startHeartbeat()
  }

  // Heartbeats every 150ms
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.peers.forEach(peer => {
        peer.receiveHeartbeat({
          term: this.currentTerm,
          leaderId: this.id
        })
      })
    }, 150)
  }

  // Receive heartbeat
  receiveHeartbeat({ term, leaderId }) {
    if (this.state === "dead") return

    if (term >= this.currentTerm) {
      this.currentTerm = term
      this.state = "follower"
      this.votedFor = null

      clearTimeout(this.electionTimeout) // FORCE STOP
      this.resetElectionTimer()
    }
  }
}

module.exports = Node
