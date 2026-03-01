# Agent Worktree Isolation Technical Plan

This document outlines the technical approach to implementing `isolation: worktree` for OpenCode agents, inspired by Claude Code's worktree isolation feature.

## 1. Extending `Agent.Info` Schema
**File:** `packages/opencode/src/agent/agent.ts`

- Add `isolation: z.enum(["none", "worktree"]).optional()` to the `Agent.Info` schema definition.
- When an agent is configured with `isolation: "worktree"`, it signals to the spawning mechanism that the agent must execute in an isolated git worktree rather than the shared primary working directory.
- This prevents subagents/teammates from inadvertently modifying the main working tree (e.g., uncommitted user changes) and conflicting with one another during parallel execution.

## 2. Updating Subagent Execution Logic
**Files:** `packages/opencode/src/tool/task.ts`, `packages/opencode/src/tool/team.ts`

- **TaskTool (`task.ts`):** 
  - Before calling `Session.create`, check the requested agent's configuration (`agent.isolation`).
  - If `"worktree"`, invoke the `Worktree.create` API (defined in `packages/opencode/src/worktree/index.ts`) to provision an isolated git worktree branch.
  - Pass the returned worktree directory as the `directory` property into `Session.create()`.
  
- **TeamSpawnTool (`team.ts`):**
  - Similarly, when a lead spawns a new teammate session, check the teammate's agent configuration.
  - If `"worktree"`, create an isolated worktree for that teammate.
  - Ensure the teammate's session is bound to the worktree `directory`.

- **Cleanup:**
  - Update `team_cleanup` (or `team_shutdown`) to call `Worktree.remove` to clean up the worktree path from the filesystem and git index once the agent completes its assigned task.
  - Apply similar teardown logic for independent subagents (`TaskTool`) when they complete or are aborted.

## 3. Exposing Plugin Hooks
**File:** `packages/opencode/src/worktree/index.ts`

To allow custom behaviors (like database seeding, `node_modules` symlinking, or custom environment variables loading) when an isolated worktree is spawned, we must expose lifecycle hooks:
- **`WorktreeCreate` Hook:**
  - Introduce an event/hook (e.g., `BusEvent.define("worktree.created")` or `Plugin.hook("worktree.create")`).
  - Dispatched after `git worktree add` succeeds but before the subagent starts execution.
  - External plugins can listen to this to provision sandbox resources.
- **`WorktreeRemove` Hook:**
  - Dispatched before `git worktree remove` runs.
  - Allows plugins to drop shadow databases or tear down ephemeral resources allocated for that worktree.

## 4. Resolving `Project` and `Config` State
**Files:** `packages/opencode/src/config/config.ts`, `packages/opencode/src/project/instance.ts`

- Isolated git worktrees are instantiated in separate physical directories, which can confuse standard `Config` or `Project` resolution logic.
- **Config Inheritance:** 
  - Ensure `Config.get()` resolves to the root project's `.opencode.json` config, either by inspecting the `.git` file back-reference in the worktree or by explicitly propagating the parent `directory` context down to the subagent session.
- **Project Linking:** 
  - The subagent's `Session` must share the same `project_id` as the parent session so it remains visible within the same project UI.
  - Avoid auto-bootstrapping a new `Project` entity for the worktree directory. Use the root `Instance.projectID` when instantiating the worktree-bound subagent session.
