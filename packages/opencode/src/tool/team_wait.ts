import z from "zod"
import { Tool } from "./tool"
import { Team } from "../team"

/**
 * Wait for all spawned teammates to finish their work.
 */
export const TeamWaitTool = Tool.define("team_wait", {
  description:
    "Block execution until all spawned teammates have finished their work. " +
    "Polls the database for teammate session status (idle/completed) with a timeout. " +
    "Returns a summary of each teammate's final output.",
  parameters: z.object({
    timeout: z
      .number()
      .optional()
      .describe("Timeout in seconds to wait for teammates to finish. Defaults to 600 (10 minutes)."),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    // Verify the caller is a team lead
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return {
        title: "Error",
        output: "You are not part of any team.",
        metadata: {},
      }
    }
    if (teamInfo.role !== "lead") {
      return {
        title: "Error",
        output: "Only the team lead can wait for teammates. Teammates should use team_status to check progress.",
        metadata: {},
      }
    }

    const teamName = teamInfo.team.name
    const timeout = (params.timeout ?? 600) * 1000 // Convert to milliseconds
    const pollInterval = 2000 // Poll every 2 seconds
    const maxPolls = Math.ceil(timeout / pollInterval)

    let polls = 0
    const startTime = Date.now()

    while (polls < maxPolls) {
      const team = await Team.get(teamName)
      if (!team) {
        return {
          title: "Error",
          output: `Team "${teamName}" no longer exists.`,
          metadata: {},
        }
      }

      // Check if all teammates are idle (not actively executing)
      const activeMembers = team.members.filter(
        (m) =>
          m.execution_status && !["idle", "completed", "cancelled", "failed", "timed_out"].includes(m.execution_status),
      )

      if (activeMembers.length === 0) {
        // All teammates are idle, gather their final status
        const memberSummaries = team.members.map((m) => {
          const statusDesc =
            m.status === "shutdown"
              ? "shutdown"
              : m.status === "ready"
                ? "idle and ready"
                : m.status === "error"
                  ? "errored"
                  : m.status

          const execDesc =
            m.execution_status === "completed"
              ? " (completed work)"
              : m.execution_status === "cancelled"
                ? " (was cancelled)"
                : m.execution_status === "failed"
                  ? " (failed)"
                  : m.execution_status === "timed_out"
                    ? " (timed out)"
                    : ""

          return `- ${m.name}: ${statusDesc}${execDesc}`
        })

        const duration = Math.round((Date.now() - startTime) / 1000)

        return {
          title: `All teammates finished`,
          output: [
            `All ${team.members.length} teammate(s) in team "${teamName}" have finished their work.`,
            `Wait duration: ${duration}s`,
            "",
            "Final teammate status:",
            ...memberSummaries,
            "",
            "Next steps:",
            "- Review individual teammate sessions for detailed results",
            "- Use team_status to see full team state and unread messages",
            "- Use team_shutdown to shut down idle teammates",
            "- Use team_cleanup when all teammates are shut down",
          ].join("\n"),
          metadata: {
            teamName,
            duration,
            teammateCount: team.members.length,
            completed: true,
          },
        }
      }

      // Still have active teammates, wait before next poll
      polls++
      if (polls < maxPolls) {
        await Bun.sleep(pollInterval)
      }
    }

    // Timeout reached
    const team = await Team.get(teamName)
    const activeMembers =
      team?.members.filter(
        (m) =>
          m.execution_status && !["idle", "completed", "cancelled", "failed", "timed_out"].includes(m.execution_status),
      ) ?? []

    const duration = Math.round((Date.now() - startTime) / 1000)

    return {
      title: "Wait timeout",
      output: [
        `Timeout after ${duration}s waiting for teammates to finish.`,
        `${activeMembers.length} teammate(s) still active: ${activeMembers.map((m) => `${m.name} (${m.execution_status})`).join(", ")}`,
        "",
        "You can:",
        "- Continue waiting with team_wait",
        "- Check progress with team_status",
        "- Cancel active teammates with team_shutdown",
        "- Review completed teammates' sessions for partial results",
      ].join("\n"),
      metadata: {
        teamName,
        duration,
        timeout: true,
        activeCount: activeMembers.length,
        totalCount: team?.members.length ?? 0,
      },
    }
  },
})
