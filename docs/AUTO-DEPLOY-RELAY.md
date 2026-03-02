# Automated Cloudflare Relay Deployment

Feedback received: "Why can't we take care of deploying the Cloudflare worker if you provide an API key and secret?"

## Answer

We absolutely can! The Wrangler CLI provides a programmatic way to deploy workers if provided with a `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

By wrapping Wrangler in a dedicated OpenCode CLI command (e.g., `opencode relay deploy`), we could completely automate the "Bring Your Own Relay" setup process for the user.

### Proposed Flow for Auto-Deployment

1.  **The Trigger**: The user runs `opencode relay deploy` or types `/remote` for the first time.
2.  **API Key Prompt**: The TUI asks the user to input a standard Cloudflare API Token (which they can generate in 1 click from their Cloudflare dashboard).
3.  **Automated Bundling**: OpenCode downloads a pre-compiled bundle of the `packages/relay` worker code (or extracts it from the CLI binary assets).
4.  **Secret Generation**: OpenCode automatically generates the 32-byte cryptographic `JWT_SECRET`.
5.  **Provisioning**: OpenCode uses the Cloudflare API to:
    - Create a new Worker namespace.
    - Inject the generated `JWT_SECRET` as an encrypted binding.
    - Deploy the worker and configure the Durable Object classes.
6.  **Persistence**: OpenCode automatically saves the resulting deployed URL (`https://opencode-relay.<user>.workers.dev`) to the user's global config so they never have to type it again.

### Why wasn't it built in V1?

In the initial implementation, the goal was to prove the secure transport and architectural viability of the E2E-encrypted WebSocket tunnel. We relied on the standard developer workflow (`bunx wrangler deploy`) to isolate the complexity of the transport layer from the complexity of infrastructure provisioning.

Additionally, because the Relay code currently lives alongside the app code in a monorepo, programmatically extracting and deploying _just_ the Relay sub-package from inside a distributed, compiled executable (`opencode` binary) requires a dedicated build-step to bundle the worker as an asset.

This is a fantastic UX improvement and should definitely be the very next iteration of the feature.

## Lifecycle Management & Concurrency

### 1. Can we reuse the relay if we have already automatically created one?

**Yes.** The Relay is completely stateless on the Worker level, and heavily isolated on the Durable Object level. Once deployed, the same `https://opencode-relay.<user>.workers.dev` URL can be reused indefinitely across all your projects. OpenCode saves this URL to your global `~/.config/opencode/opencode.json` file. The next time you type `/remote` in any project, it will automatically reuse the existing Relay.

### 2. How does it work if we have multiple opencode sessions running?

**Complete Isolation via Durable Objects.** The Relay architecture handles concurrency beautifully:

- When you type `/remote` in a specific OpenCode terminal, the CLI generates a completely random, unique `sessionId` (a UUIDv4).
- The Cloudflare Worker uses this `sessionId` to route traffic to a specific **Durable Object instance**.
- Durable Objects are conceptually like isolated mini-servers. If you run `/remote` in Project A and `/remote` in Project B simultaneously, Cloudflare spins up two entirely separate, sandboxed Durable Objects behind the scenes.
- Because the AES-256-GCM encryption key is generated locally by each specific CLI host and never shared with the Relay, even if someone guessed the URL for Project B, they could never decrypt the traffic without the specific `#key=...` fragment from that session.

### 3. Can we tear down the relay if we are not using it?

**Yes, but it is often unnecessary.**
Because Cloudflare Workers and Durable Objects are strictly **serverless and scale-to-zero**, they cost absolutely nothing and consume zero CPU/RAM when no one is actively connected to them. The moment you close your OpenCode terminal or stop the `/remote` session, the WebSockets disconnect, and Cloudflare automatically puts the Durable Object to sleep.

However, for security hygiene, we could easily add an `opencode relay destroy` command. This command would use the stored `CLOUDFLARE_API_TOKEN` to call the Cloudflare API and completely delete the Worker namespace and its associated Durable Object storage, wiping it from the internet entirely.
