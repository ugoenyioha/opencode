<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent — extended fork.</p>

---

> **This is a fork of [anomalyco/opencode](https://github.com/anomalyco/opencode)** with additional features ported from Claude Code and new capabilities not yet available upstream. It tracks the upstream `dev` branch and is intended for personal use and experimentation.

---

## What's different in this fork

This fork adds **14,000+ lines** across **58+ files**, introducing features that bring OpenCode closer to parity with Claude Code while taking advantage of OpenCode's multi-model, provider-agnostic architecture.

### Agent Teams (experimental)

Coordinate multiple agents working in parallel, each with their own session, model, and context window. A lead agent spawns teammates, distributes work via a shared task list, and teammates communicate through bidirectional messaging.

- Fire-and-forget spawning — lead stays interactive while teammates work in parallel
- Auto-wake — teammates automatically wake the lead when they finish or encounter errors
- Peer-to-peer messaging between any team members (not just lead)
- Shared task list with dependencies, priorities, and status tracking
- Multi-model support — mix Claude, Gemini, OpenAI, and local models on the same team
- Live sidebar showing task progress and real-time tool activity per teammate

Enable with `OPENCODE_EXPERIMENTAL_AGENT_TEAMS=1`.

[Documentation](https://github.com/ugoenyioha/opencode/blob/dev/packages/web/src/content/docs/agent-teams.mdx)

### Background Tasks

Move long-running bash commands to the background with `Ctrl+B` so you can keep working. Output is buffered, and the agent can query task status and results at any time.

- Send any running bash command to the background mid-execution
- Task badge in the session header shows running task count
- Query, search, and read task output through dedicated tools
- Up to 5 MB output buffer per task

[Documentation](https://github.com/ugoenyioha/opencode/blob/dev/packages/web/src/content/docs/background-tasks.mdx)

### Persistent Memory

The agent remembers preferences, project conventions, and important context across sessions through a `memory_save` tool and instruction file hierarchy.

- `memory_save` tool writes facts to `.opencode/rules/` for automatic loading in future sessions
- `/memory` command to browse and manage saved memories in the TUI
- Loads instructions from `AGENTS.md`, `.opencode/AGENTS.md`, `CLAUDE.md`, and global `~/.opencode/AGENTS.md`

[Documentation](https://github.com/ugoenyioha/opencode/blob/dev/packages/web/src/content/docs/memory.mdx)

### Prompt Suggestions

Context-aware suggestions appear after the agent finishes a response, showing natural follow-up actions. Accept with the `Right arrow` key.

### Todo List with Dependencies

Structured task tracking with `pending`, `in_progress`, `completed`, `cancelled`, and `blocked` states. Tasks can declare dependencies on other tasks, and blocked tasks automatically unblock when dependencies complete. The sidebar displays active todos.

### Session Guards

Configurable `max_turns` and `max_budget` limits per agent to prevent runaway sessions.

### Resizable Sidebar with Team View

The sidebar now includes a collapsible Team section showing task trees or member lists with live tool activity spinners. The sidebar is resizable via a drag handle on its left edge (up to 75% of terminal width), and the width persists across sessions.

---

## Building from source

```bash
# Clone
git clone https://github.com/ugoenyioha/opencode.git
cd opencode

# Install dependencies
bun install

# Build (requires bun 1.3.8+, or temporarily relax the check in packages/script/src/index.ts)
cd packages/opencode
bun run build --single --skip-install

# Install the binary
cp dist/opencode-darwin-arm64/bin/opencode /usr/local/bin/opencode
```

### Running tests

```bash
cd packages/opencode
bun test --timeout 60000    # Unit tests (1045 pass)
bun run typecheck            # Type checking
```

---

## Upstream

This fork tracks [anomalyco/opencode](https://github.com/anomalyco/opencode) on the `dev` branch. Upstream features, bug fixes, and improvements are periodically merged in.

For upstream documentation, installation, and community resources, see the [official OpenCode docs](https://opencode.ai/docs).

---

## Key differences from upstream OpenCode

| Feature | Upstream | This fork |
|---------|----------|-----------|
| Agent teams | Not available | Multi-model parallel teams with shared tasks |
| Background tasks | Not available | Ctrl+B to background any running command |
| Persistent memory | Not available | memory_save tool + /memory browser |
| Prompt suggestions | Not available | Context-aware follow-up suggestions |
| Todo dependencies | Not available | Blocked/unblocked task states |
| Session guards | Not available | max_turns and max_budget limits |
| Sidebar team view | Not available | Live task tree + teammate activity |
| Resizable sidebar | Fixed width | Drag handle, persisted width |

---

## Original README

For the original upstream README content including installation via package managers, desktop app, agents overview, and FAQ, see the [upstream repository](https://github.com/anomalyco/opencode).

---

**Upstream:** [anomalyco/opencode](https://github.com/anomalyco/opencode) | **Docs:** [opencode.ai/docs](https://opencode.ai/docs) | **Discord:** [opencode.ai/discord](https://opencode.ai/discord)
