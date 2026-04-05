import z from "zod"
import { BusEvent } from "../bus/bus-event"

// ---------------------------------------------------------------------------
// Structured Message Protocol
// ---------------------------------------------------------------------------
// All team messages flow through the same inbox + inject path, but protocol
// messages carry a typed `structured` payload in addition to a human-readable
// `text` summary. This lets recipients route on type without regex-parsing
// plain text, while still giving the model readable context.
//
// Wire format stored in TeamMessageTable.content:
//   Plain message : the text itself (no JSON wrapper)
//   Structured    : JSON string of StructuredEnvelope
// ---------------------------------------------------------------------------

export const StructuredEnvelopeSchema = z.object({
  /** Discriminator — always present so recipients can detect structured messages */
  __structured: z.literal(true),
  /** The typed payload */
  msg: z.discriminatedUnion("type", [
    // Shutdown handshake ------------------------------------------------
    z.object({
      type: z.literal("shutdown_request"),
      request_id: z.string(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("shutdown_response"),
      request_id: z.string(),
      approve: z.boolean(),
      reason: z.string().optional(),
    }),

    // Plan approval handshake -------------------------------------------
    z.object({
      type: z.literal("plan_approval_request"),
      request_id: z.string(),
      /** The plan text the teammate wants approved */
      plan: z.string(),
    }),
    z.object({
      type: z.literal("plan_approval_response"),
      request_id: z.string(),
      approve: z.boolean(),
      feedback: z.string().optional(),
    }),

    // Permission request (teammate asks lead to allow a tool) -----------
    z.object({
      type: z.literal("permission_request"),
      request_id: z.string(),
      tool_name: z.string(),
      /** JSON-serialised tool input so the lead can review it */
      tool_input: z.string(),
    }),
    z.object({
      type: z.literal("permission_response"),
      request_id: z.string(),
      allow: z.boolean(),
      reason: z.string().optional(),
    }),

    // Permission mode change (lead pushes new mode to all teammates) ----
    z.object({
      type: z.literal("mode_set"),
      mode: z.enum(["default", "plan", "auto", "acceptEdits"]),
    }),

    // Lifecycle notifications (one-way, no response needed) -------------
    z.object({
      type: z.literal("idle_notification"),
      summary: z.string(),
      /** Why the loop ended */
      idle_reason: z.enum(["completed", "cancelled", "waiting"]),
    }),
    z.object({
      type: z.literal("task_assignment"),
      task_id: z.string(),
      content: z.string(),
      assigned_by: z.string(),
    }),
  ]),
  /** Human-readable summary rendered into the model's context */
  text: z.string(),
})

export type StructuredEnvelope = z.infer<typeof StructuredEnvelopeSchema>
export type StructuredMessage = StructuredEnvelope["msg"]
export type StructuredMessageType = StructuredMessage["type"]

/** Returns true if the raw inbox content is a structured protocol message */
export function isStructuredContent(content: string): boolean {
  if (!content.startsWith("{")) return false
  try {
    const parsed = JSON.parse(content)
    return parsed.__structured === true
  } catch {
    return false
  }
}

/** Parse raw inbox content into a StructuredEnvelope, or null if it's plain text */
export function parseStructuredContent(content: string): StructuredEnvelope | null {
  if (!isStructuredContent(content)) return null
  const result = StructuredEnvelopeSchema.safeParse(JSON.parse(content))
  return result.success ? result.data : null
}

/** Serialize a structured message to the wire format stored in the inbox */
export function encodeStructured(msg: StructuredMessage, text: string): string {
  const envelope: StructuredEnvelope = { __structured: true, msg, text }
  return JSON.stringify(envelope)
}

/** Generate a unique request ID for handshake messages */
export function newRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

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
  /** When true, the lead is in coordinator mode — slim tools + orchestrator prompt */
  coordinator: z.boolean().optional(),
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

  /** Fired when a structured protocol message is sent (shutdown/plan/permission/mode) */
  export const StructuredMessageSent = BusEvent.define(
    "team.structured_message",
    z.object({
      teamName: z.string(),
      from: z.string(),
      to: z.string(),
      messageType: z.string(),
      requestId: z.string().optional(),
    }),
  )

  /** Fired when a permission request arrives from a teammate at the lead */
  export const PermissionRequest = BusEvent.define(
    "team.permission.request",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      requestId: z.string(),
      toolName: z.string(),
      toolInput: z.string(),
    }),
  )

  /** Fired when the lead responds to a teammate's permission request */
  export const PermissionResponse = BusEvent.define(
    "team.permission.response",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      requestId: z.string(),
      allow: z.boolean(),
    }),
  )

  /** Fired when the lead pushes a permission mode change to all teammates */
  export const ModeSet = BusEvent.define(
    "team.mode.set",
    z.object({
      teamName: z.string(),
      mode: z.string(),
    }),
  )
}
