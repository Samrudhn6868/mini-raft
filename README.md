# Mini-RAFT: Collaborative Real-Time Drawing 🎨🚀

A high-performance, distributed collaborative drawing application built on top of a custom **RAFT Consensus Cluster**. Designed for extreme reliability and real-time synchronization in the cloud.

![Aesthetic Banner](https://img.shields.io/badge/Architecture-RAFT_Distributed-blueviolet?style=for-the-badge&logo=javascript)
![Deployment](https://img.shields.io/badge/Deployment-Multi--Cloud-blue?style=for-the-badge&logo=vercel)
![Backend](https://img.shields.io/badge/Backend-Railway-E11D48?style=for-the-badge&logo=railway)

## ✨ Features
- **Real-Time Collaboration**: Draw with multiple users simultaneously across different rooms.
- **RAFT Consensus Engine**: Every brush stroke is validated and committed by a 3-node distributed cluster.
- **Mono-Cluster Architecture**: Optimized for cloud deployment by running a full RAFT group within a single high-availability container.
- **RTC Mesh Support**: Hybrid synchronization using WebSockets for persistence and RTC for ultra-low latency peer-to-peer cursors.
- **Advanced Drawing Tools**: Adjustable brush sizes, curated color palettes, history (Undo/Redo), and multi-format exports (PNG, SVG, JSON).
- **Embedded Health Monitoring**: Built-in `/health` dashboard for real-time cluster status.

## 🏗️ Architecture

### 1. Frontend (Vercel)
The UI is a sleek, modern Vanilla JS application. It captures drawing events and coordinates with the Gateway via secure WebSockets (`wss`). It features a "Bulletproof" initialization sequence that handles secure contexts (HTTPS) and modern browser API fallbacks.

### 2. Gateway Master (Railway)
The Gateway acts as the entry point and "Master" process. Upon booting, it automatically spawns 3 internal RAFT replicas on `localhost`. This ensures:
- 100% network connectivity between nodes.
- High-performance internal loopback for consensus votes.
- Simplified single-service cloud deployment.

### 3. The RAFT Cluster
A custom implementation of the RAFT Consensus Algorithm:
- **Leader Election**: Automated election of a "Master" node.
- **Log Replication**: Every drawing action is a "Log Entry" that must be acknowledged by a majority of nodes before it becomes visible.
- **State Machine**: Ensures every user sees the exact same drawing history in the exact same order.

## 🚀 Deployment

### Cloud Setup
- **Frontend**: Automatically deployed to **Vercel** on every push.
- **Backend**: Hosted on **Railway** using the provided `docker-compose.yml`.

### Local Development
To run the full cluster locally:
1. Clone the repository.
2. Run `npm install`.
3. Start the entire cluster using:
   ```bash
   node start-cluster.js
   ```
4. Or start the Gateway Master directly:
   ```bash
   node gateway.js
   ```
5. Open `frontend/index.html` in your browser.

## 🩺 System Health & Live Links
- **Frontend App**: [https://raft-frontend.onrender.com](https://raft-frontend.onrender.com)
- **Cluster Health**: [https://raft-gateway-production.up.railway.app/health](https://raft-gateway-production.up.railway.app/health)
- **WebSocket Gateway**: `wss://raft-gateway-production.up.railway.app`

---
*Created by Antigravity AI for the Mini-RAFT Project.*
