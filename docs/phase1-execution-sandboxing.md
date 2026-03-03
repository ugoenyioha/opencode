# Phase 1: Execution Sandboxing — Tiered Architecture

## Overview

Phase 1 adds independent, composable sandboxing tiers to OpenCode. Operators choose which tiers to enable based on deployment model and trust boundary. Multiple tiers can be active simultaneously.

| Tier                    | Mechanism                                               | Protects Against            | Platform                   |
| ----------------------- | ------------------------------------------------------- | --------------------------- | -------------------------- |
| **1A: Container**       | Firecracker / gVisor / Docker+seccomp                   | Entire process compromise   | Any (external to OpenCode) |
| **1B: OS Namespace**    | Linux `unshare` / macOS `sandbox-exec`                  | Bash tool escape (baseline) | Linux, macOS               |
| **1B+: Hardened Linux** | Linux `bubblewrap` + `seccomp` + `landlock` (+ cgroups) | Stronger bash containment   | Linux                      |
| **1C: WASM/WASI**       | Extism SDK                                              | Custom tool plugin escape   | Any (cross-platform)       |

---

## Tier 1A: Container Isolation (External)

This tier requires **zero code changes** to OpenCode itself. It's a deployment concern.

**Deliverable**: A set of container configurations and documentation.

### Files to Create

1. **`deploy/Dockerfile`** — Multi-stage build that produces a minimal OpenCode image
   - Stage 1: Build from `opencode-ng` using `bun run script/build.ts`
   - Stage 2: Copy binary into a minimal base (e.g., `distroless` or `alpine`)
   - Run as non-root user
   - Read-only root filesystem (`--read-only`)
   - No capabilities (`--cap-drop=ALL`)

2. **`deploy/docker-compose.yml`** — Example multi-agent deployment
   - Each agent as a separate service with its own config
   - Shared network for A2A communication
   - Volume mounts for persistent SQLite data

3. **`deploy/gvisor/runsc.toml`** — gVisor configuration for stronger isolation than standard Docker

4. **`deploy/firecracker/`** — Example Firecracker MicroVM configuration (for E2B-style deployments)

5. **`deploy/seccomp-profile.json`** — Seccomp profile that blocks dangerous syscalls (e.g., `ptrace`, `mount`, `reboot`, `kexec_load`)

### Documentation

- How to deploy OpenCode as a container
- How to deploy multiple agents as A2A microservices
- Network policy examples for Kubernetes (default-deny egress)

### Effort: 2-3 days

---

## Tier 1B: OS Namespace Sandboxing (Internal)

This tier modifies OpenCode's bash tool to optionally spawn commands inside an OS-level sandbox. It's the most invasive change and provides the strongest protection for bare-metal deployments.

### Configuration

Add a `sandbox` section to the config schema in `packages/opencode/src/config/config.ts`:

```ts
sandbox: z.object({
  bash: z
    .enum(["none", "namespace", "bwrap", "gvisor", "firecracker", "auto"])
    .optional()
    .describe(
      "Sandbox mode for bash tool. 'firecracker' requires Linux firecracker assets, 'gvisor' requires Linux runsc, 'bwrap' uses bubblewrap (Linux), 'namespace' uses Linux namespaces and maps to sandbox-exec on macOS. 'auto' picks best available. Default: 'none'.",
    ),
  network: z.boolean().optional().describe("Allow network access in sandboxed bash. Default: false."),
  writable: z
    .array(z.string())
    .optional()
    .describe("Additional directories writable inside the sandbox. Project directory is always writable."),
  memory_mb: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Memory limit in MB for sandboxed processes (Linux only, requires cgroups v2). Default: 256."),
  cpu_percent: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("CPU limit as percentage for sandboxed processes (Linux only). Default: 100."),
}).optional()
```

### Files to Create

1. **`packages/opencode/src/sandbox/index.ts`** — Platform detection and sandbox factory

   ```ts
   export namespace Sandbox {
     export type Options = {
       command: string[]
       workdir: string
       network?: boolean
       writable?: string[]
       memory?: number
       cpu?: number
       env?: Record<string, string>
     }

     export function available(): "firecracker" | "gvisor" | "bwrap" | "namespace" | "sandbox-exec" | "none"
     export function spawn(opts: Options): ChildProcess
   }
   ```

   - On Linux: checks in order for Firecracker, gVisor, bubblewrap, then namespace sandbox
   - On macOS: checks for `sandbox-exec` binary
   - Returns `"none"` if nothing available

### Runtime selection semantics (implemented)

- `sandbox.bash: "auto"` degrades by backend availability only.
- Linux auto order is `firecracker -> gvisor -> bwrap -> namespace -> none`.
- Explicit modes are fail-fast. If requested backend is unavailable, command execution errors and does not silently downgrade.

Firecracker availability contract:

- Requires Linux, a Firecracker binary, a runner binary, and kernel/rootfs assets provided via env or filesystem paths.

2. **`packages/opencode/src/sandbox/linux.ts`** — Linux namespace sandbox

   Implementation approach:
   - Generate a shell setup script that:
     - Creates a tmpfs root
     - Bind-mounts `/bin`, `/lib`, `/lib64`, `/usr`, `/etc` read-only
     - Bind-mounts the project workdir (writable)
     - Bind-mounts any additional `writable` paths
     - Creates minimal `/dev` (null, zero, urandom, random)
     - Mounts `/proc` for PID namespace
     - Uses `pivot_root` to switch to the new root
     - Execs the target command
   - Spawns via `child_process.spawn("unshare", [...])` with:
     - `--mount --pid --user --map-root-user --fork --propagation private`
     - `--net` (unless `network: true`)
   - If `memory` or `cpu` are set and `systemd-run` is available, wraps with `systemd-run --user --scope --property=MemoryMax=...`

3. **`packages/opencode/src/sandbox/darwin.ts`** — macOS sandbox-exec sandbox

   Implementation approach:
   - Generates an SBPL profile file:
     - `(deny default)` base
     - `(allow file-read* (subpath "..."))` for project dir, system libs, binary paths
     - `(allow file-write* (subpath "..."))` for project dir and writable paths
     - `(deny network*)` unless `network: true`
     - `(allow process-fork)` and `(allow process-exec ...)` for shell execution
   - Writes profile to a temp file
   - Spawns via `child_process.spawn("sandbox-exec", ["-f", profile, "--", ...command])`

### File to Modify

4. **`packages/opencode/src/tool/bash.ts`** — The bash tool's `spawn()` call

   Current code (line 234):

   ```ts
   const proc = spawn(params.command, {
     shell,
     cwd,
     env: { ...process.env, ...shellEnv.env },
     stdio: ["ignore", "pipe", "pipe"],
     detached: process.platform !== "win32",
   })
   ```

   Modified logic:

   ```ts
   const config = await Config.get()
   const mode = config.sandbox?.bash ?? "none"
   const available = Sandbox.available()

   if (mode === "bwrap" && available !== "bwrap") {
     throw new Error("Sandbox mode 'bwrap' requested but bubblewrap is not available on this platform")
   }
   if (mode === "namespace" && available !== "namespace") {
     throw new Error("Sandbox mode 'namespace' requested but Linux namespace sandbox is unavailable on this platform")
   }
   if (mode === "gvisor" && available !== "gvisor") {
     throw new Error("Sandbox mode 'gvisor' requested but gVisor runsc binary is unavailable on this platform")
   }
   if (mode === "firecracker" && available !== "firecracker") {
     throw new Error(FirecrackerSandbox.unavailableMessage())
   }

   const selectedMode = mode === "auto" ? available : mode

   const proc =
     selectedMode === "none"
       ? spawn(params.command, {
           shell,
           cwd,
           env: { ...process.env, ...shellEnv.env },
           stdio: ["ignore", "pipe", "pipe"],
           detached: process.platform !== "win32",
         })
       : Sandbox.spawnWith(selectedMode as Exclude<Sandbox.Backend, "none">, {
           command: [shell, "-lc", params.command],
           workdir: cwd,
           network: config.sandbox?.network ?? false,
           writable: [cwd, ...(config.sandbox?.writable ?? [])],
           memory: config.sandbox?.memory_mb,
           cpu: config.sandbox?.cpu_percent,
           env: { ...process.env, ...shellEnv.env },
         })
   ```

   Key constraint: The `Sandbox.spawn()` return must be a standard `ChildProcess` so the rest of the bash tool code (stdout/stderr piping, timeout handling, kill tree, foreground process registry) works unchanged.

### Testing

- **Linux**: Test with `unshare` available and unavailable. Test that sandboxed process cannot read files outside workdir. Test that network is blocked by default.
- **macOS**: Test with `sandbox-exec`. Test filesystem restriction. Test network denial.
- **Fallback**: Test that `sandbox: { bash: "auto" }` follows Linux order (`firecracker` -> `gvisor` -> `bwrap` -> `namespace` -> `none`) and returns `"none"` on unsupported platforms.
- **Performance**: Measure overhead of sandboxed vs unsandboxed bash calls (expect ~10-50ms additional for namespace setup).

### Gotchas

- **Debian 11**: `kernel.unprivileged_userns_clone=0` by default. Detection must check this sysctl.
- **Ubuntu 24.04+**: AppArmor restricts unprivileged user namespaces. Detection must verify with a test `unshare` call.
- **macOS `sandbox-exec`**: Deprecated but functional through macOS 15. No replacement exists for CLI use.
- **`detached: true`**: The current bash tool uses detached process groups for kill-tree. Sandboxed processes inside namespaces are already isolated, but the kill-tree logic must still work. Verify `Shell.killTree()` works with sandboxed PIDs.

### Effort: 5-7 days

---

## Tier 1B+: Hardened Linux Sandbox (Internal)

This extends Tier 1B for stronger Linux isolation without requiring full VM/container-runtime isolation.

### Configuration Extension

Extend `sandbox.bash` enum in `packages/opencode/src/config/config.ts`:

```ts
bash: z.enum(["none", "namespace", "bwrap", "gvisor", "firecracker", "auto"]).optional()
```

`auto` selection on Linux uses `firecracker -> gvisor -> bwrap -> namespace -> none`.
Explicit mode requests should fail-fast when the chosen backend is unavailable.

### Files to Create

1. **`packages/opencode/src/sandbox/bwrap.ts`** — Linux hardened sandbox backend
   - Launch via `bwrap`
   - Read-only root/system mounts, writable workspace mounts
   - `--unshare-net` by default unless `sandbox.network: true`
   - `PR_SET_NO_NEW_PRIVS`
   - seccomp filter profile (allow-list syscall set)
   - landlock rules for filesystem scope
   - optional cgroup/systemd resource caps for memory/cpu

2. **`packages/opencode/src/sandbox/index.ts`** — backend selection
   - Add `bwrap` availability detection
   - Route `sandbox.bash = "bwrap"` to Linux hardened backend

3. **`packages/opencode/src/tool/bash.ts`** — no behavior changes beyond honoring new backend mode via existing sandbox dispatch

### Testing

- Verify `bwrap` backend blocks reads outside workspace
- Verify network blocked by default
- Verify seccomp-denied syscall behavior is deterministic
- Verify `auto` fallback (`firecracker` -> `gvisor` -> `bwrap` -> `namespace` -> `none`)

### Effort: 3-5 days

---

## Tier 1C: WASM/WASI Tool Sandboxing (Plugin Isolation)

This tier introduces a new tool format (`.wasm` files) alongside existing `.ts/.js` tools. WASM tools run inside an Extism sandbox with capability-based access control.

### Dependencies

```bash
cd packages/opencode && bun add @extism/extism
```

### Configuration

Add to the `sandbox` section in config:

```ts
sandbox: z.object({
  // ... existing bash options from 1B ...
  wasm: z
    .object({
      memory_pages: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max WASM memory pages per plugin (1 page = 64KB). Default: 256 (16MB)."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max execution time per tool call in ms. Default: 30000."),
      network: z
        .boolean()
        .optional()
        .describe("Allow WASM tools to make HTTP requests via host functions. Default: false."),
    })
    .optional(),
}).optional()
```

### Files to Create

1. **`packages/opencode/src/sandbox/wasm.ts`** — WASM tool runtime

   ```ts
   import createPlugin, { type CallContext } from "@extism/extism"

   export namespace WasmSandbox {
     export type Options = {
       path: string // path to .wasm file
       workdir: string // project directory (for WASI preopens)
       config?: Record<string, string>
       memoryPages?: number
       timeoutMs?: number
       network?: boolean
     }

     export async function call(opts: Options, func: string, input: string): Promise<string>
   }
   ```

   Implementation:
   - Creates an Extism plugin from the `.wasm` file
   - Configures:
     - `useWasi: true`
     - `allowedPaths: { [opts.workdir]: "/workspace" }` — read-only project dir
     - `memory: { maxPages: opts.memoryPages ?? 256 }`
     - `timeoutMs: opts.timeoutMs ?? 30000`
   - Defines **host functions** in the `"extism:host/user"` namespace:
     - `read_file(path)` — reads a file from the project directory (path validated against workdir)
     - `log(level, message)` — structured logging back to OpenCode's logger
     - `fetch(url)` — HTTP request (only if `network: true`, validates against allowlist)
   - Calls `plugin.call(func, input)` and returns the output as a string
   - Closes the plugin after each call (or pools for performance)

2. **`packages/opencode/src/sandbox/wasm-host.ts`** — Host functions for WASM plugins

   Defines the host function implementations. These are the **capabilities** the WASM tool can use:

   ```ts
   export function hostFunctions(opts: { workdir: string; network: boolean }) {
     return {
       "extism:host/user": {
         read_file(cp: CallContext, offs: bigint) {
           const path = cp.read(offs).text()
           // Validate path is inside workdir
           const resolved = resolve(opts.workdir, path)
           if (!resolved.startsWith(opts.workdir)) {
             return cp.store(JSON.stringify({ error: "path outside workspace" }))
           }
           const content = readFileSync(resolved, "utf-8")
           return cp.store(content)
         },
         log(cp: CallContext, levelOffs: bigint, msgOffs: bigint) {
           const level = cp.read(levelOffs).text()
           const msg = cp.read(msgOffs).text()
           log.info("wasm-tool", { level, msg })
         },
         // ... fetch, etc.
       },
     }
   }
   ```

### File to Modify

3. **`packages/opencode/src/tool/registry.ts`** — Add WASM tool loading

   In the `state()` initializer (lines 48-72), alongside the existing `.ts/.js` tool scan, add a scan for `.wasm` files:

   ```ts
   const wasmGlob = new Bun.Glob("{tool,tools}/*.wasm")
   const wasmMatches = await Config.directories().then((dirs) =>
     dirs.flatMap((dir) => [...wasmGlob.scanSync({ cwd: dir, absolute: true, followSymlinks: true, dot: true })]),
   )
   for (const match of wasmMatches) {
     const name = path.basename(match, ".wasm")
     custom.push(fromWasm(name, match))
   }
   ```

   The `fromWasm()` function creates a `Tool.Info` that:
   - Has a generic description (read from a companion `.json` metadata file if present)
   - Accepts a single `input` string argument (or structured args if metadata defines them)
   - Calls `WasmSandbox.call()` in its `execute` method

4. **Optional: `packages/opencode/src/tool/registry.ts`** — Add metadata file support

   For each `.wasm` file, look for a companion `<name>.wasm.json` with:

   ```json
   {
     "description": "Query the project database",
     "args": {
       "query": { "type": "string", "description": "SQL query" }
     },
     "function": "execute"
   }
   ```

   This lets WASM tool authors define the LLM-facing interface separately from the WASM binary.

### WASM Tool Author Workflow

A tool author would:

1. Write a tool in JS/TS using the Extism JS PDK:

   ```ts
   // my-tool/src/index.ts
   function execute() {
     const input = JSON.parse(Host.inputString())
     // ... tool logic, can call Host.getFunctions().read_file() etc.
     Host.outputString(JSON.stringify({ result: "..." }))
   }
   module.exports = { execute }
   ```

2. Bundle and compile:

   ```bash
   esbuild src/index.ts --bundle --format=cjs --target=es2020 --outfile=dist/index.js
   extism-js dist/index.js -i src/index.d.ts -o dist/my-tool.wasm
   ```

3. Drop the `.wasm` file into `.opencode/tools/my-tool.wasm`

4. Optionally add `.opencode/tools/my-tool.wasm.json` for argument schema.

### Testing

- Write a simple "echo" WASM tool that returns its input. Verify it loads and executes.
- Write a WASM tool that tries to read `/etc/passwd` — verify it's blocked.
- Write a WASM tool that tries to make a network request — verify it's blocked when `network: false`.
- Verify `.ts` tools and `.wasm` tools can coexist in the same `tools/` directory.
- Measure latency overhead per call (expect ~5-15ms for Extism instantiation).

### Effort: 3-5 days

---

## Execution Order

1. **Tier 1A** first (container configs) — no code changes, can be done immediately and used for production deploys while 1B and 1C are developed
2. **Tier 1C** next (WASM) — cleanest implementation, fewest touch points, cross-platform from day one
3. **Tier 1B** next (OS namespaces) — baseline internal sandbox path
4. **Tier 1B+** after 1B (Linux hardened backend) — stronger containment for Linux deployments

### Rationale for order:

- 1A is documentation/config only — ship it immediately
- 1C is a new code path (WASM tools) that doesn't modify any existing code — low regression risk
- 1B modifies the existing bash tool's spawn logic — highest regression risk, test most carefully
- 1B+ is additive on top of 1B and keeps existing fallbacks

---

## Files Changed Summary

| File                                         | Action                                    | Tier   |
| -------------------------------------------- | ----------------------------------------- | ------ |
| `deploy/Dockerfile`                          | **NEW**                                   | 1A     |
| `deploy/docker-compose.yml`                  | **NEW**                                   | 1A     |
| `deploy/seccomp-profile.json`                | **NEW**                                   | 1A     |
| `deploy/gvisor/runsc.toml`                   | **NEW**                                   | 1A     |
| `packages/opencode/src/config/config.ts`     | Add `sandbox` config schema               | 1B, 1C |
| `packages/opencode/src/sandbox/index.ts`     | **NEW** — platform detection, factory     | 1B     |
| `packages/opencode/src/sandbox/linux.ts`     | **NEW** — Linux namespace sandbox         | 1B     |
| `packages/opencode/src/sandbox/darwin.ts`    | **NEW** — macOS sandbox-exec sandbox      | 1B     |
| `packages/opencode/src/sandbox/wasm.ts`      | **NEW** — Extism WASM runtime             | 1C     |
| `packages/opencode/src/sandbox/wasm-host.ts` | **NEW** — Host functions for WASM plugins | 1C     |
| `packages/opencode/src/tool/bash.ts`         | Modify spawn to optionally use sandbox    | 1B     |
| `packages/opencode/src/tool/registry.ts`     | Add `.wasm` tool loading                  | 1C     |
| `package.json`                               | Add `@extism/extism` dependency           | 1C     |
