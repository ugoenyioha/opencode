# OpenCode Feature Porting Tracker
*Started: Feb 5, 2026*
*Source: /tmp/opencode (anomalyco/opencode, dev branch)*
*Comparison: /tmp/claude-code-vs-opencode-comparison.md*

## Status Legend
- [ ] Not started
- [~] In progress
- [x] Complete
- [-] Blocked/Deferred

## Phase 0: Setup
- [x] Run existing test suite, confirm all pass
- [x] Understand build system (bun, turbo)
- [x] Create working branch for changes

## Phase 1: Easy wins (build codebase familiarity)

### 1. Compact with user instructions ✅
- [x] Research: read `session/compaction.ts`, server endpoint, TUI command
- [x] Implement: add optional `instructions` param to `/compact` command
- [x] Implement: pass instructions through to compaction prompt
- [x] Test: unit tests (schema, storage) + integration test (real LLM via Claude Max OAuth)
- [x] Verify: 891 pass, 0 fail
- **Files changed:**
  - `src/session/compaction.ts` - `instructions` in `process()` and `create()`
  - `src/session/message-v2.ts` - `instructions` in `CompactionPart` schema
  - `src/session/prompt.ts` - pass `task.instructions` to `process()`
  - `src/server/routes/session.ts` - `instructions` in `/summarize` endpoint
  - `src/cli/cmd/tui/component/prompt/index.tsx` - handle `/compact [text]` in prompt
  - `packages/sdk/js/src/v2/gen/sdk.gen.ts` - `instructions` in `summarize()` method
  - `test/session/compaction.test.ts` - 3 new schema tests
  - `test/server/session-summarize.test.ts` - 6 new endpoint + storage tests
- **Complexity:** Low
- **Notes:** Verified end-to-end: instructions stored in compaction part AND influenced LLM summary output

### 2. PR review status in TUI
- [-] Deferred: user uses Gitea/GitLab, not GitHub
- **Notes:** Would need Gitea/GitLab API support instead of `gh` CLI

### 3. Session-linked PRs
- [-] Deferred: user uses Gitea/GitLab, not GitHub
- **Notes:** Would need Gitea/GitLab API support

### 4. Context fork for skills
- [-] Skipped: OpenCode already supports this via its existing subagent/task system
- **Notes:** Different mechanism than Claude Code's `context: fork` frontmatter, but same result. Commands support `subtask: true` for subagent execution.

## Phase 2: Medium features (deeper codebase knowledge)

### 5. Prompt suggestions ✅
- [x] Research: read editor/prompt components, understand how responses complete
- [x] Design: background LLM call using small/fast model after agent finishes
- [x] Implement: `SessionSuggestion` module with `generate()` using `Provider.getSmallModel()`
- [x] Implement: Bus event `session.suggestion` → SSE → client store → placeholder text
- [x] Implement: Tab to accept into input, Enter to accept+submit, grayed-out display
- [x] Implement: `experimental.suggestions` config flag (opt-out)
- [x] Test: unit tests (891 pass), type check clean, integration test (real LLM via Google OAuth)
- [x] Verify: end-to-end SSE event received by client
- **Files changed:**
  - `src/session/suggest.ts` - **NEW** - generates suggestions via small model (e.g. `gemini-3-flash`, `claude-haiku-4.5`)
  - `src/session/prompt.ts` - calls `SessionSuggestion.generate()` at loop exit (fire-and-forget)
  - `src/config/config.ts` - `suggestions: z.boolean().optional()` in `experimental` schema
  - `src/cli/cmd/tui/context/sync.tsx` - `session_suggestion` store + SSE event handler + clear on busy
  - `src/cli/cmd/tui/component/prompt/index.tsx` - `suggestion` memo, placeholder display, Tab/Enter handlers
  - `packages/sdk/js/src/v2/gen/types.gen.ts` - `EventSessionSuggestion` type in `Event` union
- **Complexity:** Medium
- **Notes:** Uses `Provider.getSmallModel()` (same as title generation) for cost/speed. Silently skips if model returns empty or session goes busy. Subtask sessions excluded.

### 6. Background bash tasks (Claude Code's Ctrl+B) ✅
- [x] Research: Claude Code backgrounds individual bash commands, not whole sessions
- [x] Design: Approach A - background individual bash tool calls (matches Claude Code behavior)
- [x] Study: PR #9681 (4,878 lines, unmerged) - adapted cleaner version without persistence
- [x] Implement: `src/task/events.ts` - Bus events (task.created, task.output, task.completed, task.killed)
- [x] Implement: `src/task/index.ts` - In-memory TaskManager (adopt, list, get, kill, read, tail, remove)
- [x] Implement: `src/tool/bash.ts` - Foreground process registry + `migrateToBackground()` function
- [x] Implement: `src/tool/process-query.ts` - LLM tool for agents to check on background tasks
- [x] Implement: `src/server/routes/task.ts` - REST API (list, get, output, tail, kill, migrate, foreground)
- [x] Implement: TUI Ctrl+B keybind (context-sensitive: only when session is busy + bash running)
- [x] Implement: `/tasks` command + DialogTasks (list, kill, view output)
- [x] Implement: Toast notification on background task completion
- [x] Test: type check clean, 887 unit tests pass, integration test verified full flow
- **Files changed:**
  - `src/task/events.ts` - **NEW** - Bus event definitions
  - `src/task/index.ts` - **NEW** - TaskManager (in-memory, cleaned up on exit)
  - `src/tool/bash.ts` - Foreground process registry, migration support, callID in metadata
  - `src/tool/process-query.ts` - **NEW** - LLM tool (list, status, read_output, read_last_n, search)
  - `src/tool/registry.ts` - Register ProcessQueryTool
  - `src/server/routes/task.ts` - **NEW** - Task REST API
  - `src/server/server.ts` - Mount TaskRoutes at /task
  - `src/cli/cmd/tui/app.tsx` - /tasks command, toast on task.completed
  - `src/cli/cmd/tui/component/dialog-tasks.tsx` - **NEW** - Tasks dialog with kill/view
  - `src/cli/cmd/tui/routes/session/index.tsx` - Ctrl+B handler
- **Complexity:** Medium
- **Notes:** No persistence (matches Claude Code - tasks die with server). ~500 lines total vs PR #9681's 4,878. Ctrl+B is context-sensitive: only triggers when session busy + bash running, otherwise acts as cursor-left.

### 7. Persistent agent memory ✅
- [x] Research: OpenCode already has AGENTS.md/CLAUDE.md loading, global instructions, contextual loading via resolve()
- [x] Part A: `/memory` command - dialog to list/create/edit memory files in $EDITOR
- [x] Part B: `.opencode/rules/*.md` with path-scoping (like Claude Code's `.claude/rules/*.md`)
- [x] Implement: scan `.opencode/rules/**/*.md` and `.claude/rules/**/*.md` with `gray-matter` frontmatter parsing
- [x] Implement: unconditional rules (no `paths` frontmatter) loaded in system prompt alongside AGENTS.md
- [x] Implement: path-scoped rules (`paths` frontmatter with glob patterns) loaded contextually via resolve() when matching files are read
- [x] Implement: rules cached per-instance, claimed per-message (no duplicate injection)
- [x] Test: 11 new unit tests (unconditional loading, frontmatter stripping, path matching, claiming, compatibility)
- [x] Verify: 922 pass, 0 fail, type check clean
- **Files changed:**
  - `src/session/instruction.ts` - `RuleFile` type, `scanRules()`, `getRules()` cache, rules in `system()` and `resolve()`
  - `src/cli/cmd/tui/component/dialog-memory.tsx` - **NEW** - Memory file browser with $EDITOR support
  - `src/cli/cmd/tui/app.tsx` - `/memory` command registration
  - `test/session/instruction-rules.test.ts` - **NEW** - 11 tests for rules loading
- **Complexity:** Medium
- **Notes:** Supports both `.opencode/rules/` (native) and `.claude/rules/` (compatibility). YAML frontmatter with `paths` field for glob-based scoping. Unconditional rules go in system prompt, path-scoped rules injected as `<system-reminder>` when agent reads matching files.

### 8. Task list with dependencies ✅
- [x] Research: OpenCode todo system (4-field flat list), Claude Code Tasks (full deps), 7 related issues
- [x] Fix #5612: Changed `status` from `z.string()` to `z.enum(["pending","in_progress","completed","cancelled","blocked"])`, `priority` to `z.enum(["high","medium","low"])`
- [x] Implement: `depends_on` optional field (array of todo IDs) in `Todo.Info` schema
- [x] Implement: `blocked` status — auto-set when deps are incomplete, auto-unblocked when deps complete
- [x] Implement: dependency validation — circular dep detection (DFS), strip refs to non-existent IDs, auto-resolve on update
- [x] Implement: TodoItem UI — `⊘` icon for blocked tasks, red color for blocked state
- [x] Fix #5934: Inject incomplete todos into compaction prompt so they survive context compaction
- [x] Update: `todowrite.txt` prompt with dependency instructions + example
- [x] Test: 14 new unit tests (schema validation, auto-block, auto-unblock, chain deps, multiple deps, invalid refs)
- [x] Verify: 936 pass, 0 fail, type check clean
- **Files changed:**
  - `src/session/todo.ts` - `Status` and `Priority` enums, `depends_on` field, `resolveDependencies()`, `hasCircularDeps()`, `hasUnresolvedDeps()`
  - `src/session/compaction.ts` - Inject incomplete todos into compaction prompt context
  - `src/tool/todowrite.txt` - Dependency documentation and example
  - `src/cli/cmd/tui/component/todo-item.tsx` - `statusIcon()` function, blocked/cancelled rendering
  - `test/session/todo.test.ts` - **NEW** - 14 tests
- **Complexity:** Medium
- **Notes:** Also fixes issues #5612 (status validation) and #5934 (todos lost after compaction). Dependency resolution uses AND logic (all deps must complete). Circular deps are warned but not blocked to avoid breaking the LLM flow.

## Phase 3: Complex features

### 9. Auto-memory ✅
- [x] Research: Studied OpenClaw's memory system (vector search, session-memory hooks, pre-compaction memory flush, memory_search/memory_get tools)
- [x] Design: Conservative approach — `memory_save` tool the LLM calls when user explicitly asks to remember something
- [x] Implement: `MemorySaveTool` — writes facts to `.opencode/rules/memory.md` with timestamps
- [x] Implement: Auto-inject via existing rules loading system (#7) — no new code needed, facts load in future sessions automatically
- [x] Also fixed: Todo list now injected into system prompt via `Todo.systemContext()` for reliable persistence across compaction (simpler than compaction prompt hack)
- [x] Test: 5 new unit tests (create file, append, date inclusion, directory creation, instruction system integration)
- [x] Verify: 944 pass, 0 fail, type check clean
- **Files created:**
  - `src/tool/memory-save.ts` - **NEW** - `MemorySaveTool` tool definition
  - `src/tool/memory-save.txt` - **NEW** - Conservative usage instructions
  - `test/tool/memory-save.test.ts` - **NEW** - 5 tests
- **Files changed:**
  - `src/tool/registry.ts` - Register `MemorySaveTool`
  - `src/session/todo.ts` - Added `Todo.systemContext()` for system prompt injection
  - `src/session/prompt.ts` - Inject todos into system prompt every turn
  - `src/session/compaction.ts` - Removed compaction prompt hack (replaced by system prompt injection)
- **Complexity:** Low (conservative approach leverages existing rules infrastructure)
- **Notes:** OpenClaw has much more sophisticated memory (embeddings, SQLite vector search, pre-compaction flush). Can layer those on later. Current approach: LLM writes to `.opencode/rules/memory.md`, rules system loads it automatically.

### 10. Vim mode
- [ ] Research: read `textarea-keybindings.ts`, understand input handling
- [ ] Implement: mode state (normal/insert)
- [ ] Implement: normal mode motions (h/j/k/l, w/e/b, 0/$, gg/G, f/F/t/T)
- [ ] Implement: operators (d/c/y) with motions and text objects
- [ ] Implement: visual indicator of current mode
- [ ] Test: write tests
- [ ] Verify: run test suite
- **Files likely touched:** `cli/cmd/tui/component/textarea-keybindings.ts`, prompt component
- **Complexity:** Medium-High (mechanical but lots of cases)
- **Notes:**

### 11. Compact with user instructions (enhanced) ✅
- [x] Implement: partial compaction with `boundaryMessageID` ("summarize before X")
- [x] Implement: validation that `boundaryMessageID` exists in message list, fallback to full compaction
- [x] Verify: type check clean, integrated with `/compact` command
- **Files changed:**
  - `src/session/compaction.ts` - `boundaryMessageID` param in `process()` and `create()`
- **Complexity:** Low (extension of #1)
- **Notes:** Allows targeting specific conversation ranges for compaction

## Phase 4: Agent teams (the big one) ✅

### 12. Agent teams - primitives ✅
- [x] Design: file-locked JSON state per team under `.opencode/teams/<name>/`
- [x] Design: `TeamMember` schema (name, sessionID, agent, status, model, planApproval)
- [x] Design: `TeamTask` schema (id, content, status, priority, assignee, depends_on)
- [x] Implement: `src/team/index.ts` - `Team` namespace: create, get, list, addMember, removeMember, setMemberStatus, setMemberPlanApproval, setDelegate, findBySession, cleanup. `TeamTasks`: list, update, add, claim, complete, resolveDependencies. File locking via `Lock.write()`.
- [x] Implement: `src/team/events.ts` - 10 Bus events (Created, MemberSpawned, MemberStatusChanged, Message, Broadcast, TaskUpdated, TaskClaimed, PlanApproval, ShutdownRequest, Cleaned)
- [x] Implement: `src/team/messaging.ts` - `TeamMessaging.send()` and `broadcast()` inject synthetic user messages into recipient sessions
- [x] Test: 12 server route tests pass via `bun test`
- [x] Verify: 1030 pass, 0 fail
- **Files created:**
  - `src/team/index.ts` - **NEW** - Team and TeamTasks namespaces
  - `src/team/events.ts` - **NEW** - Schemas and Bus event definitions
  - `src/team/messaging.ts` - **NEW** - Cross-session messaging
  - `src/server/routes/team.ts` - **NEW** - REST API (list, get, tasks, by-session, delegate toggle)
  - `test/server/team-routes.test.ts` - **NEW** - 12 route tests
- **Complexity:** High

### 13. Agent teams - orchestration ✅
- [x] Implement: 9 team tools (team_create, team_spawn, team_message, team_broadcast, team_tasks, team_claim, team_approve_plan, team_shutdown, team_cleanup) behind `OPENCODE_EXPERIMENTAL_AGENT_TEAMS` flag
- [x] Implement: `team_create` with delegate mode (restricts lead to coordination-only by denying bash/write/edit/apply_patch)
- [x] Implement: `team_spawn` — spawns teammate as child session, starts `SessionPrompt.loop()` in background, auto-claims task
- [x] Implement: Plan approval (`require_plan_approval: true`) — teammate starts in read-only mode with write tools denied; lead uses `team_approve_plan` to grant access
- [x] Implement: Multi-model support — `team_spawn` accepts `model` param in `provider/model` format (e.g. `anthropic/claude-sonnet-4-20250514`, `google/gemini-2.5-pro`), validated via `Provider.getModel()` with fuzzy suggestions on error
- [x] Implement: Model resolution priority: explicit param > agent.model > lead's current model > Provider.defaultModel()
- [x] Implement: `team_shutdown` with negotiation (teammate can approve/reject)
- [x] Implement: Child session permission rules (deny team management tools, deny todowrite/todoread)
- [x] Implement: Idle notification when teammate loop finishes
- [x] Implement: `POST /session/:sessionID/team-message` route (follows `shell()` pattern)
- [x] Implement: `SessionPrompt.teamMessage()` function
- [x] Test: team e2e, scenarios, edge cases, integration tests
- [x] Verify: 1030 pass, 0 fail
- **Files created:**
  - `src/tool/team.ts` - **NEW** - 9 team tool definitions (~650 lines)
- **Files changed:**
  - `src/tool/registry.ts` - Register team tools behind flag
  - `src/flag/flag.ts` - `OPENCODE_EXPERIMENTAL_AGENT_TEAMS` dynamic getter
  - `src/session/prompt.ts` - `teamMessage()` function
  - `src/server/routes/session.ts` - `POST /session/:sessionID/team-message`
  - `src/config/config.ts` - `max_turns`, `max_budget_usd` experimental config
- **Complexity:** High

### 14. Agent teams - UI ✅
- [x] Implement: `dialog-team.tsx` — team dialog with member list (status icons), shared tasks, Enter to navigate, `m` for message, `l` to go to lead
- [x] Implement: `TeamBadge` — compact: "Team: name (N active, N idle, N total)" or "memberName @teamName"
- [x] Implement: `TeamStatusBar` — per-member: status icon, model label, plan approval state, current task (truncated), task progress, delegate indicator
- [x] Implement: Shift+Up/Down teammate selection with "Messaging: @name" indicator bar
- [x] Implement: `@teammate` autocomplete with plan approval state and model in description
- [x] Implement: Prompt submit interception — when teammate selected, routes through `POST /session/:sessionID/team-message`
- [x] Implement: `<leader>j`/`<leader>k` teammate navigation, `<leader>w` team dialog, `<leader>d` delegate toggle
- [x] Implement: `/team` slash command, `/delegate` slash command
- [x] Implement: Team event toasts (member status, task claimed, cleanup)
- [x] Implement: SSE handlers for all team events + session.suggestion in sync.tsx
- [x] Test: 11 PTY smoke tests + 10 PTY live tests (all pass)
- [x] Verify: type check clean, all tests pass
- **Files created:**
  - `src/cli/cmd/tui/component/dialog-team.tsx` - **NEW** - Team management dialog
  - `test/tui/pty-harness.ts` - **NEW** - Reusable PTY test harness (bun-pty)
  - `test/tui/tui-smoke.ts` - **NEW** - 11 PTY smoke tests
  - `test/tui/tui-live.ts` - **NEW** - 10 PTY live tests (real Anthropic OAuth)
- **Files changed:**
  - `src/cli/cmd/tui/app.tsx` - Team commands, toasts, session.limit handler
  - `src/cli/cmd/tui/context/sync.tsx` - Team store type (with model field), SSE handlers
  - `src/cli/cmd/tui/routes/session/header.tsx` - TeamBadge, TeamStatusBar
  - `src/cli/cmd/tui/routes/session/index.tsx` - Teammate selection, messaging bar, keybinds
  - `src/cli/cmd/tui/component/prompt/index.tsx` - Tab-to-accept suggestions, team message routing
  - `src/cli/cmd/tui/component/prompt/autocomplete.tsx` - @teammate autocomplete with model info
  - `src/config/config.ts` - Keybinds: team_show, team_next, team_previous, team_delegate
- **Complexity:** Medium-High

### 15. Session guards ✅
- [x] Implement: `max_turns` and `max_budget_usd` in experimental config
- [x] Implement: Toast notifications when limits are reached (via `session.limit` Bus event)
- [x] Implement: 80% budget warning (fires once per session via `budgetWarned` Set)
- [x] Implement: `LimitEvent` BusEvent definition in prompt.ts
- [x] Implement: TUI handler in app.tsx — "Budget Warning" / "Limit Reached" toasts
- [x] Verify: type check clean, 1030 tests pass
- **Files changed:**
  - `src/session/prompt.ts` - `LimitEvent`, `budgetWarned`, guard logic with Bus.publish
  - `src/cli/cmd/tui/app.tsx` - `session.limit` SSE event handler
  - `src/config/config.ts` - `max_turns` (int), `max_budget_usd` (number) in experimental schema
- **Complexity:** Low
- **Notes:** Novel feature — Claude Code doesn't have per-session turn/budget limits. Our implementation: silent loop break + toast notification + server-side log.

## Deferred / Out of scope
- Chrome integration (separate product)
- Sandboxing (design doc at `opencode-sandbox-integration.md`, pending implementation)
- Reverse search (low value)
- Status line (low value)

## Session Log
| Date | Session | Work done | Issues |
|------|---------|-----------|--------|
| Feb 5, 2026 | 1 | Comparison sheet created, tracker created | Wasted time on wrong Go repo |
| Feb 5, 2026 | 1 | Compact with instructions: implemented, tested (unit + integration with real LLM) | Server endpoint tests need Instance cache handling |
| Feb 5, 2026 | 2 | Prompt suggestions: implemented server-side generation, SSE plumbing, TUI display + accept | Initial test showed empty suggestion (trivial prompt); fixed by using small model |
| Feb 5, 2026 | 3 | Prompt suggestions: debugged integration test, switched to small model, verified e2e | Flash model returns short suggestions for trivial convos (acceptable) |
| Feb 5, 2026 | 4 | Background tasks: studied PR #9681, designed leaner approach, implemented full feature | Ctrl+B is context-sensitive (only when session busy). stdin pipe broke cat test (fixed). Route ordering mattered for /foreground vs /:taskId. |
| Feb 5, 2026 | 5 | Persistent memory: /memory command + .opencode/rules/*.md with path-scoping. Fixed compact test on wrong branch. Investigated 200K token limit (Claude Max OAuth restriction, not OpenCode). | context-1m beta header not available on Claude Max subscription. |
| Feb 5, 2026 | 5 | Task dependencies: depends_on field, blocked status, auto-resolve, circular dep detection. Fixed #5612 (enum validation) + #5934 (todos lost after compaction). | Researched Claude Code's new Tasks system (addBlockedBy/addBlocks) and 7 related OpenCode issues. |
| Feb 5, 2026 | 6 | Auto-memory: memory_save tool + todo system prompt injection. Studied OpenClaw's memory system. | Replaced compaction prompt hack with simpler Todo.systemContext() in system prompt. |
