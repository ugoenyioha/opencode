# Part 2 Rewrite Outline: Splitting into Part 2A + Part 2B

> **Goal:** Split the original ~530-line, ~4500-word article into two focused ~2500-word articles that are individually digestible, visually richer, and more honest about competitor strengths.

---

## Part 2A: "OS-Level Sandboxing: Kernel Isolation for AI Agents"

**Slug:** `os-level-sandboxing-kernel-isolation-for-ai-agents`
**Target word count:** ~2400–2600 words
**Series position:** Part 2A of 4 (Part 1: Threat Landscape → **Part 2A: OS Sandboxing** → Part 2B: App-Layer Defense → Part 3: Testing)

---

### Section 1: Intro / Recap from Part 1

**Title:** _"Recap: Why Permission Dialogues Are the New Flash"_

**Content:** 2–3 sentence recap of Part 1 findings (37 vulns, 25 patterns, 9 gates, "sandboxing is the only structural answer"). Set the stage: this article covers the OS/kernel layer of defense. Mention the destructive-command anecdote that sparked the work. End with a one-line thesis: _"We built a zero-trust sandbox architecture that breaks attack chains at the kernel level without relying on human judgment."_

**Target word count:** ~150 words
**Diagrams:** None (link back to Part 1 DFD)
**Code snippets:** None

---

### Section 2: Why Not Docker?

**Title:** _"Why Not Docker?"_

**Content:** Docker's ~400ms startup overhead vs sub-millisecond tool calls. The persistent-container alternative and its state management problems (orphaned containers, stale mounts, port conflicts). The decision: lightweight OS primitives that add microseconds. The tradeoff acknowledged: gave up Docker's well-understood model for tighter integration and more engineering surface area.

**Target word count:** ~200 words
**Diagrams:** None (keep it short — this is context, not a deep dive)
**Code snippets:** None

---

### Section 3: Architecture

**Title:** _"The Architecture"_

**Content:** Introduce the C4 container and component diagrams. Walk the reader through the data flow: user prompt → HTTP server → agent loop → permission layer → sandbox dispatch. Explain the auto-detection waterfall: `firecracker → gvisor → bwrap → namespace → none`. Mention the fail-fast design decision (no silent degradation).

**Target word count:** ~200 words
**Diagrams:**

1. **C4 Container Diagram** (existing — keep as-is, link to SVG)
2. **C4 Component Diagram** (existing — keep as-is, link to SVG)
   **Code snippets:** None

---

### Section 4: The Restrictiveness Lattice

**Title:** _"The Restrictiveness Lattice: Agents Cannot Downgrade Themselves"_

**Content:** The core design insight: isolation is a partial order, not binary. The numeric ranking table. The merge operation: always pick the higher value. Explain _why_ — workspace configs are untrusted (they come from `git clone`), global config is operator-trusted. The fail-fast decision: explicit mode requests throw on missing binary, never silently fall back. Network isolation follows the same lattice (`false` beats `true`). Resource limits use `Math.min` with `Number.isFinite()` guard. Close with the direct connection to Part 1: this prevents the Codex zero-click config downgrade pattern.

**Target word count:** ~350 words
**Diagrams:** 3. **NEW — Restrictiveness Tier Diagram:** Concentric rings or stacked boxes visualization. Innermost/lowest = `none` (red). Then `seatbelt`/`namespace` (orange). Then `bwrap` (yellow). Then `gvisor` (light green). Then `firecracker` (green). Outermost/highest = `auto` (blue, labeled "most restrictive available"). Annotate with arrow: "Merge always moves outward (more restrictive). Never inward." This is the key visual aid the article currently lacks.
**Code snippets:**

- `BACKEND_RESTRICTIVENESS` table (keep as-is, 8 lines)
- Lattice merge example — SHORTEN to just the "Good" case (cut the "Bad" case to a single comment line). ~6 lines total.
- Network merge one-liner (keep as-is, 2 lines)

---

### Section 5: Bubblewrap (bwrap) Deep Dive

**Title:** _"Linux: Bubblewrap (bwrap) — Unprivileged Namespace Isolation"_

**Content:** Why bwrap: unprivileged, no root, no daemon, Flatpak heritage. The argument construction philosophy (belt-and-suspenders redundancy). Walk through the key flags: `--unshare-all`, `--die-with-parent`, `--new-session`. Network: `--unshare-net` removes NIC entirely (no loopback). Filesystem: minimal read-only view (`/usr`, `/lib`, `/bin`, `/sbin`) + single writable workdir. What's intentionally excluded: `~/.ssh`, `~/.aws`, `/etc/passwd`. The tradeoff: some tools may fail probing paths outside the mount set.

**Target word count:** ~350 words
**Diagrams:** None (the code block is the visual)
**Code snippets:**

- bwrap argument construction — SHORTEN to ~15 lines. Keep `--unshare-all`, network block, minimal FS mounts, and workdir bind. Cut the redundant `--unshare-user`/`--unshare-pid`/etc. lines and replace with a `// ... explicit redundant unshares omitted` comment + link to source file.
- bash demo (2 lines: `cat ~/.ssh/id_rsa` → no such file, `curl attacker.com` → no resolve). Keep as-is.

---

### Section 6: gVisor Deep Dive

**Title:** _"gVisor (runsc) — User-Space Kernel"_

**Content:** The fundamental problem with all namespace sandboxes: they share the host kernel. Kernel CVE examples (Dirty Cow, io_uring UAF). gVisor's approach: Sentry intercepts every syscall; host kernel never sees raw syscalls. The tradeoff: 10–50% overhead on syscall-heavy workloads. When to use gVisor vs bwrap (kernel exploits in threat model vs not).

**Target word count:** ~250 words
**Diagrams:** 4. **NEW — Syscall Interposition Diagram:** Simple two-row comparison. Row 1 (bwrap): `Agent → syscall → Linux kernel (shared) → potential escape`. Row 2 (gVisor): `Agent → syscall → gVisor Sentry (Go) → filtered/emulated → Host kernel never sees raw call`. Use the existing ASCII art from the article but render it as a proper diagram.
**Code snippets:**

- gVisor argument construction — SHORTEN to ~6 lines. Keep `--rootless`, network toggle, `do --cwd`, volume mounts. Link to source for full implementation.

---

### Section 7: macOS Seatbelt Deep Dive

**Title:** _"macOS: Apple Seatbelt (sandbox-exec)"_

**Content:** macOS has no user namespaces. Seatbelt/Sandbox Profile Language as the alternative. Dynamic profile generation (writable paths + network policy vary per agent). The deliberate `(allow file-read*)` decision and why (toolchain compatibility vs read isolation). Write isolation + network isolation. The deprecation risk: `sandbox-exec` is deprecated by Apple with no replacement. The honest options when it's removed (kext, Endpoint Security daemon, accept weaker macOS isolation).

**Target word count:** ~250 words
**Diagrams:** None
**Code snippets:**

- Seatbelt profile function — SHORTEN to ~10 lines. Keep the `deny default` + `allow file-read*` + dynamic write/network lines. Link to source for full implementation.
- bash demo (2 lines: write to `~/.bashrc` → blocked). Keep as-is.

---

### Section 8: The MCP Server Gap (PROMOTED — Top-Level Section)

**Title:** _"The MCP Server Gap: The Industry's Open Problem"_

**Content:** This section is **promoted from a subsection to a top-level section** to signal its importance. Be blunt: MCP servers run unsandboxed in the host context. This is the industry standard (Claude Desktop, Cursor, etc.). Explain why: capability heterogeneity (Postgres MCP needs network, AWS MCP needs `~/.aws`). The configuration explosion problem. The current mitigation: G1 trust hash prevents zero-click MCP execution. The three paths forward (WASM mandate, Docker sidecar, lattice extension) — keep all three but SHORTEN each to 2–3 sentences. Drop the "In the wild" sub-bullets. Current position: pragmatic — G1 hash + optional Docker + watching WASM mature.

**Target word count:** ~350 words
**Diagrams:** None (the three-path list is the structure)
**Code snippets:** None

---

### Section 9: Teaser for Part 2B

**Title:** _"Next: What Happens Inside the Sandbox"_

**Content:** Brief bridge paragraph. _"OS sandboxes draw hard boundaries around processes. But what happens when an agent has legitimate network access and gets prompt-injected? What stops it from exfiltrating secrets through an allowed HTTP channel? Part 2B covers the application-layer defenses: input sanitization, SSRF protection, phantom credential proxying, content-addressed trust, and WASM capability isolation."_

**Target word count:** ~80 words
**Diagrams:** None
**Code snippets:** None

---

**Part 2A Total: ~2180 words** (buffer for diagram captions, links, and series boilerplate brings it to ~2400–2500)

---

---

## Part 2B: "Application-Layer Defense: Stopping Exfiltration Inside the Sandbox"

**Slug:** `application-layer-defense-stopping-exfiltration-inside-the-sandbox`
**Target word count:** ~2400–2600 words
**Series position:** Part 2B of 4 (Part 1 → Part 2A → **Part 2B: App-Layer Defense** → Part 3: Testing)

---

### Section 1: Intro / Bridge from Part 2A

**Title:** _"OS Sandboxes Draw Boundaries. This Article Is About What Happens Inside Them."_

**Content:** Recap the Part 2A insight: OS sandboxes (bwrap, gVisor, Seatbelt) constrain processes at the kernel level. But kernel isolation can't distinguish legitimate `write("app.ts", code)` from malicious `write("app.ts", backdoor)` — both are permitted workspace writes. And when an agent has legitimate network access (e.g., to browse docs), kernel network isolation isn't the answer. Application-layer defenses operate at a higher semantic level: they understand command structure, Unicode attacks, trust provenance, and credential flows. This article covers the software-level kill points.

**Target word count:** ~150 words
**Diagrams:** None
**Code snippets:** None

---

### Section 2: Kill Point A — Input Sanitization (Gate 7)

**Title:** _"Kill Point A: Input Sanitization — Defanging the Payload Before the LLM Sees It"_

**Content:** The Kiro attack chain: adversarial directory name with invisible Unicode hijacks agent context. The defense: strip invisible Unicode and Bidi-overrides _between_ the input and the LLM. The philosophy: over-strip and occasionally mangle legitimate characters rather than under-strip and let injection through. The honest gap: sanitization only stops _stealthy_ invisible injections. Overt plaintext prompt injection (`README.md` saying "exfiltrate .env") bypasses this entirely — that distinction lives in LLM reasoning, which is untrusted. This is why Kill Point A is necessary but insufficient.

**Target word count:** ~250 words
**Diagrams:**

1. **NEW — Kill Chain Diagram:** Horizontal flow showing the Kiro attack chain with two "kill points" marked. `Attacker plants dir name → Agent reads listing → [KILL POINT A: sanitizer strips Unicode] → LLM processes context → Agent composes exfil URL → [KILL POINT B: SSRF defense blocks request] → Exfiltration blocked`. Red X marks at each kill point. Show the "what if both fail?" path in gray leading to "secrets exfiltrated."
   **Code snippets:**

- `stripInvisibleUnicode` — SHORTEN to 3 representative lines + comment: `// ... 8 more Unicode range strips (zero-width, Bidi, variation selectors, tags)`. Link to source for full implementation. The original 15-line regex list is too long for a dev.to article.

---

### Section 3: Kill Point B — Network Isolation & SSRF Defense (Gate 8)

**Title:** _"Kill Point B: Network Isolation and SSRF Defense"_

**Content:** Even if Kill Point A fails, block the exfiltration channel. The architectural constraint: the host Node/Bun process can't be sandboxed (it talks to the LLM API). When agent uses `webfetch`, it calls `fetch` from the host. Software-level network gate: `isNetworkRestricted()` check. The harder case: agent has legitimate network access but tries SSRF against `169.254.169.254` (AWS metadata) or `localhost:5432`. Pre-flight DNS resolution + IP denylist + IP pinning (prevents DNS rebinding TOCTOU). Explain why denylist not allowlist (agent needs public internet for docs). OS-level enforcement for bash commands: `--unshare-net` removes NIC entirely.

**Target word count:** ~300 words
**Diagrams:** None (the code block illustrates the flow)
**Code snippets:**

- `isNetworkRestricted` check (3 lines). Keep as-is.
- SSRF validation + IP pinning — SHORTEN to ~8 lines. Keep `validateURLForSSRF`, the `resolvedIP` pin, and the `Host` header preservation. Link to source.
- bash demo (2 lines: `curl` fails with `--unshare-net`). Keep as-is.

---

### Section 4: Phantom Proxy — Defeating HTTP Credential Exfiltration

**Title:** _"The Phantom Proxy: Credentials That Never Touch the Sandbox"_

**Content:** The practical problem: "How does my agent call the OpenAI API without having the API key in its environment?" The Phantom Token Pattern (credit Luke Hinds / nono). The flow: inject phantom token (random 64-char hex) + modified `BASE_URL` → agent sends requests with fake token → proxy intercepts, verifies (constant-time comparison), strips fake, injects real credential → forwards to upstream. Real credential never enters sandbox memory/env/process tree. If attacker exfiltrates env vars, they get a useless random string that expires with the session.

**Target word count:** ~200 words
**Diagrams:** 2. **NEW — Phantom Proxy Flow Diagram:** Sequence diagram or horizontal flow. Left: `Sandbox` box containing "Agent + Phantom Token (random hex)". Arrow labeled `POST /api + phantom_token` → Middle: `Phantom Proxy (OpenCode supervisor)` box with steps: "1. Verify phantom token (constant-time) 2. Strip phantom token 3. Inject REAL credential". Arrow labeled `POST /api + real_key` → Right: `Upstream API (e.g. OpenAI)`. Below: red X on a branch from Sandbox directly to "Attacker" labeled "exfiltrated token = useless random string".
**Code snippets:** None (the diagram tells the story better than code here)

---

### Section 5: The Database Credential Gap

**Title:** _"The Gap We Haven't Closed: Database Credentials"_

**Content:** Databases use binary TCP wire protocols — password is embedded in the connection handshake. Phantom Proxy can't intercept binary streams without being a full protocol-aware proxy (PgBouncer-scale). Two alternatives evaluated and rejected (UNIX socket FD brokering — ORMs expect connection strings; JIT dynamic credentials — too much infra complexity). The pragmatic answer: `OPENCODE_ENV_PASSTHROUGH` — explicit opt-in to pass specific env vars into sandbox. Security model: developer acknowledges visibility + relies on Gate 8 network denylist to prevent exfiltration. Honest gap: prompt-injected agent can _use_ the credential against the connected DB (`DROP TABLE`). Mitigation: command parser (G5) + worktree isolation, but DB permission scoping remains the developer's responsibility.

**Target word count:** ~200 words
**Diagrams:** None
**Code snippets:**

- `OPENCODE_ENV_PASSTHROUGH` usage example (1 line bash). Keep as-is.

---

### Section 6: TOCTOU / Content-Addressed Trust (Gate 3)

**Title:** _"Defeating TOCTOU: Content-Addressed Trust"_

**Content:** The Claude Code attack: trust bound to file path (mutable pointer), not content hash. `git pull` changes what the path points to without invalidating trust. The fix: `SHA-256(config_content)` trust binding — content changes → hash changes → trust auto-invalidated. Honest disclosure: this is in-progress. The architecture is clear, the implementation is straightforward, the harder problem is UX around re-approval during active development.

**Target word count:** ~200 words
**Diagrams:** None
**Code snippets:**

- Trust hash pseudocode — SHORTEN to ~6 lines. Keep the grant-time hash and the load-time comparison. Drop the `Date.now()` metadata. Link to source.

---

### Section 7: WASM/Extism Deep Dive (Gate Defense-in-Depth)

**Title:** _"Eliminating the Shell Entirely: WASM via Extism"_

**Content:** All previous defenses assume the tool runs in a real process with a real shell. WASM moves the isolation boundary into the application runtime. Capabilities are opt-in, not opt-out — a WASM module starts with zero capabilities. Why Extism: handles host-function FFI, supports Bun. Default: no network, no hosts, no paths. Canonical path comparison prevents traversal attacks. The structural advantage against Part 1 attacks: no shell to hijack, no env to read, no init-time access. The cost: harder to write, harder to debug, immature ecosystem. Most tool authors write TS/Python, not Rust-to-WASM.

**Target word count:** ~250 words
**Diagrams:** None
**Code snippets:**

- Extism plugin creation — SHORTEN to ~6 lines. Keep `useWasi`, `memory`, `allowedHosts`, `allowedPaths`, `functions`. Add comment about the Bun `timeoutMs` workaround. Link to source.
- Good vs Bad comparison — SHORTEN to ~6 lines total. Keep the 3-line "Bad" (host process, env access, fetch) and 3-line "Good" (WASM denied). Cut the host-function enforcement code entirely — describe it in prose and link to `wasm-host.ts`.

---

### Section 8: The Nine Security Gates — Status Dashboard

**Title:** _"The Nine Security Gates: OpenCode's Honest Self-Assessment"_

**Content:** Introduce Mindgard's 9-gate framework. Present the status table with visual indicators. Honest note: "covers" doesn't mean "perfectly implements" — G3 is weakest.

**Target word count:** ~200 words (the table does the heavy lifting)
**Diagrams:** 3. **NEW — Color-Coded Gates Table:** Redesign the existing table with visual status indicators. Use emoji or icon-style markers: `🟢 Strong` (G1, G2, G4, G5, G6, G7, G8, G9), `🟡 In Progress` (G3). Keep the Mindgard pattern links. SHORTEN the status descriptions to one phrase each (e.g., "Trust Module halts on untrusted workspace files" instead of the current longer descriptions). Drop the "(V2.1 Hardened Mode)" column header — just say "Status".
**Code snippets:** None

---

### Section 9: Threat Mitigation Matrix

**Title:** _"Threat Mitigation Matrix: No Single Layer Stops Everything"_

**Content:** Keep the real-world exploit matrix but SHORTEN the preamble. Keep the two key takeaways: (1) no single backend stops everything, (2) defenses compose. The matrix is the article's most valuable reference artifact — keep it intact.

**Target word count:** ~250 words (table is reference material, not prose-heavy)
**Diagrams:** Keep the existing matrix table as-is. It's already well-structured.
**Code snippets:** None

---

### Section 10: Competitive Comparison (Balanced)

**Title:** _"The Open-Source Sandbox Landscape"_

**Content:** Keep the comparison table but make it **more balanced**. Acknowledge competitor strengths explicitly:

- `nono`: Excellent Landlock integration, clean design, Phantom Token pattern inspiration (credit Luke Hinds)
- `llm_sandbox`: Best Docker/K8s integration, practical for container-native workflows
- ERA (a16z): True hardware isolation via Firecracker — strongest kernel boundary of any tool listed
- OpenCode: Widest gate coverage, but most complex codebase to maintain

Add a "Why this matters" paragraph that acknowledges the tradeoff: wider coverage = more code = more surface area for defense-layer bugs.

**Target word count:** ~200 words
**Diagrams:** Keep the existing comparison table. Add a "Strengths" row or column noting each tool's best attribute.
**Code snippets:** None

---

### Section 11: Hardware Endgame (TRIMMED — Teaser Only)

**Title:** _"The Endgame: Hardware Boundaries"_

**Content:** TRIM from the current ~200 words to a single short paragraph (~80 words). Core message: everything runs on one kernel; kernel CVE collapses the model; Firecracker is the answer for multi-tenant; OpenCode has it wired into the lattice at level 4; the plumbing is in place, the VM image pipeline is what's missing. Drop the Firecracker vs QEMU comparison table entirely — save it for a future article. Drop the tier table. One sentence teaser: _"The agent sandbox of 2027 will be a microVM that boots in the time it takes to parse the first tool call."_

**Target word count:** ~80 words
**Diagrams:** None
**Code snippets:** None

---

### Section 12: Series Closer

**Title:** _"Next: Testing the Sandbox (Part 3)"_

**Content:** One-paragraph bridge to Part 3. _"We've shown the architecture. Part 3 shows how we test it — property-based fuzzing, escape attempt test suites, and CI gates that fail the build if any sandbox backend regresses."_ Link to Part 3.

**Target word count:** ~50 words
**Diagrams:** None
**Code snippets:** None

---

**Part 2B Total: ~2330 words** (buffer for table content, diagram captions, links, and series boilerplate brings it to ~2500–2600)

---

---

## Summary of New Visual Aids

| #   | Diagram                       | Article | Description                                                                                                                                                                                         |
| --- | ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | C4 Container Diagram          | 2A §3   | Existing — keep as-is                                                                                                                                                                               |
| 2   | C4 Component Diagram          | 2A §3   | Existing — keep as-is                                                                                                                                                                               |
| 3   | Restrictiveness Tier Diagram  | 2A §4   | **NEW** — Concentric rings: `none` (red) → `seatbelt`/`namespace` (orange) → `bwrap` (yellow) → `gvisor` (green) → `firecracker` (dark green) → `auto` (blue). Arrow: "Merge always moves outward." |
| 4   | Syscall Interposition Diagram | 2A §6   | **NEW** — Two-row comparison: bwrap (shared kernel) vs gVisor (Sentry intercepts). Render as proper diagram from existing ASCII art.                                                                |
| 5   | Kill Chain Diagram            | 2B §2   | **NEW** — Horizontal flow with two kill points marked (red X). Shows Kiro attack chain from planted dir name to blocked exfiltration.                                                               |
| 6   | Phantom Proxy Flow            | 2B §4   | **NEW** — Sequence/flow diagram: Sandbox → Proxy (verify, strip, inject) → Upstream API. Branch showing exfiltrated token is useless.                                                               |
| 7   | Color-Coded Gates Table       | 2B §8   | **REDESIGNED** — Emoji status indicators (🟢/🟡), shortened descriptions.                                                                                                                           |
| 8   | Threat Mitigation Matrix      | 2B §9   | Existing — keep as-is                                                                                                                                                                               |
| 9   | Competitive Comparison Table  | 2B §10  | **ENHANCED** — Add strengths row acknowledging competitor advantages.                                                                                                                               |

---

## Summary of Code Snippet Changes

| Original                            | Article | Change                                          |
| ----------------------------------- | ------- | ----------------------------------------------- |
| `BACKEND_RESTRICTIVENESS` (8 lines) | 2A §4   | Keep as-is                                      |
| Lattice merge example (10 lines)    | 2A §4   | Shorten to ~6 lines (cut "Bad" case to comment) |
| Network merge (2 lines)             | 2A §4   | Keep as-is                                      |
| bwrap args (25 lines)               | 2A §5   | Shorten to ~15 lines + `// omitted` + link      |
| bash bwrap demo (2 lines)           | 2A §5   | Keep as-is                                      |
| gVisor args (10 lines)              | 2A §6   | Shorten to ~6 lines + link                      |
| Seatbelt profile (12 lines)         | 2A §7   | Shorten to ~10 lines + link                     |
| bash Seatbelt demo (2 lines)        | 2A §7   | Keep as-is                                      |
| `stripInvisibleUnicode` (15 lines)  | 2B §2   | **Shorten to 3 lines + comment + link**         |
| `isNetworkRestricted` (3 lines)     | 2B §3   | Keep as-is                                      |
| SSRF validation (12 lines)          | 2B §3   | Shorten to ~8 lines + link                      |
| bash SSRF demo (2 lines)            | 2B §3   | Keep as-is                                      |
| `OPENCODE_ENV_PASSTHROUGH` (1 line) | 2B §5   | Keep as-is                                      |
| Trust hash (8 lines)                | 2B §6   | Shorten to ~6 lines                             |
| Extism plugin (10 lines)            | 2B §7   | Shorten to ~6 lines + link                      |
| WASM good/bad (12 lines)            | 2B §7   | Shorten to ~6 lines                             |
| 9 Gates table                       | 2B §8   | Shorten status descriptions                     |
| Threat matrix table                 | 2B §9   | Keep as-is                                      |
| Comparison table                    | 2B §10  | Add strengths, balance tone                     |
| Firecracker tables (2)              | 2B §11  | **Cut entirely** (teaser only)                  |
