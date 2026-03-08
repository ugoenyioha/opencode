import z from "zod"
import { BusEvent } from "../bus/bus-event"

/**
 * Member lifecycle status.
 * Transitions: ready -> busy -> shutdown_requested -> shutdown; any -> error -> ready.
 */
export const MemberStatus = z.enum(["ready", "busy", "shutdown_requested", "shutdown", "error"])
export type MemberStatus = z.infer<typeof MemberStatus>

/**
 * Prompt-loop execution status within a busy member.
 * Terminal states: idle, cancelled, completed, failed, timed_out.
 */
export const ExecutionStatus = z.enum([
  "idle",
  "starting",
  "running",
  "cancel_requested",
  "cancelling",
  "cancelled",
  "completing",
  "completed",
  "failed",
  "timed_out",
])
export type ExecutionStatus = z.infer<typeof ExecutionStatus>

/** Validates safe identifiers for team/member names — prevents path traversal */
const SafeName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Must be lowercase alphanumeric with hyphens, 1-64 chars")

/** Schema for a single teammate within a team */
export const TeamMemberSchema = z.object({
  name: SafeName,
  sessionID: z.string(),
  agent: z.string(),
  status: MemberStatus,
  execution_status: ExecutionStatus.optional(),
  prompt: z.string().optional(),
  /** Model this teammate is using, in "providerID/modelID" format. */
  model: z.string().optional(),
  planApproval: z.enum(["none", "pending", "approved", "rejected"]).optional(),
})
export type TeamMember = z.infer<typeof TeamMemberSchema>

/** Schema for the full team state including lead, members, and timestamps */
export const TeamInfoSchema = z.object({
  name: SafeName,
  leadSessionID: z.string().nullable(),
  members: z.array(TeamMemberSchema),
  created: z.number(),
  updated: z.number().optional(),
  delegate: z.boolean().optional(),
})
export type TeamInfo = z.infer<typeof TeamInfoSchema>

/** Schema for a shared task on the team's task board */
export const TeamTaskSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled", "blocked"]),
  priority: z.enum(["high", "medium", "low"]),
  assignee: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
})
export type TeamTask = z.infer<typeof TeamTaskSchema>

const TeammateIdleReason = z.enum(["completed", "cancelled"])

/** Bus events emitted by the team subsystem for lifecycle, messaging, and task changes */
export namespace TeamEvent {
  /** Fired when a new team is created */
  export const Created = BusEvent.define(
    "team.created",
    z.object({
      team: TeamInfoSchema,
    }),
  )

  /** Fired when a teammate is added to a team */
  export const MemberSpawned = BusEvent.define(
    "team.member.spawned",
    z.object({
      teamName: z.string(),
      member: TeamMemberSchema,
    }),
  )

  /** Fired on member lifecycle status transitions (ready/busy/shutdown/error) */
  export const MemberStatusChanged = BusEvent.define(
    "team.member.status",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      status: MemberStatus,
    }),
  )

  /** Fired on execution status transitions within a busy member's prompt loop */
  export const MemberExecutionChanged = BusEvent.define(
    "team.member.execution",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      status: ExecutionStatus,
    }),
  )

  /** Fired when a direct message is sent between participants */
  export const Message = BusEvent.define(
    "team.message",
    z.object({
      teamName: z.string(),
      from: z.string(),
      to: z.string(),
      text: z.string(),
    }),
  )

  /** Fired when a broadcast message is sent to all participants */
  export const Broadcast = BusEvent.define(
    "team.broadcast",
    z.object({
      teamName: z.string(),
      from: z.string(),
      text: z.string(),
    }),
  )

  /** Fired when the task list is replaced or modified */
  export const TaskUpdated = BusEvent.define(
    "team.task.updated",
    z.object({
      teamName: z.string(),
      tasks: z.array(TeamTaskSchema),
    }),
  )

  /** Fired when a member atomically claims a pending task */
  export const TaskClaimed = BusEvent.define(
    "team.task.claimed",
    z.object({
      teamName: z.string(),
      taskId: z.string(),
      memberName: z.string(),
    }),
  )

  /** Fired when a teammate's prompt loop ends and transitions to ready */
  export const TeammateIdle = BusEvent.define(
    "team.teammate.idle",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      reason: TeammateIdleReason,
    }),
  )

  /** Fired when a task is marked as completed */
  export const TaskCompleted = BusEvent.define(
    "team.task.completed",
    z.object({
      teamName: z.string(),
      task: TeamTaskSchema,
    }),
  )

  /** Fired when the lead requests a teammate to shut down */
  export const ShutdownRequest = BusEvent.define(
    "team.shutdown.request",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
    }),
  )

  /** Fired when the lead approves or rejects a teammate's plan */
  export const PlanApproval = BusEvent.define(
    "team.plan.approval",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      approved: z.boolean(),
      feedback: z.string().optional(),
    }),
  )

  /** Fired when a member marks inbox messages as read */
  export const MessageRead = BusEvent.define(
    "team.message.read",
    z.object({
      teamName: z.string(),
      agentName: z.string(),
      count: z.number(),
    }),
  )

  /** Fired after team cleanup completes — listeners restore lead session permissions */
  export const Cleaned = BusEvent.define(
    "team.cleaned",
    z.object({
      teamName: z.string(),
      leadSessionID: z.string().nullable(),
      delegate: z.boolean(),
    }),
  )
}
