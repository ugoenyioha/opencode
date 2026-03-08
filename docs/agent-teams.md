# Agent Teams — Architecture Documentation

## Overview

Agent Teams enables multi-agent coordination within OpenCode. A **team** is a project-scoped group of AI agent sessions coordinated by a **lead** session. The lead spawns **teammates** (child sessions), assigns **tasks**, and communicates via an **inbox**-based messaging system.

Key concepts:

- **Team** — a named group of sessions working together, stored in the global SQLite database
- **Lead** — the session that created the team; has exclusive access to management tools (spawn, shutdown, cleanup)
- **Teammate/Member** — a child session spawned by the lead with its own agent type, model, and prompt
- **Tasks** — shared work items with priorities, dependencies, and assignees
- **Inbox** — per-member message queue backed by the `team_message` table
- **Delegate mode** — restricts the lead to coordination-only tools (denies bash, write, edit, etc.)
- **Plan approval** — teammates start read-only and must submit a plan before getting write access

Feature flag: `OPENCODE_EXPERIMENTAL_AGENT_TEAMS` (also enabled by `OPENCODE_EXPERIMENTAL`)

## Architecture

### Database Schema

All team state lives in the global SQLite database across three tables plus columns on the `session` table.

#### `team` table

| Column            | Type    | Notes                                               |
| ----------------- | ------- | --------------------------------------------------- |
| `id`              | text PK | Generated ID (`tm_<timestamp>_<random>`)            |
| `project_id`      | text FK | References `project.id`, cascade delete             |
| `name`            | text    | Unique per project (with `project_id`)              |
| `lead_session_id` | text FK | References `session.id`, SET NULL on delete         |
| `delegate`        | boolean | Whether delegate mode is active                     |
| `status`          | text    | `"active"` or `"archived"`                          |
| `time_created`    | integer | Creation timestamp                                  |
| `time_updated`    | integer | Last activity timestamp (touched on messages/tasks) |

Indexes: `team_project_idx`, `team_lead_session_idx`, `team_name_project_idx` (unique).

`lead_session_id` is nullable with SET NULL — teams survive lead session deletion, enabling lead rebinding when a new session connects.

#### `team_task` table

| Column        | Type    | Notes                                                         |
| ------------- | ------- | ------------------------------------------------------------- |
| `id`          | text    | Task identifier (not globally unique)                         |
| `team_id`     | text FK | References `team.id`, cascade delete                          |
| `content`     | text    | Task description                                              |
| `status`      | text    | `pending`, `in_progress`, `completed`, `cancelled`, `blocked` |
| `priority`    | text    | `high`, `medium`, `low`                                       |
| `assigned_to` | text FK | References `session.id`, SET NULL on delete                   |
| `depends_on`  | json    | Array of task IDs this task depends on                        |

**Composite primary key:** `(team_id, id)` — task IDs are unique within a team but not globally.

Indexes: `team_task_team_idx`, `team_task_assigned_idx`, `team_task_status_idx`.

#### `team_message` table

| Column            | Type    | Notes                                            |
| ----------------- | ------- | ------------------------------------------------ |
| `id`              | text PK | Message identifier                               |
| `team_id`         | text FK | References `team.id`, cascade delete             |
| `from_session_id` | text FK | Sender session, cascade delete                   |
| `to_session_id`   | text FK | Recipient session, SET NULL (preserves history)  |
| `content`         | text    | Message body (max 10KB)                          |
| `read_by`         | json    | Array of session IDs that have read this message |

Indexes: `team_message_team_idx`, `team_message_from_idx`, `team_message_to_idx`.

#### Session table columns

| Column          | Type    | Notes                                                         |
| --------------- | ------- | ------------------------------------------------------------- |
| `teammate`      | boolean | Whether this session is a spawned teammate                    |
| `team_id`       | text    | FK to `team.id` (set for both lead and members)               |
| `team_role`     | text    | `"lead"`, `"member"`, or null                                 |
| `plan_approval` | text    | `"none"`, `"pending"`, `"approved"`, `"rejected"`, or null    |
| `team_meta`     | json    | `{ name, agent, status, execution_status?, prompt?, model? }` |

### Event System

The team subsystem publishes events on the global `Bus`:

| Event                   | Trigger                                                 |
| ----------------------- | ------------------------------------------------------- |
| `team.created`          | New team created                                        |
| `team.member.spawned`   | Teammate added to team                                  |
| `team.member.status`    | Member lifecycle transition (ready/busy/shutdown/error) |
| `team.member.execution` | Execution status change within prompt loop              |
| `team.message`          | Direct message sent                                     |
| `team.broadcast`        | Broadcast message sent                                  |
| `team.task.updated`     | Task list modified                                      |
| `team.task.claimed`     | Task atomically claimed by a member                     |
| `team.task.completed`   | Task marked as completed                                |
| `team.teammate.idle`    | Teammate prompt loop ended, now ready                   |
| `team.shutdown.request` | Lead requested teammate shutdown                        |
| `team.plan.approval`    | Lead approved/rejected a plan                           |
| `team.message.read`     | Messages marked as read                                 |
| `team.cleaned`          | Team cleanup completed                                  |

### Lifecycle

```
create(name, leadSessionID)
  -> team row in DB, lead session tagged with team_id/team_role="lead"
  -> TeamEvent.Created

spawnMember(teamName, name, agent, model, prompt)
  -> creates child session with deny rules for team management tools
  -> registers member via addMember() (writes team_meta to session row)
  -> injects context message with team instructions
  -> starts prompt loop (fire-and-forget)
  -> on loop end: transitions to ready/shutdown, notifies lead
  -> TeamEvent.MemberSpawned

work loop
  -> teammate processes messages, claims/completes tasks
  -> messages flow through Inbox (source of truth) + session injection (delivery)
  -> auto-wake: idle sessions restart their prompt loop on incoming messages

shutdown(memberName)
  -> transitions to shutdown_requested
  -> cancels prompt loop (up to 3 retries with 120ms delay)
  -> teammate gets one more loop iteration to wrap up
  -> transitions to shutdown

cleanup(teamName)
  -> verifies all members are shutdown (waits up to 1s for pending transitions)
  -> removes inbox messages, cleans up worktrees
  -> clears session team columns, deletes team row
  -> publishes TeamEvent.Cleaned (triggers lead permission restore)
```

### Member Status State Machine

```
ready ──> busy ──> shutdown_requested ──> shutdown
  │         │              │
  │         │              └──> error ──> ready
  │         └──> error ──> ready
  └──> shutdown_requested ──> shutdown
  └──> error
```

### Execution Status State Machine

```
idle -> starting -> running -> cancel_requested -> cancelling -> cancelled -> idle
                 └> completing -> completed -> idle
                 └> failed -> idle
                 └> timed_out -> idle
```

## API Reference

All endpoints are prefixed with the server's base path (typically `/api/team`).

### `GET /`

List all active teams in the project.

- **Response:** `TeamInfo[]`

### `GET /:name`

Get a team by name.

- **Response:** `TeamInfo` or `404`

### `GET /:name/tasks`

List all tasks for a team.

- **Response:** `TeamTask[]`

### `GET /by-session/:sessionID`

Find which team a session belongs to, including role and tasks.

- **Response:** `{ team: TeamInfo, tasks: TeamTask[], role: "lead" | "member", memberName?: string }` or `null`

### `POST /:name/delegate`

Toggle delegate mode for a team. Adds/removes write tool deny rules on the lead session.

- **Body:** `{ enabled: boolean }`
- **Auth:** Lead only

### `POST /:name/spawn`

Spawn a new teammate.

- **Body:** `{ leadSessionID, name, agent, model?, prompt, claimTask?, requirePlanApproval? }`
- **Response:** `{ sessionID }` (201)
- **Auth:** Lead only

### `POST /:name/message`

Send a direct message between team participants.

- **Body:** `{ sessionID, to, text }`
- **Auth:** Any team member

### `POST /:name/shutdown`

Request a teammate to shut down.

- **Body:** `{ leadSessionID, member }`
- **Auth:** Lead only

### `POST /:name/cleanup`

Clean up team resources after all members are shut down.

- **Body:** `{ leadSessionID }`
- **Auth:** Lead only

### `POST /:name/approve-plan`

Approve or reject a teammate's implementation plan.

- **Body:** `{ leadSessionID, member, approved, feedback? }`
- **Auth:** Lead only

### `GET /:name/messages`

List inbox messages for a session.

- **Query:** `{ sessionID, unread? }`
- **Auth:** Any team member

### `POST /:name/cancel`

Cancel active teammates' prompt loops.

- **Body:** `{ member? }` — omit `member` to cancel all
- **Auth:** Any (no session check currently)

## Configuration

### Server Limits (`server.limits`)

| Setting             | Default       | Description                        |
| ------------------- | ------------- | ---------------------------------- |
| `max_teams`         | 50            | Maximum concurrent active teams    |
| `max_team_members`  | 20            | Maximum teammates per team         |
| `team_max_lifespan` | 21600000 (6h) | Maximum team lifetime in ms        |
| `team_idle_timeout` | 3600000 (1h)  | Maximum idle time before shutdown  |
| `max_team_messages` | 1000          | Maximum pending messages per inbox |

### Keybinds (`keybinds`)

| Setting         | Default     | Description                                   |
| --------------- | ----------- | --------------------------------------------- |
| `team_show`     | `<leader>w` | Show agent team status and tasks              |
| `team_next`     | `<leader>j` | Navigate to next teammate session             |
| `team_previous` | `<leader>k` | Navigate to previous teammate session         |
| `team_delegate` | `<leader>d` | Toggle delegate mode (lead coordination-only) |

## TUI Integration

The TUI displays team state through:

- **Team badge** in the header showing the team name and member count
- **Team status bar** showing current role (lead/member), delegate mode status
- **Keybinds** for navigating between teammate sessions and toggling delegate mode
- **Session list** annotated with team membership and status indicators

## Security Model

### Lead-Only Tools

Only the team lead can use:

- `team_create` — create a new team
- `team_spawn` — spawn teammates
- `team_shutdown` — request teammate shutdown
- `team_cleanup` — remove team resources
- `team_approve_plan` — approve/reject plans

### Member Permission Denials

Teammates are spawned with explicit deny rules for:

- `team_create`, `team_spawn`, `team_shutdown`, `team_cleanup`, `team_approve_plan`
- `todowrite`, `todoread` (prevented from manipulating the lead's todo list)

### Delegate Mode

When enabled, the lead session gets deny rules for all `WRITE_TOOLS`:

- `bash`, `write`, `edit`, `multiedit`, `apply_patch`

This restricts the lead to coordination-only work (reading, searching, messaging teammates).
Permissions are restored when delegate mode is disabled or the team is cleaned up.

### Plan Approval Mode

Teammates spawned with `requirePlanApproval: true`:

1. Start with deny rules on `WRITE_TOOLS` using pattern `*:plan-approval`
2. Can only read, search, and explore the codebase
3. Must send their plan to the lead via `team_message`
4. On approval: deny rules with `*:plan-approval` pattern are removed, unlocking writes
5. On rejection: teammate revises and resubmits

The `*:plan-approval` pattern is intentionally different from `*` — this ensures `PermissionNext.disabled()` doesn't strip these tools from the model's tool list, keeping them visible but denied at execution time.

### API Authorization

All mutating lead-only endpoints verify the caller's session ID matches the team's `lead_session_id` via the `lead()` helper. Message sending verifies the session belongs to the team.

## Recovery & Cleanup

### Auto-Cleanup Flow

1. `Team.autoCleanup()` subscribes to `TeamEvent.MemberStatusChanged`
2. When a member transitions to `"shutdown"`, checks if ALL members are shutdown
3. If so, calls `Team.cleanup()` automatically
4. Cleanup publishes `TeamEvent.Cleaned`, which triggers `onCleanedRestorePermissions()` to remove delegate deny rules from the lead session

### Crash Recovery

`Team.recover()` runs once during bootstrap:

1. Finds all teams with members still in `"busy"` status (stale from server crash)
2. Force-transitions their execution status: `cancelled -> idle`
3. Force-transitions their member status: `ready`
4. Recovers undelivered inbox messages (deduplicates by `inboxMessageId` in part metadata)
5. Injects a system message into the lead session listing interrupted teammates

### Timeout Enforcement

`Team.enforceTimeouts()` runs a 5-minute interval:

1. Reads `team_max_lifespan` and `team_idle_timeout` from config
2. For each active team, checks:
   - **Lifespan:** `now - team.created > lifespan`
   - **Idle:** `now - team.updated > idle`
3. On timeout: cancels all members and transitions them to `shutdown_requested`

### Bootstrap Order

The bootstrap sequence in `project/bootstrap.ts` is order-dependent:

```
1. onCleanedRestorePermissions()  — registers synchronously, ready before recover
2. recover()                      — marks stale members, notifies leads
3. autoCleanup()                  — subscribes AFTER recovery to avoid spurious cleanup
4. enforceTimeouts()              — starts the 5-min interval
```

Steps 3-4 run in `.finally()` after recover completes (whether it succeeds or fails).
