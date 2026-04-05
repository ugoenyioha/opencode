---
name: feature-porting
description: >
  Port features between diverged codebases (e.g., Claude Code to opencode) by understanding
  intent, checking community prior art, and adapting to the target's architecture. Use when:
  "port feature X", "bring over the /btw command", "implement Claude Code's hook system",
  "what features are we missing", "audit features to port", "cherry-pick this capability",
  or any task involving translating functionality between codebases that share concepts but
  differ in architecture, runtime, and conventions. Also use for upstream merges that require
  feature adaptation after major refactors (e.g., Effect migration, API renames).
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Task
  - WebFetch
argument-hint: "$source_repo $target_repo $feature"
arguments:
  - source_repo
  - target_repo
  - feature
---

# Feature Porting

Port features between codebases that share concepts but differ in architecture. The source
and target may use different frameworks (React vs Solid, hooks vs Effect services), different
runtimes (Node vs Bun), different patterns (monolithic CLI vs client/server), and different
conventions. The goal is to translate the **intent** of a feature, not copy its code.

## Inputs
- `$source_repo`: Path to the source codebase (e.g., `/path/to/claude-code-2.1.92/src`)
- `$target_repo`: Path to the target codebase (e.g., `/path/to/opencode-ng`)
- `$feature`: Name of the feature to port (e.g., "btw", "hook-filters", "context-collapse")

## Goal
Produce a working implementation of `$feature` in `$target_repo` that:
- Passes targeted tests
- Builds cleanly
- Works from the CLI
- Respects the target's architecture and conventions

## Steps

### 1. Understand the Feature in Source

Read the source implementation thoroughly before touching anything. You need to answer:

- **What does this feature do for the user?** Not "what files does it touch" but "what
  problem does it solve and how does the user interact with it?"
- **What are the entry points?** Slash command, tool definition, hook event, config setting,
  CLI flag, or a combination?
- **What subsystems does it depend on?** Database, session state, bus events, permissions,
  provider APIs, TUI components?
- **What is the lifecycle?** How is it initialized, how does it run, how is it cleaned up?
- **Are there feature flags?** Is it gated behind compile-time or runtime flags?

Read the actual source files. Don't guess from names.

**Success criteria**: You can explain the feature to the user in 3 sentences without
referencing any implementation details.

### 2. Check Community Prior Art

Before designing anything, search the target repo's GitHub issues and PRs for prior
attempts. This step is NOT optional -- the community often has multiple implementation
attempts with valuable design feedback.

```
gh search issues --repo <target-org>/<target-repo> --json number,title,state,commentsCount,url "<feature keywords>"
gh search prs --repo <target-org>/<target-repo> --json number,title,state,commentsCount,url "<feature keywords>"
```

For results with 3+ comments, read the full discussion:
```
gh api repos/<org>/<repo>/issues/<number>/comments
```

Extract from community discussions:
- **Attempted approaches** -- what was tried and why it failed or stalled
- **Rejected designs** -- what the maintainers pushed back on and why
- **Accepted patterns** -- what the maintainers liked or merged elsewhere
- **Edge cases** -- problems users reported that the feature must handle
- **Architecture preferences** -- how maintainers want features integrated

Multiple failed PRs for the same feature (e.g., 5 `/btw` attempts) is a strong signal
that the implementation is tricky. Read what went wrong in each.

Do NOT use merge status as a quality indicator. The target repo may be slow to review.
Use the discussion quality instead.

**Success criteria**: You have a summary of prior art with specific lessons. If no prior
art exists, note that explicitly.

### 3. Understand the Target Architecture

Read the target's relevant subsystems to understand where the feature should live and
how it should integrate. The target codebase has its own patterns for:

- **Tool registration** -- how are tools defined and registered?
- **Slash commands** -- how are commands implemented?
- **Hook/event system** -- how do events flow? Bus, Effect PubSub, plugin hooks?
- **Session lifecycle** -- how are sessions created, prompted, compacted, cleaned up?
- **Database/state** -- what ORM, what schema patterns, what migrations?
- **Testing** -- what test framework, what fixture patterns, what mocking approach?
- **Config** -- how are settings defined, validated, and accessed?
- **TUI** -- what rendering framework, what component patterns?

Also read the target's AGENTS.md or equivalent coding conventions file. The target may
have strict style rules (e.g., no `else`, single-word variables, `const` over `let`,
functional array methods, Bun APIs).

**Success criteria**: You can describe how a similar existing feature in the target was
implemented, and use that as a template.

### 4. Design the Port

Present a design to the user BEFORE writing code. The design should cover:

- **What files will be created or modified** -- with one-line descriptions
- **What the user-facing behavior will be** -- how it differs from source (if at all)
- **What architectural adaptations are needed** -- e.g., "source uses React hooks,
  target uses Effect services, so X becomes Y"
- **What community feedback was incorporated** -- reference specific issues/PRs
- **What tests will be written** -- unit tests, integration tests, eval cases
- **What feature flag gates the implementation** -- for incremental rollout
- **What the migration path is** -- if schema changes are needed

The design should be 10-30 lines, not a novel. Focus on decisions and tradeoffs.

If the source feature depends on proprietary infrastructure (e.g., Anthropic's STT
endpoint, claude.ai API), explain how the target will achieve the same user-facing
behavior through different means, or recommend skipping the feature.

**Success criteria**: User approves the design before any code is written.

### 5. Implement

Write the implementation following the target's conventions. Key principles:

- **Translate intent, not code.** The source may use `useSwarmPermissionPoller` (React hook);
  the target may need `Bus.subscribe(PermissionNext.Event.Asked, ...)` (bus event). The user
  behavior is the same; the implementation is completely different.
- **Feature-flag everything.** New features go behind an env var flag so they can be enabled
  incrementally. The flag name should follow the target's convention.
- **Minimal surface area.** Only touch the files you listed in the design. If you find yourself
  modifying 15 files for a "small" feature, step back and reassess.
- **No compat shims in hot paths.** If the target's API has changed from what you expected,
  adapt your code to the real API -- don't add backward-compat wrappers that will bitrot.

For each file you create or modify, mentally verify: "does this follow the target's style?"
Check: import ordering, variable naming, error handling patterns, async patterns.

**Success criteria**: Implementation matches the design. No surprise files.

### 6. Write Tests

Write tests before committing. Follow the target's test patterns exactly -- same fixtures,
same setup/teardown, same assertion style.

Test categories for a ported feature:
- **Unit tests** -- does the core logic work in isolation?
- **Integration tests** -- does it work when wired into the real system?
- **Regression tests** -- does it NOT break existing functionality?
- **Edge cases from community** -- test any edge cases mentioned in GitHub issues

Run the tests. Fix failures before proceeding. Run adjacent test suites to verify no
regressions.

If the target has an eval framework (e.g., promptfoo), write eval cases for behavioral
correctness. If the feature has security implications, write adversarial redteam evals.

**Success criteria**: All new tests pass. No regressions in adjacent suites.

### 7. Build and CLI Verification

Build the binary. Run the feature from the CLI with real prompts to verify end-to-end
behavior. This catches issues that unit tests miss:

- Auth/provider initialization paths
- Config validation changes
- Plugin loading order
- Model ID resolution
- Feature flag gating

Use debug logging (`OPENCODE_LOG_LEVEL=debug` or equivalent) to trace the feature's
execution path if something doesn't work.

**Success criteria**: Feature works from the CLI as described in the design.

### 8. Commit

Commit with a message that includes:
- What was ported and from where
- What architectural adaptations were made
- What community feedback was incorporated (link issues/PRs)
- What tests were added
- What feature flag gates it

Before pushing, verify no credentials were committed:
```
git diff HEAD --name-only | grep -iE "auth\.json|\.env$|secret|credential"
```

**Success criteria**: Clean commit, no credentials, documented decisions.

## Feature Inventory Mode

When invoked without a specific `$feature` (or with "audit" / "what's missing"), run
the inventory workflow instead:

### Inventory Steps

1. **Scan the source changelog** for "Added" entries. But DO NOT rely on changelog alone --
   it misses features that shipped quietly, features that appear only as bug fix references,
   and features visible in source but absent from changelog.

2. **Scan the source code** for entry points the changelog missed:
   - Slash commands: search the commands directory for registered commands
   - Tools: list all tool directories and their feature flag gates
   - Hook events: search for hook event type definitions
   - Feature flags: search for `feature('` patterns to find gated capabilities
   - Config settings: search for new config schema fields

3. **Cross-reference against the target** to determine port status:
   - EXISTS: fully implemented in target
   - PARTIAL: partially implemented or different approach
   - MISSING: not present in target

4. **Apply product judgment** before presenting to the user:
   - Is this feature tied to proprietary infrastructure? (skip)
   - Does the target already have a superior implementation? (skip)
   - Does this strengthen the target's competitive position? (recommend)
   - Is this table stakes for the target's market? (recommend)

5. **Check community prior art** for each recommended feature using the GitHub search
   approach from Step 2. Note comment counts and PR attempt counts.

6. **Present as a prioritized checklist** with tiers:
   - Tier 1: High strategic value, recommend porting
   - Tier 2: Moderate value, consider based on roadmap
   - Tier 3: Skip -- wrong fit, duplicative, or infrastructure-dependent

## Common Pitfalls

These are patterns that cause ported features to fail. Learned from experience:

- **Async API drift**: A function that was sync in the source may be async in the target
  (or vice versa). Always check: `await` vs no `await`, `(await foo()).prop` vs
  `await foo().prop`. This one-character difference causes silent failures.

- **Bus/event semantics**: Source may await all subscribers on publish; target may fire
  and forget. Add settle waits in tests if the target's bus is async.

- **Runtime initialization order**: The target may require explicit initialization (e.g.,
  `initProjectors()`) that the source handles implicitly in its bootstrap path. Tests
  that bypass bootstrap will fail mysteriously.

- **Background loop hangs**: Features that spawn background prompt loops (auto-wake, agent
  spawn) will hang in tests if the target doesn't have a mock LLM. Add an env-var kill
  switch (e.g., `OPENCODE_DISABLE_TEAM_AUTOWAKE`) for test-only loop suppression.

- **Cleanup stalls**: Teardown functions that wait on "active loops" will hang if no loop
  was ever started. Add fast-path detection: if no active loop tracked, skip the wait.

- **Cross-test contamination**: File-level `process.env` settings in one test file leak
  into others in parallel test runners (bun). Always clean up env vars in `afterAll`.

- **Branded type boundaries**: The target may use branded types (e.g., `SessionID`) where
  the source uses plain strings. Add `.make()` casts at database/event boundaries, not
  scattered throughout the code.

- **Schema drift**: After an upstream merge, the target's DB schema may have dropped columns
  your feature depends on. Check `*.sql.ts` files and add columns + migrations as needed.

- **Config validation**: The target's config schema may reject fields that existed in older
  versions. If your global config has fields the new schema rejects, the binary won't start.
  Fix the config or make the schema lenient.
