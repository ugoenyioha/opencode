# 🚀 Handoff Context: March 2026 Milestone

**If you are a new OpenCode agent reading this, here is the current architectural state of this repository:**

### 1. Remote Control & Networking
* **Architecture:** The Remote Control feature no longer spawns a disconnected background daemon. `RemoteHost` is now initialized directly inside the main `Server` memory space via `/instance/remote/start`. 
* **UI Sync:** The local terminal UI (TUI) and remote web viewer perfectly mirror each other. We use a Bring Your Own Relay (BYOR) model via Cloudflare WebSockets with Durable Object state buffering and E2E encryption.
* **Bug Fixes:** The TUI sync message retention limit has been increased to 200 to prevent eager history eviction. Frontend session caching fallbacks are fully wired in `submit.ts`.

### 2. Session Isolation (The Global State Trap)
* **The Bug:** `opencode -c` used to leak sessions across independent git worktrees and non-git folders because it grouped them under a shared git root hash or a hardcoded `"global"` ID.
* **The Fix:** We ripped out the global fallbacks. Non-git folders now generate deterministic IDs via SHA-256 absolute path hashing (`Project.fromDirectory`). The TUI (`app.tsx`) now applies a strict, context-aware filter to only resume sessions matching the exact physical working directory.

### 3. Agent-to-Agent (A2A) Security & Identity
* **Multi-Hop OBO:** Agents use SPIFFE IDs and JWT Workload Headers to authenticate. We do not use static API keys for agent delegation.
* **Trust Model:** The auth pipeline (`verifyBearerForStrategy`) enforces a strict fail-closed trust model (`OPENCODE_A2A_TRUST_WORKLOAD_HEADER`). 
* **Validation:** All dynamically generated route identifiers are regex-validated (`id.ts`) to prevent path injection and spoofing.

### 4. Documentation & Marketing
* We drafted four deep-dive engineering articles located in `docs/devto/` detailing these milestones (Multi-Hop OBO, Zero-Trust Sandboxing, WebSocket Relays, and The Global State Trap). 

**All tests pass. `dev` is perfectly synced with the `ai-forge` workspace.**
