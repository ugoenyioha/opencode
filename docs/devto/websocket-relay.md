# Why We Chose Cloudflare WebSockets over WebRTC for Remote Controlling AI Agents

Building a remote control interface for local AI CLI agents is a notoriously hard problem.

You want a sleek web UI to monitor and control an agent running on a developer's laptop. That laptop is sitting behind strict NATs and corporate firewalls. It has no static IP address. It cannot accept incoming connections.

We needed a way to securely bridge a browser to a local CLI process. We evaluated peer-to-peer and relay architectures. Here is why we ultimately chose a WebSocket relay on Cloudflare over WebRTC.

---

## The NAT Traversal Challenge

A local CLI agent initiates its own outbound connections easily.

Getting a remote web dashboard to talk back to it is the hard part. The dashboard runs in a browser somewhere else. The CLI agent has no publicly routable address. Port forwarding is a non-starter for developer tools.

We needed a system that traverses NAT boundaries reliably and handles real-time state synchronization.

---

## Evaluate WebRTC

WebRTC is the standard for real-time peer-to-peer browser communication.

It handles NAT traversal using STUN and TURN servers. When it works, you get a direct, low-latency, encrypted data channel between the browser and the local process. This sounded perfect for a remote control interface.

The reality of WebRTC outside the browser is painful.

---

## The WebRTC Reality

Running WebRTC inside a Node.js or native CLI process requires heavy C++ dependencies.

Building and distributing cross-platform binaries with WebRTC bindings is a maintenance nightmare. Furthermore, WebRTC connection establishment (ICE negotiation) is slow and complex. In many corporate environments with symmetric NATs, WebRTC fails to establish a direct connection anyway.

When WebRTC fails to find a direct path, it silently falls back to relaying traffic through a TURN server.

---

## Choose Relay Architecture

If WebRTC often falls back to a relay server, why not just build a better relay from the start?

We decided to skip the P2P complexity and build a dedicated relay service. Both the local CLI agent and the remote web dashboard connect out to a central relay via standard WebSockets. WebSockets easily traverse corporate firewalls.

This architecture is simpler to implement and far easier to debug.

---

## Build Bring Your Own Relay

We built a "Bring Your Own Relay" (BYOR) system using Cloudflare Workers.

Cloudflare Workers provide a massive, globally distributed edge network. The CLI agent and the web viewer connect to the nearest edge node. This keeps latency low.

Developers can host their own relay instance on their Cloudflare account for complete privacy.

---

## Handle State With Durable Objects

Relaying real-time messages is easy, but handling state and async RPC is hard.

If the web viewer briefly disconnects, it misses critical state updates from the agent. We solved this using Cloudflare Durable Objects. Durable Objects guarantee strict consistency and provide persistent SQLite storage.

The relay buffers messages and syncs the agent's state so clients can seamlessly reconnect.

---

## Achieve End-to-End Encryption

Routing traffic through a central relay introduces a privacy concern.

The relay server could potentially inspect the command channel. We solved this by implementing true End-to-End (E2E) encryption. The CLI agent and the web dashboard exchange public keys out of band, usually via a shared configuration or a secure link.

All WebSocket messages are encrypted using libsodium before they hit the relay. The Cloudflare Worker only routes opaque ciphertext.

---

## Solve A Hard Problem

Synchronizing real-time state across NAT boundaries is a notoriously hard problem.

By embracing a WebSocket relay over WebRTC, we traded theoretical P2P efficiency for unmatched reliability. Cloudflare Workers and Durable Objects gave us a robust, low-latency infrastructure. E2E encryption ensured we didn't compromise on security.

Our AI agents are now securely controllable from anywhere.
