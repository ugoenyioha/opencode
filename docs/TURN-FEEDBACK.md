# Remote Control Architecture: TURN vs. Relay

Feedback received: "They should have used a TURN like approach with signalling."

## Context
Currently, the `opencode remote-control` feature is built on a "Bring Your Own Relay" (BYOR) model. It uses a centralized Cloudflare Worker with a Durable Object. Both the host CLI and the viewer browser establish persistent WebSockets to this centralized relay, which simply forwards encrypted packets between them.

## The Case for WebRTC / TURN
The feedback suggests moving to a peer-to-peer WebRTC model:
1.  **Signaling Server:** The Cloudflare Worker would be downgraded from a heavy data-forwarder to a lightweight signaling server (just swapping SDP offers/answers and ICE candidates).
2.  **STUN/TURN:** Once signaled, the Host and Viewer would attempt to establish a direct P2P UDP connection using WebRTC. If NATs/firewalls block direct P2P, they would gracefully fall back to relaying traffic through a standard TURN server.

### Advantages of WebRTC/TURN:
*   **Latency:** If a direct P2P connection succeeds, latency drops to theoretical minimums since traffic doesn't need to bounce through a centralized Cloudflare edge node.
*   **Bandwidth Cost:** The central signaling server uses almost zero bandwidth. Even if falling back to TURN, standard STUN/TURN infrastructure is generally cheaper to scale for high-bandwidth operations than Cloudflare Durable Objects.
*   **Decentralization:** True end-to-end routing without relying on a middleman (when P2P succeeds).

### Disadvantages / Why BYOR was chosen first:
*   **Complexity in Node/Bun:** WebRTC is a native browser API. While the Viewer (React/SolidJS) can easily establish a WebRTC `RTCDataChannel`, the Host is a CLI running in Bun/Node. Implementing a robust WebRTC stack in Node requires heavy native bindings (like `node-webrtc` or `werift`), which often complicate cross-platform compilation and binary distribution (a major goal of `opencode`).
*   **Firewall Reality:** In enterprise environments where OpenCode CLI is often run, symmetric NATs and strict UDP firewalls frequently block direct P2P WebRTC anyway, meaning it would fall back to the TURN server 90% of the time. If we are relaying 90% of the time, building a simple, stateless WebSocket relay on Cloudflare is significantly easier to maintain and deploy than a full STUN/TURN cluster (like Coturn).
*   **State Buffering:** Our current Durable Object buffers the last 100 messages. If the Viewer browser refreshes, it immediately catches up. WebRTC data channels are strictly ephemeral; if a peer reconnects, the host CLI would have to detect the new channel and re-transmit the entire state tree itself, increasing host complexity.

## Conclusion
While WebRTC + TURN is technically superior for pure P2P latency, the heavy requirement of native WebRTC bindings in the Bun CLI environment makes it a difficult architectural tradeoff. The current WebSocket Relay is significantly more portable, guarantees connection traversal across strict firewalls (since it's standard HTTP/443), and is easier for users to self-host (just deploying a single Cloudflare Worker). 

If bandwidth or latency becomes a massive bottleneck in the future, transitioning the transport layer to a WebRTC Data Channel while keeping the E2E encryption intact is a viable V2 upgrade.
