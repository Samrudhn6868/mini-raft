const Node = require("./raft/node")

const node1 = new Node(1, [])
const node2 = new Node(2, [])
const node3 = new Node(3, [])

node1.peers = [node2, node3]
node2.peers = [node1, node3]
node3.peers = [node1, node2]

// Simulate leader failure
setTimeout(() => {
  console.log("\n🔥 Simulating leader failure...\n")

  if (node1.state === "leader") {
    clearInterval(node1.heartbeatInterval)
    node1.state = "dead"
    console.log("Node 1 killed")
  }

  if (node2.state === "leader") {
    clearInterval(node2.heartbeatInterval)
    node2.state = "dead"
    console.log("Node 2 killed")
  }

  if (node3.state === "leader") {
    clearInterval(node3.heartbeatInterval)
    node3.state = "dead"
    console.log("Node 3 killed")
  }
}, 5000)