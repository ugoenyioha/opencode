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
