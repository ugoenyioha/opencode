# HTTP Hook Network Isolation Architecture

## 1. Where Hooks Currently Execute HTTP Requests

- **`WebFetchTool`**: Uses native `fetch(params.url)` directly in `packages/opencode/src/tool/webfetch.ts`.
- **Plugin Loading & External Webhooks**: In `packages/opencode/src/plugin/index.ts`, external HTTP hooks and remote skills use standard `fetch` or the built-in HTTP client.
- **Config Fetching**: Remote configs (e.g., `.well-known/opencode`) use global `fetch`.
  Currently, these all run in the main OpenCode host process. Because they bypass `BwrapSandbox` and `FirecrackerSandbox`, they do not respect `config.sandbox.network` restrictions.

## 2. How Sandbox Networking Limits Egress

- **BwrapSandbox** (`packages/opencode/src/sandbox/bwrap.ts`): Toggles network via `--unshare-net` (disabled) or `--share-net` (enabled). It completely unshares the network namespace at the OS level.
- **FirecrackerSandbox** (`packages/opencode/src/sandbox/firecracker.ts`): Passes `--network disabled|enabled` to the VM runner.
- **Limitation**: The host Node/Bun process running OpenCode is never constrained by these backends. When `sandbox.network` is false, `bash` is restricted but the agent can still exfiltrate data by calling the `webfetch` tool or using plugin HTTP hooks because they run on the unconstrained host network.

## 3. Changing Hook Execution (Porting Claude Code's Fix)

Claude Code resolved this by establishing a proxy and routing all host-level hook `fetch` requests through it to enforce the sandbox network boundaries. To implement this in OpenCode:

1. **Network Policy Dispatcher**: Introduce a custom wrapper around global `fetch` or a dedicated HTTP proxy agent that evaluates the current `config.sandbox.network` setting.
2. **Block or Route**: If `sandbox.network === false` (and a sandbox mode is active), any `fetch` call originating from an agent tool (like `webfetch` or plugin HTTP calls) must fail or be routed according to policy.
3. **HTTP Proxy Agent Injection**: If OpenCode implements network proxying (similar to Claude Code's MITM/SOCKS bridge), use `https-proxy-agent` and inject the proxy URL into `fetch()` calls to enforce domain whitelisting and egress logs.
4. **Execution alternative**: For maximum consistency with existing backends, the fetch request for tools like `webfetch` could be evaluated inside a short-lived `Sandbox.spawn` worker process. This guarantees it natively inherits the OS-level namespace restrictions (e.g., `bwrap --unshare-net`) without proxying overhead.
