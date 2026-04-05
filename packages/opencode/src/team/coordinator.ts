/**
 * Coordinator mode for agent teams.
 *
 * When a lead session is created with coordinator=true, it receives:
 *   1. A slim tool set — coordination-only (no bash/edit/write/glob/grep)
 *   2. A compact system prompt explaining its role as orchestrator
 *
 * The mode is stored in the lead session's team_meta so it survives
 * process restarts. The prompt loop reads it on every turn.
 *
 * Tool allowlist for coordinator leads:
 *   task, team_spawn, team_message, team_broadcast, team_tasks,
 *   team_claim, team_approve_plan, team_shutdown, team_cleanup,
 *   team_status, team_mode_set, team_permission_response,
 *   team_wait, read, session_task_*
 */

export namespace CoordinatorMode {
  /** Tools a coordinator lead is allowed to use */
  export const ALLOWED_TOOLS = new Set([
    "task",
    "read",
    // session task management
    "session_task_create",
    "session_task_update",
    "session_task_get",
    "session_task_list",
    // team tools
    "team_spawn",
    "team_message",
    "team_broadcast",
    "team_tasks",
    "team_claim",
    "team_approve_plan",
    "team_shutdown",
    "team_cleanup",
    "team_status",
    "team_mode_set",
    "team_permission_response",
    "team_wait",
    // team memory
    "team_memory_write",
    "team_memory_read",
    // always needed
    "Invalid",
  ])

  export function systemPrompt(teamName: string): string {
    return [
      `## Coordinator Mode — Team "${teamName}"`,
      "",
      "You are the **coordinator** for this agent team. Your role is to:",
      "- Break down the goal into tasks and assign them to teammates via team_spawn",
      "- Monitor progress with team_status",
      "- Relay decisions, approve plans, and respond to permission requests",
      "- Synthesize results and report back to the user",
      "",
      "**You do not write code or run commands directly.** Delegate all implementation",
      "work to teammates. You are restricted to coordination tools only.",
      "",
      "Workflow:",
      "1. Spawn teammates with team_spawn (assign tasks via claim_task or prompt)",
      "2. Check progress with team_status",
      "3. Handle permission requests with team_permission_response",
      "4. Shut down teammates when done with team_shutdown, then team_cleanup",
    ].join("\n")
  }
}
