# Sandbox Tiering Architecture

OpenCode implements a tiered sandboxing architecture to ensure execution safety for AI agents, particularly when running tools that execute arbitrary code or shell commands. The system supports multiple isolation backends, ranging from lightweight namespaces to full microVMs.

## Isolation Backends

OpenCode supports the following execution backends, configurable via the CLI `--sandbox` flag or the agent configuration:

1. **`bwrap` (Bubblewrap)**
   - **Environment:** Linux
   - **Mechanism:** Uses unprivileged user namespaces to isolate the filesystem, process tree, and network.
   - **Use Case:** Fast, lightweight process isolation. Default for Linux native execution.

2. **`gvisor`**
   - **Environment:** Linux
   - **Mechanism:** Google's application kernel that provides an isolation boundary by intercepting application system calls and acting as the guest kernel.
   - **Use Case:** Stronger isolation against kernel-level vulnerabilities.

3. **`firecracker`**
   - **Environment:** Linux
   - **Mechanism:** AWS's microVM technology utilizing KVM to provision lightweight, fast-booting virtual machines.
   - **Use Case:** Hard multi-tenant isolation, suitable for cloud environments.

4. **`darwin` (Seatbelt)**
   - **Environment:** macOS
   - **Mechanism:** Uses Apple's `sandbox-exec` (Seatbelt) to enforce a strict profile on filesystem and network access.
   - **Use Case:** Default isolation for macOS users.

5. **`wasm`**
   - **Environment:** Cross-platform
   - **Mechanism:** WebAssembly System Interface (WASI) runtime using Extism.
   - **Use Case:** Absolute zero-trust execution of WASM-compiled tools.

## Configuration & Flags

Sandboxing can be globally configured or overridden on a per-agent basis.

- **CLI Flag:** `opencode run --sandbox <type>` (e.g., `--sandbox bwrap`)
- **Agent Override:** Agents can request specific sandbox tiers in their configuration, but the runtime will validate if the requested tier meets the system's minimum security requirements.

## Network and Worktree Isolation

The sandboxing architecture integrates with two new specific isolation features:

- **HTTP Hook Network Isolation:** Egress traffic from tools can be restricted or routed through specific proxies to prevent agents from exfiltrating data or accessing internal APIs unexpectedly.
- **Agent Worktree Isolation:** Agents can be confined to a specific Git worktree or subdirectory. When combined with `bwrap` or `seatbelt`, the runtime mounts the isolated worktree as the _only_ readable/writable directory in the sandbox (`/workspace`), preventing traversal attacks into the user's home directory.

## Execution Safety Limits

To prevent runaway agents, the sandboxing layer enforces strict limits:

- Configurable process timeouts.
- Rate-limiting (backed by Redis or SQLite stores).
- Memory and CPU constraints (enforced via cgroups in `gvisor`/`bwrap` or VM limits in `firecracker`).
