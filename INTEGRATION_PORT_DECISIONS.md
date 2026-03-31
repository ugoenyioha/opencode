# Integration Port Decisions

Working branch: `integration/from-tui-mcp-freeze`

Purpose: keep a running record of what we intentionally ported, what we deferred, what we rejected, and what may need to be revisited because of hidden dependencies.

## Baseline

- Stable known-good baseline tag: `tui-mcp-freeze-stable-20260329`
- Clean bugfix commit: `10fad1762` `fix(tui): restore plugin-backed startup and prompt flow`
- Live daily-driver binary remains on the known-good dirty build in `/Users/uenyioha/tmp/opencode-ng` until the clean integration branch is strong enough to replace it.

## Root-Cause Constraints To Preserve

Do not reintroduce these regressions without deliberate end-to-end validation:

- Recursive trust gating during config bootstrap
- Plugin loading being trust-gated outside hardened mode
- Broken TUI thread/worker flow (worker directory handoff, bus event forwarding, `Server.internalFetch`)
- Missing Solid transition patch
- Missing `createCliRenderer(...)` startup path
- Unsafe deferred MCP prompt-instruction injection in `packages/opencode/src/session/prompt.ts`

## Successfully Ported

- `31079739c` `fix: return full JWT payload from verifyRS256JWT for Cedar ABAC claims`
- `8be88f22f` `feat(authz): expose JWT claims to a2a.authz plugin hook`
- `0f747868f` `fix A2A observability: merge duplicate out() and fix test sink isolation`
- `a67fa59ab` `fix: avoid session FK races during deletes`
- `f15f86f90` `fix: SessionStatus async in team code, auth middleware fallback, json-migration todo schema`
- `6a1f8e320` `fix: add useRealAnthropicToken test helper, fix Env import path, fix permission/next import`
- `685c429fa` `fix: update stale permission/next import in subagent-inheritance test`
- `fd0043567` `fix: align A2A import and permission test on integration branch`
- `b6008337d` `feat(plugin): add llm observability hooks`
- `a367cad47` `add A2A session auth context plumbing` (narrowed merge: keep session-auth-context plumbing, avoid earlier rejected auth-required task-state semantics)
- `d43f89f1b` `fix(auth): tighten JWT and skill permission integration`
- `9cfebe16d` `fix(a2a): support workload JWKS fallback and overrides`

## Deferred / Not Yet Ported

### 1. Env-var rename sweep from `93d82443b`

User decision: full migration.

Examples:

- `OPENCODE_COMPAT_JWT_*` -> `OPENCODE_USER_JWT_*`
- `OPENCODE_COMPAT_OIDC_*` -> `OPENCODE_OIDC_*`
- `OPENCODE_COMPAT_OAUTH_*` -> `OPENCODE_OAUTH_*`
- `OPENCODE_COMPAT_ALLOW_SERVER_PASSWORD` -> `OPENCODE_ALLOW_SERVER_PASSWORD`

Notes:

- This is a configuration-contract migration, not a narrow code fix.
- It may be a dependency of later local auth work.
- It should now be treated as an intended migration batch, not an optional defer.

### 2. Relay changes from `93d82443b`

Deferred to the end of the port unless an upstream dependency forces earlier work.

Examples:

- new `relay` CLI command
- relay rate limiting
- relay API key auth
- join-grant flow and DO grant consumption
- remote security docs and remote-control UX changes

Reason deferred:

- This is a feature surface expansion, not just a runtime fix.
- It spans CLI, relay service, docs, and remote UX.
- Needs its own validation plan.

User direction:

- Keep relay features for the end of the port.
- Still watch for upward dependencies from other local changes.

### 3. `211599a1a` OpenAI compat stabilization for Mattermost Agents

Tried, then reverted.

Reason:

- Introduced regressions in compat/server/auth tests.
- Needs a narrower manual port, not a whole-commit cherry-pick.

User note:

- There may be later upstream/local test fixes that make this port viable.
- Revisit after pulling in related upstream compat test/context changes rather than assuming the original revert is final.

### 4. `f3194991d` preserve auth-required resume metadata

Tried, then reverted.

Reason:

- Broke A2A task/message streaming contract tests.
- Needs a more careful design/merge if we want the feature.

### 5. `2369f84dc` DB-backed teams and `team_wait`

Deferred temporarily, but now marked as a priority area.

Reason:

- Large surface area.
- More like a mini-project than a safe cherry-pick.
- Needs its own batch plan, tests, and probably staged porting.

User direction:

- This is a priority because it previously worked and is important to recover.

### 7. Upstream account / multi-account workspace auth subsystem

Skipped for this phase on purpose.

Reason:

- This is upstream console/workspace account product work, not runtime-critical provider auth.
- It would blur the runtime story for AI Forge and introduce CLI/account features that are not part of the current runtime-focused milestone.
- User explicitly decided to skip it for this phase.

### 6. `beca1f2e3` post-merge schema/todo/session-status/skill-import fixes

Deferred on purpose.

Reason:

- Broad patch-up commit with multiple concerns.
- Better revisited after deciding on DB-backed teams direction.

Additional finding:

- A narrow attempt to port just the DB-backed todo/schema support from this commit was not safely portable in isolation.
- The code itself was coherent, but tests failed with `SQLiteError: table todo has no column named id`, which means the todo schema shift depends on a broader migration/runtime application strategy.
- Treat todo schema migration as part of the larger DB-backed teams effort, not as an independent easy slice.

## Partial / Narrow Manual Ports

These were not taken wholesale; only selected behavior was preserved.

### From `10b81be1b`

Kept:

- session auth context plumbing relevant to A2A flow

Did not keep:

- the earlier risky auth-required task-state semantics that had already caused test failures in another slice

### From `93d82443b`

Kept:

- SPIFFE socket verification fallback to workload JWT verification
- workload JWT JWKS override support

Did not keep:

- env-var rename sweep
- relay feature additions
- broader remote/relay/UI changes

### From `67c202ae0`

Kept manually:

- minimal useful parts only:
  - `cnf` propagation in verified token typing
  - broader skill-directory allowlisting behavior in `agent.ts`

Did not keep:

- the broader JWT diagnostics/JWKS logging changes as a whole batch

Reason:

- Targeted tests stayed green with the small subset.
- The larger diagnostics slice was not clearly worth the added surface area yet.

## Important Caveat

Some deferred items may later prove to be dependencies of already-ported or still-to-be-ported local features. In particular, the env-var rename sweep from `93d82443b` may be one of those dependency groups.

If a later feature appears to rely on renamed auth environment variables, do not blindly cherry-pick the whole commit. Instead:

1. identify the exact dependency,
2. decide whether to support both old and new env var names,
3. port the migration consciously.
