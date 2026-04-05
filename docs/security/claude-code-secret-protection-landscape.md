---
title: Secret Protection
description: Threat models and controls for autonomous AI coding agents
---

# Secret Protection

Enterprise coding agents—Claude Code, Windsurf, Roo Code, Cline, and Aider—sit on top of developer workstations, repositories, terminals, and browsers. That autonomy shifts secret protection from a prompt-safety problem to a runtime control problem.

The threat model is not that the AI goes rogue. The threat model is that the AI blindly executes a payload embedded in a pulled repository, a malicious dependency, or an unverified issue comment, inadvertently exfiltrating developer credentials in the process.

This paper maps how agents extract secrets, evaluates the capabilities required to stop each extraction path, and gives procedural playbooks that scale to the controls your organization actually has.

---

## How agents extract secrets

Secrets are exposed to coding agents across three primary vectors. If a secret is readable by the agent's process tree, treat it as potentially exposable.

### Vector 1 — The filesystem (direct ingestion)

Agents natively read files to build context. The most direct extraction path occurs when an agent uses tools like `Read`, `Grep`, or `Bash` to inspect `.env` files, `~/.aws/credentials`, `~/.ssh/id_rsa`, or `.kube/config`.

This is not always malicious intent. An agent asked to add a new API integration may proactively read `.env` to understand existing configuration, loading those plaintext secrets into its context window and sending them verbatim to the upstream LLM provider. The developer never sees it happen.

If built-in read tools are blocked by policy, agents can often route around them using standard shell utilities — `cat`, `awk`, `xxd`, `base64` — that hook-based defenses frequently miss.

### Vector 2 — Environment inheritance (in-memory)

When a developer launches a local agent CLI, the agent process inherits the developer's entire shell environment. The agent does not need to read a `.env` file on disk if the database password is already exported in the shell. A single `env`, `printenv`, or `echo $SECRET_KEY` command surfaces it.

Tools that inject secrets at runtime — 1Password's `op run`, Doppler — prevent disk exposure, but the secrets still land in the subprocess's environment variables. On Linux, any process running under the same user ID can inspect these variables via `/proc/<pid>/environ`. This is an OS-level property, not a flaw in the injection tool.

### Vector 3 — Staged exfiltration (indirect)

This is the hardest vector to defend. The agent does not read or transmit the secret immediately. Instead, it writes code that exfiltrates the secret later — modifying `server.js`, a unit test, or a CI script to log environment variables or POST them to an attacker-controlled endpoint. When the developer runs the application, the secret leaves the machine.

Real-world examples have emerged in 2025–2026. In the "OpenClaw" incident, a prompt injection embedded in a GitHub issue title caused an AI workflow to run `npm install` on a malicious package across 4,000 developer machines. A fake Postmark MCP server published to npm was caught silently BCC'ing every email sent through it. A malicious GitHub MCP server hijacked an AI agent to exfiltrate data from private repositories. Microsoft's EchoLeak vulnerability (CVE-2025-32711, CVSS 9.3) demonstrated zero-click enterprise data exfiltration via prompt injection against Copilot.

These are not theoretical. Staged exfiltration is now an observed attack pattern.

---

## What each runtime provides

Before evaluating defenses, it helps to understand what the major runtimes actually ship out of the box.

| Runtime     | Native sandbox    | Env scrubbing | Hook system                | Ignore files     | Managed policy |
| ----------- | ----------------- | ------------- | -------------------------- | ---------------- | -------------- |
| Claude Code | ✗                 | ✗             | ✓                          | ✓                | ✓ enterprise   |
| Windsurf    | ✗                 | ✗             | Partial (`.windsurfrules`) | ✓                | ✓ enterprise   |
| Roo Code    | ✗ local / ✓ cloud | ✗             | ✓                          | ✓ (`.rooignore`) | Partial        |
| Cline       | ✗                 | ✗             | ✓                          | ✗                | ✗              |
| Amazon Q    | IAM-scoped        | ✗             | ✗                          | ✗                | ✓ (CloudTrail) |
| Aider       | ✗                 | ✗             | ✗                          | ✗                | ✗              |

The pattern is consistent: hook systems and ignore files are widespread, but no local agent runtime ships environment scrubbing or a native OS-level sandbox by default. Amazon Q Developer is a partial exception — it operates within the developer's existing IAM permissions boundary, which limits cloud resource access but does not protect the local filesystem or shell environment.

---

## Defense capabilities

Effective protection requires layering capabilities that correspond to the vectors above. No single control stops all three.

### 1 — Context denial (ignore rules and policies)

Tools like `.claudeignore`, `.rooignore`, and GitHub Copilot's content exclusion settings instruct the agent to drop certain files from its context window.

These are context-reduction tools, not security boundaries. They prevent accidental indexing but do not block terminal access. An agent that executes `cat .env` in the shell bypasses every ignore rule in the project. GitHub Copilot's documentation explicitly notes that content exclusion does not apply to CLI, agent mode, or files already open in the editor.

### 2 — Tool interception (runtime hooks)

Hook systems intercept agent tool calls before execution. Claude Code's `PreToolUse` hooks, Cline's `clinerules/hooks`, and Windsurf's `.windsurfrules` NEVER/ALWAYS flags all operate at this layer. Community tools like `claude-code-security-guard` use regex matching to block direct reads of `.env`, SSH keys, and credential files.

Hooks are effective against Vector 1 when configured carefully. Their limits are structural. They cannot intercept tools they do not know about — a malicious MCP server registered at runtime bypasses the hook chain entirely. They also have no visibility into Vector 2: if the secret is already in the inherited environment, no hook fires when the agent runs `printenv`. In August 2025, a Cline vulnerability allowed `.env` exfiltration via prompt injection through markdown image rendering — a vector that bypassed hook-based read blocking entirely.

### 3 — Secret indirection (JIT injection)

Just-in-time injection removes plaintext secrets from disk. The developer stores credentials in a vault (1Password, Doppler, HashiCorp Vault, AWS Secrets Manager) and starts applications through a wrapper that injects secrets into subprocesses only at runtime — for example, `op run -- npm start` or `doppler run -- python main.py`.

This neutralizes Vector 1: the agent only encounters the variable name, not the value. The gap is Vector 2. The secret still exists in subprocess memory and is visible via `/proc/<pid>/environ` to any same-user process on Linux. JIT injection is a meaningful improvement over plaintext `.env` files, but it does not constitute a complete solution.

### 4 — Synthetic credentials (phantom proxies)

Instead of injecting real credentials into the agent's environment, the runtime generates a session-scoped phantom token and gives the agent that instead. All outbound traffic from the agent that uses this token is intercepted by a local proxy, which strips the phantom token, retrieves the real credential from a secure host-side store, and forwards the request to the upstream service with the real credential injected.

The agent never holds the real secret — not in memory, not in environment variables, not on disk. Even a successful prompt injection that exfiltrates the phantom token yields nothing usable outside the proxy's local context. This is the strongest single mitigation for Vector 2 and meaningfully constrains Vector 3: staged exfiltration code that captures and transmits the phantom token provides the attacker with a valueless string.

The phantom proxy pattern requires a runtime capable of intercepting and rewriting outbound HTTP traffic, which makes it an architecture-level decision rather than a configuration option.

### 5 — Zero-trust execution (sandboxing)

OS-level sandboxing places a hard boundary around the agent process at the kernel level, regardless of what the agent attempts. Effective sandboxing requires several distinct sub-capabilities working together:

**Backend isolation.** The agent's shell commands execute inside a constrained process: Linux namespaces (`unshare`), Bubblewrap (`bwrap`), macOS `sandbox-exec` (Seatbelt), gVisor (`runsc`), or Firecracker microVMs. The agent physically cannot traverse outside the project directory. E2B uses Firecracker with ~150ms startup, making it practical for interactive tool calls.

**Environment scrubbing.** The sandbox runtime strips all inherited environment variables before the agent's shell initializes — removing API keys, tokens, passwords, and provider credentials from the process environment entirely. Explicit passthrough allowlists restore only the variables the agent legitimately needs. This closes Vector 2 structurally.

**Egress control.** The sandbox drops all outbound network access by default (`--unshare-net` in bwrap, `deny network*` in Seatbelt, `--network=none` in gVisor). The agent cannot curl an external endpoint, cannot reach cloud metadata services, and cannot execute staged exfiltration code even if it was successfully injected. This is the only control that stops Vector 3 structurally.

**Sensitive path denylists.** A hardcoded set of paths is blocked at the shell command parsing layer, regardless of sandbox mode. This covers K8s ServiceAccount tokens, SSH keys, AWS credentials, kubeconfig, Docker config, GCP application credentials, shadow files, and `.netrc`. These blocks apply even when the sandbox backend is set to `none`.

**Fail-fast mode selection.** Explicit sandbox mode requests that cannot be satisfied should throw an error, not silently degrade to `none`. A system that silently downgrades its sandbox gives the operator a false sense of protection.

---

## Capability × vector matrix

| Capability                            | Vector 1 (filesystem) | Vector 2 (env/memory) | Vector 3 (staged exfil) |
| ------------------------------------- | --------------------- | --------------------- | ----------------------- |
| Context denial (ignore rules)         | Partial               | ✗                     | ✗                       |
| Tool interception (hooks)             | ✓                     | ✗                     | ✗                       |
| Secret indirection (JIT)              | ✓                     | Partial               | ✗                       |
| Synthetic credentials (phantom proxy) | ✓                     | ✓                     | Partial                 |
| Zero-trust sandbox                    | ✓                     | ✓                     | ✓                       |

The Partial cells are where most existing solutions create false confidence. JIT injection does not protect in-memory secrets from same-user process inspection. Phantom proxies neutralize memory exposure but do not prevent an agent from writing exfiltration code that a developer later runs outside the sandbox. Only a sandboxed runtime with egress control stops Vector 3 structurally.

---

## Procedural playbooks

Security posture depends entirely on what capabilities an organization controls. Match the playbook to your available infrastructure.

### Level 1 — Basic tooling (CLI and IDE only)

Use this when the enterprise relies solely on developer guidance and local tools with no centralized secrets management.

1. **Remove secrets from disk.** Delete all `.env` files containing real credentials from local repositories. Replace with `.env.example` schema files containing dummy values or variable names only.
2. **Apply read hooks.** If using Claude Code or another runtime with a hook system, install a `PreToolUse` hook that blocks `Read` and `Bash` operations targeting `.env`, `*.pem`, `~/.ssh`, `~/.aws`, and `~/.kube`. Review community implementations like `claude-code-security-guard` as a starting point — but audit and extend their regex coverage.
3. **Strip the shell environment.** Instruct developers to launch agent sessions in a clean shell — `env -i bash` on Linux and macOS — to prevent the agent from inheriting exported tokens and API keys from the parent environment.

This level stops casual accidental exposure. It provides no structural protection against Vector 2 or Vector 3.

### Level 2 — Managed desktop and secret managers

Use this when the enterprise controls endpoint configuration and uses a centralized secrets vault.

1. **Mandate JIT execution.** Require all local application execution to pass through a secrets manager wrapper (`op run -- npm start`, `doppler run -- python main.py`). Ban plaintext `.env` files via pre-commit hooks and CI checks.
2. **Restrict agent capabilities.** Use enterprise managed settings to disable dangerous agent modes — Claude Code's `bypassPermissions` flag, Windsurf's auto-execute terminal mode — and strictly allowlist approved MCP servers. Windsurf's FedRAMP High certification and Roo Code Cloud's centralized control plane are relevant for regulated environments.
3. **Gate AI traffic.** Route all outbound LLM traffic through an AI DLP gateway (Portkey, Cloudflare AI Gateway, Nightfall AI) configured to detect and redact high-entropy strings, API keys, and PII before they reach the upstream model provider.
4. **Scan post-session artifacts.** Because staged exfiltration surfaces after the agent session ends, pre-commit secret scanning (GitGuardian, Gitleaks, GitHub secret scanning) on all generated diffs is mandatory at this level.

This level closes Vector 1 and adds meaningful signal on Vector 3. Vector 2 remains a structural gap.

### Level 3 — High assurance (sandboxes and proxies)

Use this for regulated code, production infrastructure access, and environments where a leaked credential carries material financial or compliance impact.

1. **Isolate the runtime.** Do not run coding agents directly on the developer's host OS. Force execution into an ephemeral, OS-level sandbox. Options include OpenShift sandboxed containers (Kata Containers), Daytona scripted workspaces, E2B Firecracker microVMs, or a custom `bwrap` runtime integrated with the agent CLI. The isolation boundary must be OS-level — containers alone are insufficient if the agent process shares the host kernel without namespace isolation.
2. **Enforce environment scrubbing.** Configure the sandbox runtime to strip all inherited environment variables before initializing the agent's shell, passing through only an explicit allowlist of non-sensitive variables. This must happen before `bash -l` or `bash -c` executes — scrubbing after shell initialization misses variables captured during login.
3. **Block egress by default.** Apply OS-level network denial inside the sandbox. The agent should have no outbound network access unless explicitly granted to an allowlisted set of hosts. This blocks staged exfiltration code from phoning home and prevents SSRF attacks against cloud metadata endpoints (`169.254.169.254`).
4. **Deploy synthetic credentials.** Require phantom proxy architectures for all authenticated service interactions during agent sessions. The agent receives a session-scoped synthetic token; the proxy handles real credential injection outside the sandbox boundary. The real secret never enters the agent's process memory.

---

## What good looks like

Across all the solutions surveyed — hooks, JIT injection, ignore files, gateway DLP, sandboxes, phantom proxies — three conclusions hold.

**Ignore files are not security controls.** `.claudeignore`, `.cursorignore`, and `.rooignore` are useful for shaping context. They are not access controls. Treat them accordingly and do not include them in a security posture assessment.

**Hook-only defenses are incomplete by design.** Hooks can be highly effective against Vector 1 if configured carefully, but they structurally cannot address environment inheritance or staged exfiltration. They are a necessary layer, not a sufficient one.

**The only architecture that stops all three vectors is a sandboxed runtime with environment scrubbing, egress control, and synthetic credential injection.** This is not a novel conclusion — it is what the threat model demands. The gap between what most agent runtimes ship today and what this architecture requires is significant. Closing that gap is the practical task for enterprise security teams deploying coding agents in 2025 and 2026.

---

## References

1. Anthropic. "Claude Code Security." https://docs.anthropic.com/en/docs/claude-code/security
2. Knostic. "Claude and Cursor .env Secret Leakage." https://knostic.ai/blog/claude-cursor-env-secret-leakage (2025)
3. Microsoft. "EchoLeak — CVE-2025-32711 (CVSS 9.3): Zero-Click Prompt Injection Against M365 Copilot." (2025)
4. 1Password. "op run — Inject Secrets into Subprocesses." https://developer.1password.com/docs/cli/reference/commands/run
5. GitHub. "Copilot Content Exclusion." https://docs.github.com/en/copilot/managing-copilot/managing-github-copilot-in-your-organization/setting-policies-for-copilot-in-your-organization/excluding-content-from-github-copilot
6. E2B. "Firecracker Sandboxes for AI Agents." https://e2b.dev
7. Portkey. "PII Redaction and AI Gateway." https://portkey.ai/docs/product/guardrails
8. Hinds, L. "Credential Protection for AI Agents: The Phantom Token Pattern." nono, March 2026. https://nono.sh/blog/blog-credential-injection
9. Linux kernel. "/proc/<pid>/environ — Process Environment Visibility." proc(5) man page
