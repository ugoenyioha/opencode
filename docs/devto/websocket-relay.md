# Why We Chose Cloudflare WebSockets over WebRTC for Remote Controlling AI Agents

If you build developer tools, you eventually run into the NAT traversal problem.

We wanted to build a sleek web dashboard to monitor and control local OpenCode CLI agents. The problem: the CLI agent is running on a laptop behind a corporate firewall, and the web viewer is running in a browser somewhere else. The laptop has no static IP and cannot accept incoming connections.

The conventional wisdom for this is WebRTC. We tried it. We hated it. We ripped it out.

Here is why we abandoned WebRTC for a Cloudflare-backed WebSocket Relay architecture—and how we implemented End-to-End encryption and SQLite state buffering to make it bulletproof.

## The WebRTC Mirage

WebRTC is the undisputed king of peer-to-peer browser communication. It uses STUN to figure out your public IP, and ICE to negotiate a direct connection between peers. When it works, you get a beautiful, low-latency, encrypted data channel without routing traffic through a central server.

It sounds perfect. In practice outside the browser, it is a nightmare.

1. **The Native Dependency Hell:** Browsers have WebRTC built-in. Node.js and compiled CLI binaries do not. Pulling in `node-webrtc` or compiling native Google WebRTC C++ bindings into our local agent bloated our binary and created an endless stream of platform-specific build failures.
2. **The Symmetric NAT Trap:** In strict corporate environments, symmetric NATs change the external port for every outbound connection. STUN fails. The WebRTC ICE negotiation fails.
3. **The Silent Fallback:** When WebRTC fails to establish a P2P connection, it falls back to a TURN server to relay the traffic anyway.

If our traffic was going to end up relayed through a central server 40% of the time, why were we paying the massive complexity tax of the WebRTC state machine?

## The WebSocket Relay Pivot

We ripped out the WebRTC code and replaced it with a dead-simple architecture: both the CLI agent and the web viewer make outbound standard WebSocket connections to a central Relay server.

Because both sides are initiating outbound HTTP/Upgrade requests, corporate firewalls rarely block them.

```typescript
// The local CLI connects out to the relay
const relay = new WebSocket(`wss://relay.opencode.local/v1/agent/${session_id}`)

// The Web UI connects out to the same relay
const viewer = new WebSocket(`wss://relay.opencode.local/v1/viewer/${session_id}`)
```

But a naive relay server introduces two new massive problems: **State Synchronization** and **Privacy**.

## Handling State with Cloudflare Durable Objects

If the CLI agent emits a `task_completed` event while the web viewer is refreshing the page (a 1-second disconnect), the event is lost into the void. WebSockets don't guarantee delivery across reconnects.

We couldn't just use Redis; we wanted the relay to be globally distributed so latency remained low no matter where the developer was.

We built the "Bring Your Own Relay" (BYOR) system using **Cloudflare Workers** and **Durable Objects**.

Durable Objects guarantee strict, single-threaded execution for a given entity (like a Session ID). Better yet, they come with embedded SQLite.

```typescript
// Inside the Cloudflare Durable Object
async function handleAgentMessage(msg) {
  // 1. Buffer the message to embedded SQLite
  await this.ctx.storage.sql.exec(`INSERT INTO messages (id, payload) VALUES (?, ?)`, [msg.id, msg.data])

  // 2. Broadcast to connected viewers
  for (const viewer of this.viewers) {
    viewer.send(msg.data)
  }
}
```

When a viewer reconnects, the Durable Object queries the SQLite buffer and replays any missed messages, providing true async RPC guarantees over a flaky connection.

## End-to-End (E2E) Encryption

Routing terminal output through Cloudflare introduces an unacceptable privacy risk. The relay server is in the middle, which means it could theoretically read the agent's output (which might include source code or API keys).

We solved this by treating the Cloudflare relay as a zero-trust dumb pipe.

Before the CLI agent and the web viewer connect to the relay, they establish a shared secret locally. We use `libsodium` to encrypt every WebSocket payload _before_ it leaves the machine.

```typescript
// Agent Side: Encrypt before sending
const nonce = crypto.randomBytes(24)
const ciphertext = sodium.crypto_secretbox_easy(JSON.stringify(payload), nonce, sharedSecret)

relay.send(JSON.stringify({ nonce: nonce.toString("hex"), data: ciphertext }))
```

The Cloudflare Worker never sees the JSON payload. It only sees opaque ciphertext. It buffers the ciphertext into SQLite and broadcasts it to the web viewer, which decrypts it locally in the browser.

## The Takeaway

WebRTC is amazing for video conferencing, but for deterministic CLI-to-Web control channels, it is often a trap.

By embracing a WebSocket relay backed by Cloudflare Durable Objects, we traded theoretical P2P efficiency for absolute connection reliability. By layering `libsodium` on top, we retained the zero-trust privacy that P2P promised.

Sometimes, the simplest network topology is the best one.
