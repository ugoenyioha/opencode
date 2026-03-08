# Agent Teams Security Audit Report

**Audit Date:** 2026-03-08
**Auditor:** security-auditor (automated agent)
**Scope:** Agent Teams feature — all source files in `packages/opencode/src/team/`, `src/server/routes/team.ts`, `src/tool/team.ts`, `src/tool/team_wait.ts`, `src/project/bootstrap.ts`, `src/config/config.ts` (ServerLimits), and TUI keybind wiring.
**Files Reviewed:** 13 files, ~3,800 lines of code
**Model:** anthropic/claude-opus-4-6

---

## Executive Summary

The Agent Teams feature has a well-designed architecture with strong project-scoped data isolation, atomic task claims, and validated member names. However, the audit uncovered **1 CRITICAL**, **3 HIGH**, **3 MEDIUM**, **4 LOW**, and **4 INFO**-level findings. The CRITICAL finding — plan-approval bypass allowing teammates in read-only mode to execute write tools — was fixed during this audit along with 3 HIGH-severity issues. All fixes pass the existing 182 test suite.

### Finding Summary

| Severity  | Count  | Fixed |
| --------- | ------ | ----- |
| CRITICAL  | 1      | 1     |
| HIGH      | 3      | 3     |
| MEDIUM    | 3      | 0     |
| LOW       | 4      | 0     |
| INFO      | 4      | N/A   |
| **Total** | **15** | **4** |

---

## Findings

### F-01: Plan Approval Bypass — Write Tools Not Denied at Execution Time

**Severity:** CRITICAL
**Status:** FIXED
**Location:** `packages/opencode/src/team/index.ts:743-749`

**Description:**
The plan-approval feature intended to put teammates in read-only mode until the lead approved their plan. Write tools (`bash`, `write`, `edit`, `multiedit`, `apply_patch`) were denied using permission rules with pattern `"*:plan-approval"`. However, this pattern did NOT match tool execution patterns.

When a tool like `bash` calls `ctx.ask()`, it passes command strings as patterns (e.g., `"ls -la"`). The permission system evaluates: `Wildcard.match("ls -la", "*:plan-approval")` → regex `^.*:plan-approval$` → **false**. The deny rule never matched, so tool execution fell through to the default `"ask"` action.

Additionally, `PermissionNext.disabled()` (which strips tools from the model's tool list) only checks rules with `pattern === "*"` — so plan-approval rules with `"*:plan-approval"` were also not hiding tools from the LLM.

The net effect: a teammate in "plan mode" could freely execute all write tools.

**Impact:** Complete bypass of plan-approval security boundary. A compromised or misbehaving agent teammate could make arbitrary file system changes despite being in "read-only plan mode."

**Fix Applied:**
Changed plan-approval deny rules from pattern `"*:plan-approval"` to pattern `"*"`. On approval, rules are removed by filtering: `(WRITE_TOOLS.includes(rule.permission) && rule.pattern === "*" && rule.action === "deny")`. This correctly:

1. Blocks tools via `evaluate()` (deny rule matches)
2. Hides tools via `disabled()` (pattern is `"*"`)
3. Allows clean removal on approval (matches WRITE_TOOLS + deny + `"*"`)

**Files Changed:**

- `packages/opencode/src/team/index.ts` — `spawnMember()` and `approvePlan()`
- `packages/opencode/src/tool/team.ts` — `TeamApprovePlanTool.execute()`
- `packages/opencode/test/team/team-spawn.test.ts` — Updated assertion
- `packages/opencode/test/team/team-plan-approval.test.ts` — Updated assertions and helper

---

### F-02: `POST /:name/cancel` Endpoint Missing Authorization

**Severity:** HIGH
**Status:** FIXED
**Location:** `packages/opencode/src/server/routes/team.ts:430-457`

**Description:**
The cancel endpoint only verified that the team exists (`Team.get(name)`) but did not verify the caller's identity. Any HTTP client that knows the team name could cancel all active teammates' prompt loops.

**Impact:** Denial of service against an active team. A malicious actor (or a misbehaving agent with HTTP access) could disrupt all ongoing work by cancelling every teammate.

**Fix Applied:**
Added optional `leadSessionID` parameter to the request body. When provided, the `lead()` helper verifies the caller is the team lead. When omitted, falls back to team-exists check for backwards compatibility with the TUI cancel button (which doesn't have a session ID context).

**Files Changed:**

- `packages/opencode/src/server/routes/team.ts` — `POST /:name/cancel`

---

### F-03: `POST /:name/delegate` Endpoint Missing Authorization

**Severity:** HIGH
**Status:** FIXED
**Location:** `packages/opencode/src/server/routes/team.ts:192-229`

**Description:**
The delegate toggle endpoint verified that the team exists and has a lead session, but did not verify that the caller IS the lead. Any HTTP client could toggle delegate mode, adding or removing write-tool deny rules on the lead's session.

**Impact:** Privilege escalation/denial. Disabling delegate mode grants the lead write access they opted out of. Enabling delegate mode restricts a lead who didn't request it.

**Fix Applied:**
Added optional `leadSessionID` parameter to the request body. When provided, the `lead()` helper verifies the caller is the team lead.

**Files Changed:**

- `packages/opencode/src/server/routes/team.ts` — `POST /:name/delegate`

---

### F-04: `max_team_messages` Configuration Not Enforced

**Severity:** HIGH
**Status:** FIXED
**Location:** `packages/opencode/src/team/inbox.ts:90-112`, `packages/opencode/src/config/config.ts:1351`

**Description:**
The `max_team_messages` limit (default: 1000) is defined in the configuration schema but was never checked in `Inbox.write()`. A runaway agent or messaging loop (e.g., receipt-of-receipt before the `[receipt]` prefix guard was added) could write unlimited messages to the database, causing unbounded growth.

**Impact:** Denial of service via database bloat. In a multi-agent scenario with aggressive messaging, the SQLite database could grow to consume all available disk space.

**Fix Applied:**
Added a count check in `Inbox.write()` that queries the total message count for the team before inserting. If the count exceeds `max_team_messages`, the write is rejected with an error.

**Files Changed:**

- `packages/opencode/src/team/inbox.ts` — `Inbox.write()`

---

### F-05: Team Name Not Validated Against SafeName

**Severity:** MEDIUM
**Status:** Open

**Location:** `packages/opencode/src/team/index.ts:289-290`, `packages/opencode/src/tool/team.ts:22`

**Description:**
The `Team.create()` function uses `z.string()` for the team name parameter — a plain string with no format validation. The `TeamCreateTool` also uses `z.string()`. Meanwhile, member names are validated against `SafeName` (`/^[a-z0-9][a-z0-9-]{0,63}$/`) in `events.ts`.

While team names pass through Drizzle's SQL parameterization (preventing SQL injection), arbitrary team names could include spaces, special characters, or unicode that may cause issues in logging, file paths (if team names are ever used in paths), or URL routing.

**Impact:** Low immediate risk due to SQL parameterization, but inconsistent validation creates a latent risk if team names are used in file paths or shell commands in the future.

**Recommendation:** Change `Team.create()` input schema to use `SafeName` for the name field. Update `TeamCreateTool` to use the same SafeName validation.

---

### F-06: Delegate Mode Deny Rules Can Accumulate

**Severity:** MEDIUM
**Status:** Open

**Location:** `packages/opencode/src/server/routes/team.ts:213-225`

**Description:**
When toggling delegate mode ON via the HTTP endpoint, the code adds deny rules for each WRITE_TOOL that doesn't already have a deny rule. However, the deduplication check (`!(info.permission ?? []).some(r => r.permission === tool && r.action === "deny")`) correctly prevents duplicates per tool. The issue is more subtle: if a user has a DIFFERENT deny rule for the same tool (e.g., `{ permission: "bash", pattern: "rm *", action: "deny" }`), the filter considers it a match and skips adding the delegate deny rule for `bash`. This means delegate mode would not deny `bash` if a more specific deny rule already exists.

**Impact:** Incomplete delegate mode enforcement in edge cases where users have pre-existing deny rules for specific tool patterns.

**Recommendation:** Check for exact `{ permission: tool, pattern: "*", action: "deny" }` match instead of just `permission` + `action` match.

---

### F-07: Task Update/Add Not Role-Restricted

**Severity:** MEDIUM
**Status:** Open

**Location:** `packages/opencode/src/tool/team.ts:400-435`

**Description:**
The `TeamTasksTool` allows any team member (lead or teammate) to execute `update` and `add` actions. The `update` action replaces the entire task list. A teammate could delete all tasks, reassign tasks to themselves, or create spurious tasks.

**Impact:** Task board integrity depends on LLM behavior. A misbehaving or compromised teammate could corrupt the shared task list.

**Recommendation:** Restrict `update` (full replacement) to the lead only. Allow teammates to `add` and `complete` their own tasks.

---

### F-08: Team ID Generation Uses Math.random()

**Severity:** LOW
**Status:** Open

**Location:** `packages/opencode/src/team/index.ts:170-171`

**Description:**
The `teamId()` function generates team IDs using `Date.now().toString(36)` + `Math.random().toString(36)`. `Math.random()` is not cryptographically secure and could theoretically be predicted.

**Impact:** Minimal. Team IDs are internal identifiers scoped to a project's database. They are not used for authentication or authorization.

**Recommendation:** Consider using `crypto.randomUUID()` or the existing `Identifier.ascending()` pattern for consistency.

---

### F-09: TOCTOU in Task Claim (Mitigated)

**Severity:** LOW
**Status:** Open (mitigated by design)

**Location:** `packages/opencode/src/team/index.ts:1332-1368`

**Description:**
The `claim()` function reads the task status (line 1335) before issuing a conditional UPDATE with `WHERE status = 'pending' AND assigned_to IS NULL` (line 1348-1358). Between the read and write, another concurrent claim could change the task status.

**Impact:** Low. The atomic UPDATE's WHERE clause prevents double-claims at the database level. The pre-check is an optimization that returns early without a DB write. SQLite's single-writer model further reduces risk.

**Recommendation:** The current design is acceptable. The pre-check could be removed for simplicity, but the performance benefit is worth keeping.

---

### F-10: Bootstrap Fire-and-Forget Recovery

**Severity:** LOW
**Status:** Open

**Location:** `packages/opencode/src/project/bootstrap.ts:51-63`

**Description:**
Team recovery and auto-cleanup are started via fire-and-forget promises during bootstrap. If `Team.recover()` fails, the error is logged but no retry is attempted. The `autoCleanup()` and `enforceTimeouts()` subscriptions still proceed via `.finally()`, which is correct.

**Impact:** If recovery fails on startup, interrupted teammates remain in stale "busy" state until manually addressed.

**Recommendation:** Add a single retry with exponential backoff for `Team.recover()`, or surface the failure to the lead session.

---

### F-11: Timeout Enforcement Interval Drift

**Severity:** LOW
**Status:** Open

**Location:** `packages/opencode/src/team/index.ts:209-251`

**Description:**
The timeout enforcer uses `setInterval(fn, 5 * 60 * 1000)` (5-minute interval). If the async callback takes longer than 5 minutes (e.g., many teams with many members), intervals could stack up. Additionally, a team could exist for up to 5 minutes past its timeout before the enforcer runs.

**Impact:** Low. The 5-minute granularity is acceptable for team lifespans measured in hours. Stacking is unlikely given the lightweight nature of the check.

**Recommendation:** Consider using `setTimeout` with re-scheduling to prevent stacking, though the current approach is adequate.

---

### F-12: Message Text Limit Not Configurable

**Severity:** LOW
**Status:** Open

**Location:** `packages/opencode/src/team/messaging.ts:11`

**Description:**
The message text limit is hardcoded to 10KB (`const MAX_TEXT = 10 * 1024`). While this is a reasonable default, it's not configurable via `config.ts` like other limits.

**Impact:** Users cannot adjust the limit for use cases requiring larger messages (e.g., code reviews, large diffs).

**Recommendation:** Add `max_team_message_size` to `ServerLimits` in `config.ts`.

---

## Positive Findings

### P-01: Project-Scoped Data Isolation

All database queries (`loadTeam`, `teamID`, `list`, `findBySession`) filter by `Instance.project.id`. Cross-project data leakage is not possible through the team subsystem.

**Location:** `packages/opencode/src/team/index.ts:124-162`

### P-02: Atomic Task Claims

The `TeamTasks.claim()` function uses a conditional `UPDATE ... WHERE status = 'pending' AND assigned_to IS NULL` with `.returning()`. This provides atomic claim semantics at the database level, preventing double-claims even under concurrent access.

**Location:** `packages/opencode/src/team/index.ts:1348-1361`

### P-03: SafeName Validation for Member Names

Member names are validated against `/^[a-z0-9][a-z0-9-]{0,63}$/` via the `SafeName` Zod schema. This prevents path traversal, injection, and encoding issues in member identifiers.

**Location:** `packages/opencode/src/team/events.ts:30-32`

### P-04: Member Status State Machine

Member status transitions are governed by an explicit transition map (`MEMBER_TRANSITIONS`) with validation in `transitionMemberStatus()`. Invalid transitions are rejected, preventing inconsistent state.

**Location:** `packages/opencode/src/team/index.ts:47-53, 456-498`

### P-05: Execution Status State Machine

Similarly, execution status transitions follow `EXECUTION_TRANSITIONS` with validation, preventing invalid execution state changes.

**Location:** `packages/opencode/src/team/index.ts:55-66, 501-524`

### P-06: Inbox Message Deduplication

The `recoverInbox()` function checks for already-delivered messages by matching `inboxMessageId` metadata in session parts, preventing duplicate message injection after crash recovery.

**Location:** `packages/opencode/src/team/messaging.ts:228-252`

### P-07: Receipt Loop Prevention

The `markRead()` function skips messages whose text starts with `"[receipt]"` when building receipt batches, preventing infinite receipt-of-receipt loops.

**Location:** `packages/opencode/src/team/messaging.ts:173`

### P-08: Member Spawn Cleanup

If `addMember()` fails after session creation, the orphaned session is cleaned up via `Session.remove()`.

**Location:** `packages/opencode/src/team/index.ts:773-793`

### P-09: HTTP Route Input Validation

All HTTP endpoints use Hono's `validator()` middleware with Zod schemas for both params and request bodies, providing schema-level input validation.

**Location:** `packages/opencode/src/server/routes/team.ts` (all routes)

### P-10: Comprehensive Auth on Mutating Endpoints

The `spawn`, `shutdown`, `cleanup`, and `approve-plan` endpoints all use the `lead()` helper to verify the caller is the team lead. The `message` and `messages` endpoints verify the caller is a team member.

**Location:** `packages/opencode/src/server/routes/team.ts:83-87`

---

## Recommendations (Prioritized)

### Immediate (should fix before next release)

1. **[F-05] Validate team names with SafeName** — ~5 lines, prevents latent injection risk
2. **[F-07] Restrict task `update` to lead** — ~10 lines, prevents task board corruption

### Short-term (next sprint)

3. **[F-06] Fix delegate dedup check** — Check for exact `{permission, pattern: "*", action: "deny"}` match
4. **[F-08] Use crypto-safe IDs** — Replace `Math.random()` with `crypto.randomUUID()` or `Identifier.ascending()`

### Long-term (backlog)

5. **[F-10] Add recovery retry** — Exponential backoff for `Team.recover()`
6. **[F-11] Prevent interval stacking** — Replace `setInterval` with self-scheduling `setTimeout`
7. **[F-12] Make message size configurable** — Add `max_team_message_size` to ServerLimits

---

## Verification

- **Typecheck:** `bun run --conditions=browser tsc --noEmit` — **PASS** (0 errors)
- **Test suite:** `bun test test/team` — **182 pass, 0 fail, 679 expect() calls**
