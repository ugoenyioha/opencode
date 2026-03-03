# Phase 0: Lifecycle & Crash Safety — Production Hardening Architecture

## Context

We are hardening OpenCode (our fork at `/Users/uenyioha/tmp/opencode-ng`) for use as a production runtime — not just a developer tool. This is Phase 0 of a multi-phase production hardening roadmap. Phase 0 addresses the most foundational gaps: the server cannot be gracefully stopped, orphaned sessions are not recovered after a crash, A2A task state is lost on restart, and the WAL file is never cleanly checkpointed on shutdown.

**Branch**: Work on `dev` (the default branch).

**Style Guide**: Follow the project's `AGENTS.md` style — prefer `const`, single-word variable names, avoid destructuring, no `try/catch` where possible, use Bun APIs, rely on type inference.

**Testing**: Tests cannot run from repo root. Run from `packages/opencode`:

```bash
cd packages/opencode && bun test
```

**Build**: After all changes, rebuild the binary:

```bash
bun run packages/opencode/script/build.ts
```

---

## Task 0.1: SIGTERM/SIGINT Handler in `serve` Mode

### Problem

The headless `opencode serve` command (at `packages/opencode/src/cli/cmd/serve.ts`) blocks forever with `await new Promise(() => {})`. The line `await server.stop()` on line 22 is **dead code** — it can never execute. When the process receives SIGTERM (e.g., from Kubernetes, Docker, systemd), it dies immediately with no cleanup. Orphaned child processes (bash tools, MCP servers, LSP servers) persist. The database WAL file is not checkpointed.

### File to Modify

`packages/opencode/src/cli/cmd/serve.ts` (24 lines total)

### Current Code

```ts
import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    if (!opts.unix && !Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = await Server.listen(opts)
    if (opts.unix) {
      console.log(`opencode server listening on unix://${opts.unix}`)
    } else {
      console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    }
    await new Promise(() => {})
    await server.stop()
  },
})
```

### Required Changes

1. Import `Instance` from `../../project/instance`
2. Import `Log` from `../../util/log`
3. Replace the `await new Promise(() => {})` / dead `server.stop()` pattern with a signal-awaiting shutdown mechanism
4. Register handlers for both `SIGTERM` and `SIGINT`
5. The shutdown handler must:
   a. Log the signal received
   b. Call `Instance.disposeAll()` with a 5-second timeout (matching the TUI worker pattern in `worker.ts` line 148-153)
   c. Call `Database.close()` (from Task 0.4 — if implementing in order, just call `server.stop(false)` for now and add the DB close later)
   d. Call `server.stop(false)` — pass `false` to **drain** active connections rather than force-closing them
   e. Call `process.exit(0)`
6. Ensure the shutdown only runs once (guard with a boolean flag) to handle double-SIGINT

### Target Code

```ts
import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Instance } from "../../project/instance"
import { Log } from "../../util/log"
import { Database } from "../../storage/db"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    if (!opts.unix && !Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = await Server.listen(opts)
    if (opts.unix) {
      console.log(`opencode server listening on unix://${opts.unix}`)
    } else {
      console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    }

    let stopping = false
    const shutdown = async (signal: string) => {
      if (stopping) return
      stopping = true
      Log.Default.info("shutdown", { signal })
      console.log(`\nReceived ${signal}, shutting down...`)
      await Promise.race([Instance.disposeAll(), new Promise((resolve) => setTimeout(resolve, 5000))])
      Database.close()
      await server.stop(false)
      process.exit(0)
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"))
    process.on("SIGINT", () => shutdown("SIGINT"))

    await new Promise(() => {})
  },
})
```

### Notes

- The `await new Promise(() => {})` is still needed to keep the handler alive. The signal handlers break out via `process.exit(0)`.
- `Database.close()` is added in Task 0.4. If implementing 0.1 first, skip that call and add it when 0.4 is done.
- The `stopping` guard prevents double-shutdown on rapid Ctrl+C.

### Verification

1. `cd packages/opencode && bun run script/build.ts`
2. Run `opencode serve --port 8080`
3. In another terminal: `kill -SIGTERM <pid>` — verify clean shutdown log, no orphaned processes
4. Run again, press Ctrl+C — verify same clean shutdown
5. Press Ctrl+C twice rapidly — verify no double-shutdown errors

---

## Task 0.2: Orphan Session Detection on Startup

### Problem

If the process crashes mid-tool-execution, tool parts stuck in `status: "running"` or `status: "pending"` remain in that state permanently in SQLite. The processor's cleanup code (at `processor.ts` lines 393-408) only runs on normal loop exit, not on crash. Assistant messages that were in-flight (no `time.completed`) also remain incomplete.

The **team** subsystem already has crash recovery (`Team.recover()` in `packages/opencode/src/team/index.ts` lines 898-966). We need the same for individual sessions.

### New File to Create

`packages/opencode/src/session/recovery.ts`

### Design

Create a `SessionRecovery` namespace with a `recover()` function that:

1. Queries the `part` table for all tool parts where `data` JSON contains `"status":"running"` or `"status":"pending"` (since `data` is a JSON column, use SQLite `json_extract` or query all parts and filter in JS — the simpler approach given Drizzle's JSON column handling)
2. Updates each found part to `status: "error"`, `error: "Process restarted before completion"`, `time: { start: Date.now(), end: Date.now() }`
3. Queries the `message` table for assistant messages where `data->time->completed` is null/missing
4. Sets `time.completed = Date.now()` on those messages
5. Logs a summary: `"session recovery complete"` with count of recovered parts and messages
6. Returns `{ parts: number, messages: number }` for testability

**Implementation approach**: Since `data` is stored as `text({ mode: "json" })`, we can use Drizzle's `sql` template to query with `json_extract`:

```ts
import { sql } from "drizzle-orm"
import { PartTable, MessageTable } from "./session.sql"
import { Database } from "../storage/db"
import { Log } from "@/util/log"

const log = Log.create({ service: "session.recovery" })

export namespace SessionRecovery {
  export async function recover(): Promise<{ parts: number; messages: number }> {
    // Find orphaned tool parts
    const orphaned = Database.use((db) =>
      db
        .select()
        .from(PartTable)
        .where(
          sql`json_extract(${PartTable.data}, '$.type') = 'tool' AND json_extract(${PartTable.data}, '$.state.status') IN ('running', 'pending')`,
        )
        .all(),
    )

    const now = Date.now()
    for (const part of orphaned) {
      const data = part.data as any
      Database.use((db) =>
        db
          .update(PartTable)
          .set({
            data: {
              ...data,
              state: {
                ...data.state,
                status: "error",
                error: "Process restarted before completion",
                time: { start: data.state?.time?.start ?? now, end: now },
              },
            },
            time_updated: now,
          })
          .where(sql`${PartTable.id} = ${part.id}`)
          .run(),
      )
    }

    // Find orphaned assistant messages (no time.completed)
    const incomplete = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant' AND json_extract(${MessageTable.data}, '$.time.completed') IS NULL`,
        )
        .all(),
    )

    for (const msg of incomplete) {
      const data = msg.data as any
      Database.use((db) =>
        db
          .update(MessageTable)
          .set({
            data: {
              ...data,
              time: { ...data.time, completed: now },
            },
            time_updated: now,
          })
          .where(sql`${MessageTable.id} = ${msg.id}`)
          .run(),
      )
    }

    if (orphaned.length > 0 || incomplete.length > 0) {
      log.info("session recovery complete", {
        parts: orphaned.length,
        messages: incomplete.length,
      })
    }

    return { parts: orphaned.length, messages: incomplete.length }
  }
}
```

**Important**: The `data` column type is `PartData` which is `Omit<MessageV2.Part, "id" | "sessionID" | "messageID">`. The `state` field is nested inside this JSON blob. Use `json_extract` for the WHERE clause and reconstruct the full data object for the UPDATE.

### File to Modify

`packages/opencode/src/project/bootstrap.ts`

Add the session recovery call after the existing team recovery block. It should run **before** team recovery (since team recovery may interact with sessions), and it should NOT be fire-and-forget — it should complete before the bootstrap continues, since it's fast (just a few SQL queries).

```ts
// Add import at top:
import { SessionRecovery } from "../session/recovery"

// Add BEFORE the team recovery block (before the `if (Flag.OPENCODE_EXPERIMENTAL_AGENT_TEAMS)` line):
await SessionRecovery.recover().catch((err) => {
  Log.Default.warn("session recovery failed", {
    error: err instanceof Error ? err.message : err,
  })
})
```

### Test

Create `packages/opencode/src/session/recovery.test.ts`:

1. Insert a session, a message (assistant, no `time.completed`), and a tool part with `status: "running"` directly into the test database
2. Call `SessionRecovery.recover()`
3. Assert the part now has `status: "error"` and `error: "Process restarted before completion"`
4. Assert the message now has `time.completed` set
5. Call `recover()` again — assert it returns `{ parts: 0, messages: 0 }` (idempotent)

### Verification

1. `cd packages/opencode && bun test src/session/recovery.test.ts`
2. Manual: Start a long-running bash tool via `opencode serve`, kill -9 the process, restart — verify orphaned parts are cleaned up in logs

---

## Task 0.3: A2A Task Persistence (In-Memory to SQLite)

### Problem

The A2A task store is purely in-memory:

```ts
// packages/opencode/src/plugin/a2a.ts line 76
const taskStore = Instance.state(() => new Map<string, A2ATask>())
```

If the process restarts, ALL A2A task state is lost. For the "Agent as Runtime" thesis (exposing agents as A2A microservices), this means task callers get no response and no error — the task simply vanishes.

### Step 1: Create the Schema

**New file**: `packages/opencode/src/plugin/a2a.sql.ts`

```ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const A2ATaskTable = sqliteTable(
  "a2a_task",
  {
    id: text().primaryKey(),
    context_id: text().notNull(),
    agent_id: text().notNull(),
    session_id: text(),
    state: text().notNull(),
    message: text(),
    artifacts: text({ mode: "json" }).$type<unknown[]>(),
    history: text({ mode: "json" }).$type<unknown[]>(),
    ...Timestamps,
  },
  (table) => [
    index("a2a_task_agent_idx").on(table.agent_id),
    index("a2a_task_context_idx").on(table.context_id),
    index("a2a_task_state_idx").on(table.state),
  ],
)
```

**Note on typing**: The `artifacts` and `history` columns use `unknown[]` as the `$type` to avoid importing the A2A-specific types into the schema file. The actual type enforcement happens in the a2a.ts code that reads/writes these columns. This follows the pattern used by `PartTable.data` which stores `PartData` as JSON.

### Step 2: Register the Schema

**Modify**: `packages/opencode/src/storage/schema.ts`

Add this line:

```ts
export { A2ATaskTable } from "../plugin/a2a.sql"
```

This is **critical** — without this export, Drizzle's schema inference won't include the new table, and `Database.Client()` won't know about it for typed queries.

### Step 3: Generate the Migration

Run from the `packages/opencode` directory:

```bash
bun run db generate --name a2a_task_persistence
```

This will create a new directory under `packages/opencode/migration/` with the migration SQL. Verify the generated SQL creates the `a2a_task` table with the correct columns and indexes.

**If `bun run db generate` doesn't work** (the drizzle.config.ts has a hardcoded path), you may need to run:

```bash
bunx drizzle-kit generate --name a2a_task_persistence
```

### Step 4: Modify the A2A Plugin

**File**: `packages/opencode/src/plugin/a2a.ts`

Replace the in-memory task storage functions (lines 72-103) with SQLite-backed equivalents.

**Remove**:

```ts
const taskStore = Instance.state(() => new Map<string, A2ATask>())
```

**Replace the helper functions**:

```ts
import { Database, eq } from "@/storage/db"
import { A2ATaskTable } from "./a2a.sql"

function getTask(taskId: string): A2ATask | undefined {
  const row = Database.use((db) => db.select().from(A2ATaskTable).where(eq(A2ATaskTable.id, taskId)).get())
  if (!row) return undefined
  return fromRow(row)
}

function setTask(task: A2ATask): void {
  Database.use((db) =>
    db
      .insert(A2ATaskTable)
      .values({
        id: task.id,
        context_id: task.contextId,
        agent_id: task.agentId,
        session_id: task.sessionId,
        state: task.status.state,
        message: task.status.message,
        artifacts: task.artifacts,
        history: task.history,
      })
      .onConflictDoUpdate({
        target: A2ATaskTable.id,
        set: {
          context_id: task.contextId,
          agent_id: task.agentId,
          session_id: task.sessionId,
          state: task.status.state,
          message: task.status.message,
          artifacts: task.artifacts,
          history: task.history,
          time_updated: Date.now(),
        },
      })
      .run(),
  )
}

function transitionTask(task: A2ATask, state: TaskState, message?: string): A2ATask {
  task.status = message ? { state, message } : { state }
  task.updatedAt = Date.now()
  setTask(task)
  return task
}

function listTasks(agentId?: string): A2ATask[] {
  const rows = Database.use((db) => {
    if (agentId) {
      return db.select().from(A2ATaskTable).where(eq(A2ATaskTable.agent_id, agentId)).all()
    }
    return db.select().from(A2ATaskTable).all()
  })
  return rows.map(fromRow)
}

// Convert DB row to A2ATask shape
function fromRow(row: typeof A2ATaskTable.$inferSelect): A2ATask {
  return {
    id: row.id,
    contextId: row.context_id,
    agentId: row.agent_id,
    sessionId: row.session_id ?? undefined,
    status: {
      state: row.state as TaskState,
      message: row.message ?? undefined,
    },
    artifacts: (row.artifacts ?? []) as A2AArtifact[],
    history: (row.history ?? []) as A2AMessage[],
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}
```

**Key considerations**:

- The `A2ATask` type uses `camelCase` fields (`contextId`, `agentId`, `sessionId`, `createdAt`, `updatedAt`). The DB schema uses `snake_case` (`context_id`, `agent_id`, etc.). The `fromRow()` function maps between them.
- `setTask()` uses upsert (`onConflictDoUpdate`) matching the codebase pattern in session/message persistence.
- `transitionTask()` remains mostly the same — it mutates the task object and calls `setTask()`.
- The `artifacts` and `history` fields are stored as JSON blobs. Since these can be large (especially history with many messages), monitor for performance. For Phase 0, JSON storage is acceptable.

### Step 5: Handle Recovery

On startup, tasks in `TASK_STATE_WORKING` or `TASK_STATE_SUBMITTED` state should be transitioned to `TASK_STATE_FAILED` with a message indicating process restart. Add a `recoverTasks()` function:

```ts
function recoverTasks(): number {
  const stuck = Database.use((db) =>
    db
      .select()
      .from(A2ATaskTable)
      .where(sql`${A2ATaskTable.state} IN ('TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED')`)
      .all(),
  )
  const now = Date.now()
  for (const row of stuck) {
    Database.use((db) =>
      db
        .update(A2ATaskTable)
        .set({
          state: "TASK_STATE_FAILED",
          message: "Process restarted before task completion",
          time_updated: now,
        })
        .where(eq(A2ATaskTable.id, row.id))
        .run(),
    )
  }
  if (stuck.length > 0) log.info("a2a task recovery", { failed: stuck.length })
  return stuck.length
}
```

Call `recoverTasks()` during plugin init. The A2A plugin's `init` hook (search for the plugin's `init` function in `a2a.ts`) is where this should go. If there's no explicit init, add it to the `InstanceBootstrap` in `bootstrap.ts` alongside the session recovery.

### Verification

1. `cd packages/opencode && bun run db generate --name a2a_task_persistence` — verify migration SQL
2. `cd packages/opencode && bun test` — verify no regressions
3. Manual: Start `opencode serve`, send an A2A task via HTTP, kill -9 the process, restart, verify the task is still queryable (now in `TASK_STATE_FAILED` state)

---

## Task 0.4: WAL Checkpoint on Shutdown

### Problem

The SQLite database connection is never explicitly closed. The WAL file (`opencode.db-wal`) may grow unbounded during long-running sessions. On clean shutdown, we should checkpoint the WAL (merge it into the main DB file) and close the connection.

### File to Modify

`packages/opencode/src/storage/db.ts`

### Required Changes

Add a `close()` function to the `Database` namespace:

```ts
export function close() {
  try {
    const db = Client()
    db.$client.run("PRAGMA wal_checkpoint(TRUNCATE)")
    db.$client.close()
    log.info("database closed")
  } catch (e) {
    log.warn("database close failed", {
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
```

**Key details**:

- `Client()` returns the Drizzle ORM wrapper (type: `BunSQLiteDatabase<Schema> & { $client: TClient }`)
- `db.$client` is the raw `bun:sqlite` `Database` instance (confirmed by usage at `packages/opencode/src/index.ts` line 94: `Database.Client().$client`)
- `PRAGMA wal_checkpoint(TRUNCATE)` merges the WAL into the main file AND truncates the WAL to zero bytes
- Wrap in try/catch because shutdown may be called when the DB was never opened (e.g., startup failure)

### Integration Points

**1. `packages/opencode/src/cli/cmd/serve.ts`** — Call `Database.close()` in the shutdown handler (Task 0.1):

```ts
Database.close()
await server.stop(false)
```

**2. `packages/opencode/src/cli/cmd/tui/worker.ts`** — Add to the `shutdown()` function, after `Instance.disposeAll()` but before `server.stop()`:

```ts
async shutdown() {
  Log.Default.info("worker shutting down")
  if (eventStream.abort) eventStream.abort.abort()
  await Promise.race([
    Instance.disposeAll(),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
  Database.close()  // <-- ADD THIS
  if (server) server.stop(true)
},
```

Import `Database` at the top of `worker.ts`:

```ts
import { Database } from "@/storage/db"
```

### Verification

1. Run `opencode serve`, perform some operations, then SIGTERM
2. Check that `opencode.db-wal` is empty (0 bytes) or absent after shutdown
3. Run `ls -la ~/.local/share/opencode/opencode.db*` to verify

---

## Execution Order

Execute in this order due to dependencies:

1. **Task 0.4** (WAL checkpoint) — Smallest change, no dependencies. Add `Database.close()` to `db.ts`.
2. **Task 0.1** (SIGTERM handler) — Depends on 0.4 for calling `Database.close()` in shutdown. Modify `serve.ts`.
3. **Task 0.2** (Orphan session recovery) — Independent of shutdown. Create `recovery.ts`, modify `bootstrap.ts`.
4. **Task 0.3** (A2A task persistence) — Largest change. Create schema, migration, modify `a2a.ts`, update `schema.ts`.

## Post-Implementation Checklist

After all four tasks are complete:

- [ ] `cd packages/opencode && bun test` — all existing tests pass
- [ ] `cd packages/opencode && bun run script/build.ts` — binary builds cleanly
- [ ] New test for session recovery passes
- [ ] Manual test: `opencode serve` + SIGTERM = clean shutdown with log output
- [ ] Manual test: `opencode serve` + kill -9 + restart = orphaned parts recovered
- [ ] Verify `~/.local/share/opencode/opencode.db-wal` is small/empty after clean shutdown
- [ ] Migration generated and applied successfully for A2A task table
- [ ] `git diff` review — no unintended changes

## Files Changed Summary

| File                                                     | Action                              | Task |
| -------------------------------------------------------- | ----------------------------------- | ---- |
| `packages/opencode/src/storage/db.ts`                    | Add `close()` function              | 0.4  |
| `packages/opencode/src/cli/cmd/serve.ts`                 | Rewrite with signal handlers        | 0.1  |
| `packages/opencode/src/cli/cmd/tui/worker.ts`            | Add `Database.close()` call         | 0.4  |
| `packages/opencode/src/session/recovery.ts`              | **NEW** — orphan session recovery   | 0.2  |
| `packages/opencode/src/project/bootstrap.ts`             | Add session recovery call           | 0.2  |
| `packages/opencode/src/plugin/a2a.sql.ts`                | **NEW** — A2A task table schema     | 0.3  |
| `packages/opencode/src/storage/schema.ts`                | Export new `A2ATaskTable`           | 0.3  |
| `packages/opencode/src/plugin/a2a.ts`                    | Replace in-memory store with SQLite | 0.3  |
| `packages/opencode/migration/<ts>_a2a_task_persistence/` | **NEW** — generated migration       | 0.3  |
| `packages/opencode/src/session/recovery.test.ts`         | **NEW** — recovery test             | 0.2  |
