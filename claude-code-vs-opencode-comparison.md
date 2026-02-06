# Claude Code vs OpenCode Feature Comparison
*Last updated: Feb 5, 2026*
*Sources: Official docs, source code analysis, web docs*

## Both have (feature parity or close)

| Feature | Claude Code | OpenCode | Notes |
|---------|-------------|----------|-------|
| Subagents | Explore, Plan, General + custom `.md` | Explore, Plan, General + custom `.md`/JSON | OpenCode also supports JSON config, temperature, top_p, max steps |
| Session management | `/resume`, `/rename`, fork, `--from-pr` | `/sessions`, fork from timeline, rename | OpenCode has timeline UI for forking from any message |
| Undo/Redo | `/rewind`, Esc+Esc (3-way: code/conversation/both) | `/undo`, `/redo` | Both git-based. Claude Code has 3-way rewind options |
| Permission modes | Plan, auto-accept, delegate, bypass, dontAsk | Plan, allow/deny/ask per-tool with glob patterns | OpenCode's per-command bash permissions are more granular (e.g. `"git push": "deny"`) |
| Skills | `.claude/skills/`, YAML frontmatter, auto-invoke | `.opencode/skills/`, YAML frontmatter, `.claude/` compatible | Very similar, both follow Agent Skills standard |
| Custom commands | Skills double as slash commands | `.opencode/commands/` with `$ARGUMENTS`, shell output `!`backtick`` , `@file` refs | OpenCode's command system is more structured (separate from skills) |
| Plugin system | Full marketplace, git-pinned, namespaced, LSP/MCP bundled | npm-based plugins with hooks interface, local file plugins | Claude Code's marketplace is more mature; OpenCode's is code-first |
| Hooks system | 12+ lifecycle events (PreToolUse, PostToolUse, SubagentStart, Stop, etc.), 3 handler types (command/prompt/agent) | Plugin hooks: `tool.execute.before`, `tool.execute.after`, `permission.ask`, `shell.env`, `chat.message`, `session.compacting`, etc. | Different architectures: Claude Code uses settings.json config + shell commands; OpenCode uses JS/TS plugin code |
| Custom tools | Via MCP servers | `.opencode/tools/` with Zod schemas + MCP servers | OpenCode has first-class custom tool files; Claude Code relies on MCP |
| Context info | `/context` colored grid | Header with tokens/% + cost display | Different presentation |
| Compaction | `/compact [instructions]` | `/compact` (plugin-extensible via `experimental.session.compacting`) | Claude Code: user passes focus text. OpenCode: plugins customize prompt programmatically |
| Export/Share | `/export` to file/clipboard, web sessions | `/export` to editor, `/share` to opncd.ai with live sync | OpenCode's sharing with live sync is more polished |
| SDK/Headless | Agent SDK (Python + TS), `-p` mode | REST API + TS SDK + OpenAPI spec, `-p` mode | Both solid. Claude Code has Python SDK too |
| Effort levels | Opus 4.6 slider via `/model` + left/right arrows | `ctrl+t` variant cycling, per-agent config, provider-specific mappings | Both work |
| Custom agents | `.claude/agents/*.md` or `--agents` JSON | `.opencode/agents/*.md` or JSON config with temperature, top_p, steps, color, hidden | Very similar. OpenCode has more config options per agent |
| Todo/Task tracking | `/todos` command, agent creates task items | `todowrite`/`todoread` tools with status, priority | Both have agent-driven task tracking |
| Prompt stash | Ctrl+S save/restore | JSONL-backed stash with browse dialog | Both have it |
| MCP servers | Full MCP support + OAuth | Full MCP support + resources via `@` | Both solid |

## Claude Code has, OpenCode doesn't

| Feature | Description | Complexity to port | Value |
|---------|-------------|-------------------|-------|
| **Background tasks (Ctrl+B)** | Background any running bash/agent, continue prompting, retrieve output via TaskOutput tool. Also works on web with `&` prefix | Medium | High |
| **Task list with dependencies (Ctrl+T)** | Persistent visual task tracker with dependency tracking between tasks, shared across compactions, cross-session via `CLAUDE_CODE_TASK_LIST_ID` | Medium | High |
| **Agent teams** | Multi-instance orchestration: teammates with own context windows, mailboxes for inter-agent messaging, shared task lists with file-locking, delegate mode, plan approval, tmux/iTerm2 split panes | Very High | High |
| **Prompt suggestions** | Auto-suggest next prompt based on context + git history after each response, cache-reusing for minimal cost. Tab to accept | Medium | Medium |
| **Vim mode** | Full modal editing: normal/insert modes, motions (h/j/k/l, w/e/b, f/F/t/T), text objects (iw, aw, i", etc.), operators (d/c/y), repeat (.), indent/dedent | Medium-High | Medium |
| **Chrome integration** | Native messaging to Chrome extension for browser automation, DOM reading, console logs, form filling, GIF recording | High | Medium |
| **Sandboxing** | OS-level filesystem/network isolation for bash (Seatbelt on macOS, bubblewrap on Linux), domain filtering, open-sourced runtime | Very High | Medium-High |
| **PR review status** | Live colored PR status indicator in footer (green=approved, yellow=pending, red=changes requested, gray=draft, purple=merged), updates every 60s | Low | Medium |
| **Persistent agent memory** | Subagent memory that survives across sessions with `user`/`project`/`local` scopes, auto-curated MEMORY.md | Medium | Medium |
| **Auto-memory** | Claude automatically records and recalls memories as it works across sessions | Medium | Medium |
| **Status line** | Custom terminal status bar via `/statusline` showing model, context %, tokens, etc. | Low-Medium | Low-Medium |
| **Compact with user instructions** | `/compact [focus text]` lets user direct what to preserve during compaction | Low | Low-Medium |
| **Reverse search (Ctrl+R)** | Interactive search through command history with highlighted matches | Low-Medium | Low |
| **Session-linked PRs** | Sessions auto-linked to PRs when created via `gh pr create`, resume with `--from-pr` | Low-Medium | Medium |
| **Context fork for skills** | Skills can run in a subagent via `context: fork` frontmatter | Low | Low-Medium |

## OpenCode has, Claude Code doesn't

| Feature | Description |
|---------|-------------|
| **30+ LSP servers** | Auto-installed language servers (TypeScript, Go, Rust, Python, Ruby, C++, Java, Kotlin, etc.) with diagnostics, go-to-definition, hover, references |
| **22+ formatters** | Auto-detected code formatters (prettier, biome, gofmt, rustfmt, ruff, clang-format, etc.) triggered on file edit |
| **33 built-in themes** | Rich theme system with custom JSON themes, syntax highlighting with 50+ scopes, dark/light modes, auto-detection |
| **ACP protocol** | Full Agent Communication Protocol support for IDE/external client integration |
| **Timeline + Fork from timeline** | Visual message timeline dialog, fork session from any historical message point |
| **Session child navigation** | Leader+arrows to cycle through parent/child subagent sessions in TUI |
| **Live share with sync** | Share sessions to opncd.ai with real-time sync (changes push to share URL) |
| **Frecency-based autocomplete** | `@` file suggestions boosted by recency/frequency |
| **Git-based snapshot system** | Separate git repo (in `~/.opencode/data/snapshot/`) for tracking file state with periodic GC |
| **Web + Desktop app** | SolidJS web app + Tauri desktop app with system notifications |
| **Per-command bash permissions** | Glob-based allow/deny/ask for specific bash commands (e.g. `"git push *": "deny"`, `"grep *": "allow"`) |
| **Custom tools (first-class)** | `.opencode/tools/*.ts` files with Zod schemas, any-language execution, context object |
| **Question tool** | Structured multi-question prompts with options during agent execution |
| **Agent config extras** | temperature, top_p, max steps, color, hidden flag, pass-through provider options |
| **Command subtask mode** | Commands can force subagent invocation via `subtask: true` |
| **Model cycling** | F2/Shift+F2 to cycle recent models, favorites cycling |
| **Scroll acceleration** | macOS-style scroll acceleration in TUI |
| **OpenCode Zen** | Curated model marketplace with verified models |
