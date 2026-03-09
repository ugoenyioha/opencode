# OpenCode Core (`@opencode/core`)

This is the core runtime platform for OpenCode, executing AI agents built with the `ai-forge` ecosystem.

## Installation

```bash
bun install
```

## Running the Application

```bash
bun run index.ts
```

## Advanced Usage

### Remote Control

Securely expose your local OpenCode agent to a remote viewer (requires setting `OPENCODE_EXPERIMENTAL_REMOTE_CONTROL=1`):

```bash
OPENCODE_EXPERIMENTAL_REMOTE_CONTROL=1 bun run index.ts remote-control --relay <your-relay-url> --viewer <your-viewer-url>
```

### Execution Sandboxing

OpenCode supports multiple tiers of execution isolation to protect your host system:

```bash
# Run with Bubblewrap isolation (Linux)
bun run index.ts run --sandbox bwrap

# Run with Apple Seatbelt isolation (macOS)
bun run index.ts run --sandbox darwin

# Run with strict gVisor isolation
bun run index.ts run --sandbox gvisor
```

For more details on sandboxing, worktree isolation, and agent-to-agent (A2A) security, refer to the [main documentation](../../README.md) and [Security policy](../../SECURITY.md).

### Loop scheduler

Schedule a recurring prompt that fires automatically on a timer within the current session:

```bash
# Run a prompt every 5 minutes
/loop 5 check for new issues and summarize them

# Stop all scheduled loops for this session
/loop stop
```

The interval is specified in minutes and must be positive. Each scheduled job is scoped to the session that created it — when the session ends, its jobs are cleaned up automatically. The background ticker checks for due jobs every 30 seconds, so the actual cadence has that much jitter.

### MCP tool deferral

When an MCP server exposes a large number of tools, every tool definition is sent to the AI on each request. This eats into the context window and increases token costs.

Set `OPENCODE_MCP_DEFER_THRESHOLD` to control when tool deferral kicks in. When the total MCP tool count exceeds this threshold (default: `20`), tools that haven't been used in the current conversation are lazy-loaded instead of injected up front.

```bash
# Defer MCP tools when total count exceeds 30
OPENCODE_MCP_DEFER_THRESHOLD=30 bun run index.ts
```

A `tool_search` fallback is automatically registered so the AI can discover deferred tools on demand. It accepts a substring query and returns up to 10 matching tools by name or description.

Tools that the AI has already called in the conversation are always loaded, regardless of the threshold.
