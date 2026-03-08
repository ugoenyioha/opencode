# OpenCode Core — Agent Guidelines

## Context Within `ai-forge` Workspace

This is the `opencode-ng` repository, which contains the source code for the OpenCode core runtime platform.
It has been moved into the `ai-forge` workspace because `ai-forge` heavily modifies and relies on it during development.

- **Runtime Engine:** `opencode-ng` acts as the execution engine for all AI agents built with `ai-forge`. The `ai-forge` CLI generates configurations (`opencode.json`), skills, and plugins that are loaded and run by the `opencode` binary built from this repository.
- **Dynamic Capabilities:** The `ai-forge` CLI relies on `opencode-ng` to self-report its available features (via the `opencode debug deploy-manifest` command). This command introspects the Zod schemas in `src/config/config.ts` to export the supported configuration surface (e.g., A2A, tool-endpoints, auth strategies, etc.).
- **Key Directories:**
  - `packages/opencode/`: The main application package containing the CLI, the HTTP server (`serve`), routing, and core business logic.
  - `packages/opencode/src/config/config.ts`: The central schema definition for all configurations. Modifications to agent modes, A2A settings, or server capabilities usually start here.
  - `packages/opencode/src/cli/cmd/debug/deploy-manifest.ts`: The command used by `ai-forge` to dynamically discover supported features.
- **Development Workflow:**
  - You can test modifications by running the local Bun runner: `bun run --conditions=browser ./src/index.ts <command>` from within `packages/opencode/`.
  - When testing `ai-forge` against local changes made here, you typically run `ai-forge` with the `OPENCODE_BIN` wrapper script that points to this local instance.

---

## Existing OpenCode Instructions

- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Agent Teams

Multi-agent coordination feature that lets a lead session spawn and orchestrate teammate sessions.

- **Feature flag:** `OPENCODE_EXPERIMENTAL_AGENT_TEAMS` (also enabled by `OPENCODE_EXPERIMENTAL`)
- **Source:** `packages/opencode/src/team/` (core logic), `packages/opencode/src/server/routes/team.ts` (HTTP API), `packages/opencode/src/tool/team.ts` (tool definitions)
- **Tests:** `packages/opencode/test/team/` — run with `bun test test/team` from `packages/opencode`
- **Architecture docs:** `docs/agent-teams.md`

### Database

Teams are stored in the global SQLite database:

- **`team`** — one row per active team. `lead_session_id` is nullable with SET NULL (teams survive lead session deletion for rebind).
- **`team_task`** — shared task board. **Composite PK:** `(team_id, id)` — task IDs are unique per team, not globally.
- **`team_message`** — inbox messages between participants. `read_by` is a JSON array of session IDs.
- **`session`** columns — `team_id`, `team_role` (`"lead"` | `"member"`), `team_meta` (JSON: name, agent, status, execution_status, prompt, model), `teammate` (boolean), `plan_approval` (`"none"` | `"pending"` | `"approved"` | `"rejected"`)

### Bootstrap Lifecycle

Order matters — defined in `packages/opencode/src/project/bootstrap.ts`:

```
1. onCleanedRestorePermissions()  — registers event listener for permission restore
2. recover()                      — marks stale busy members as ready, notifies lead
3. autoCleanup()                  — subscribes to MemberStatusChanged for auto-cleanup
4. enforceTimeouts()              — starts 5-min interval checking lifespan/idle limits
```

Steps 3-4 run in `.finally()` after recover to avoid spurious cleanup during recovery.
