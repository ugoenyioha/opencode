import { Log } from "../util/log"
import { Bus } from "../bus"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { SessionStatus } from "../session/status"
import { Identifier } from "../id/id"
import { Team, TeamEvent } from "./index"
import { Inbox } from "./inbox"
import { MessageID, PartID } from "../session/schema"
import {
  type StructuredMessage,
  type StructuredEnvelope,
  parseStructuredContent,
  encodeStructured,
  newRequestId,
} from "./events"

const log = Log.create({ service: "team.messaging" })
const MAX_TEXT = 10 * 1024

function validateText(text: string) {
  if (text.length <= MAX_TEXT) return
  throw new Error(`Team message too large (${text.length} chars). Maximum is ${MAX_TEXT} chars.`)
}

/**
 * Render a structured message into human-readable text for injection into
 * the model's context. The model sees this text — it never sees the raw JSON.
 */
function renderStructuredForModel(envelope: StructuredEnvelope): string {
  const { msg } = envelope
  switch (msg.type) {
    case "shutdown_request":
      return `[Shutdown request] Please wrap up your current work and shut down. Reason: ${msg.reason ?? "requested by lead"}. Respond with team_message({ type: "shutdown_response", request_id: "${msg.request_id}", approve: true }).`
    case "shutdown_response":
      return `[Shutdown ${msg.approve ? "accepted" : "rejected"}] request_id: ${msg.request_id}${msg.reason ? `. Reason: ${msg.reason}` : ""}`
    case "plan_approval_request":
      return `[Plan approval request] request_id: ${msg.request_id}\n\nPlan submitted for review:\n${msg.plan}`
    case "plan_approval_response":
      return msg.approve
        ? `[Plan approved] request_id: ${msg.request_id}. You now have full write access. Proceed with implementation.`
        : `[Plan rejected] request_id: ${msg.request_id}. Feedback: ${msg.feedback ?? "Please revise your plan."}`
    case "permission_request":
      return `[Permission request] request_id: ${msg.request_id}\nTool: ${msg.tool_name}\nInput: ${msg.tool_input}\n\nApprove or deny with team_message({ type: "permission_response", request_id: "${msg.request_id}", allow: true/false }).`
    case "permission_response":
      return `[Permission ${msg.allow ? "granted" : "denied"}] request_id: ${msg.request_id}${msg.reason ? `. ${msg.reason}` : ""}`
    case "mode_set":
      return `[Permission mode changed to: ${msg.mode}]`
    case "idle_notification":
      return `[Teammate idle — reason: ${msg.idle_reason}] ${msg.summary}`
    case "task_assignment":
      return `[Task assigned] ID: ${msg.task_id}\n${msg.content}\n(assigned by ${msg.assigned_by})`
    default:
      // Fallthrough for unknown types — surface the text field
      return envelope.text
  }
}

function messageId(): string {
  return `im_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * High-level messaging layer. Writes to inbox (source of truth),
 * injects synthetic user messages into sessions (delivery), and auto-wakes idle recipients.
 *
 * Supports two message modes:
 *   Plain text  — send()/broadcast(): free-form coordination messages
 *   Structured  — sendStructured(): typed protocol messages (shutdown, plan approval,
 *                 permission request/response, mode change, notifications)
 */
export namespace TeamMessaging {
  /** Get unread messages for a session's team participant */
  export async function pending(sessionID: string): Promise<Array<{ id: string; from: string; text: string; structured?: StructuredEnvelope }>> {
    const info = await Team.findBySession(sessionID)
    if (!info) return []
    const name = info.role === "lead" ? "lead" : info.memberName!
    const unread = await Inbox.unread(info.team.name, name)
    return unread.map((item) => {
      const envelope = parseStructuredContent(item.text)
      return {
        id: item.id,
        from: item.from,
        // Always return model-renderable text; caller may also inspect `structured`
        text: envelope ? renderStructuredForModel(envelope) : item.text,
        structured: envelope ?? undefined,
      }
    })
  }

  /**
   * Send a plain-text message from one team member to another.
   */
  export async function send(input: { teamName: string; from: string; to: string; text: string }): Promise<void> {
    validateText(input.text)
    const team = await Team.get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const targetSessionID = resolveRecipientSession(team, input.to)

    const inboxId = messageId()
    await Inbox.write(input.teamName, input.to, {
      id: inboxId,
      from: input.from,
      text: input.text,
      timestamp: Date.now(),
    })

    await injectMessage(targetSessionID, input.from, input.text, inboxId)
    Team.touch(input.teamName)

    log.info("message sent", { teamName: input.teamName, from: input.from, to: input.to })
    await Bus.publish(TeamEvent.Message, {
      teamName: input.teamName,
      from: input.from,
      to: input.to,
      text: input.text,
    })

    autoWake(targetSessionID, input.from, input.text)
  }

  /**
   * Send a typed structured protocol message from one team member to another.
   * The message is stored as a JSON envelope in the inbox, but the model
   * always sees a human-readable rendering (never raw JSON).
   *
   * Use this for all protocol interactions:
   *   shutdown_request / shutdown_response
   *   plan_approval_request / plan_approval_response
   *   permission_request / permission_response
   *   mode_set
   *   idle_notification / task_assignment
   */
  export async function sendStructured(input: {
    teamName: string
    from: string
    to: string
    msg: StructuredMessage
    /** Optional override for the human-readable text; auto-generated if omitted */
    text?: string
  }): Promise<string> {
    const team = await Team.get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const envelope: StructuredEnvelope = {
      __structured: true,
      msg: input.msg,
      text: input.text ?? renderStructuredForModel({ __structured: true, msg: input.msg, text: "" }),
    }

    const wireContent = encodeStructured(input.msg, envelope.text)
    validateText(wireContent)

    const targetSessionID = resolveRecipientSession(team, input.to)
    const inboxId = messageId()

    await Inbox.write(input.teamName, input.to, {
      id: inboxId,
      from: input.from,
      // Store the full JSON envelope as the inbox content
      text: wireContent,
      timestamp: Date.now(),
    })

    // Inject the model-readable rendering (not the raw JSON) into the session
    await injectMessage(targetSessionID, input.from, envelope.text, inboxId)
    Team.touch(input.teamName)

    // Publish typed bus events for structured protocol messages
    const requestId = "request_id" in input.msg ? (input.msg as { request_id: string }).request_id : undefined
    await Bus.publish(TeamEvent.StructuredMessageSent, {
      teamName: input.teamName,
      from: input.from,
      to: input.to,
      messageType: input.msg.type,
      requestId,
    })

    // Publish domain-specific events for routing
    if (input.msg.type === "permission_request") {
      await Bus.publish(TeamEvent.PermissionRequest, {
        teamName: input.teamName,
        memberName: input.from,
        requestId: input.msg.request_id,
        toolName: input.msg.tool_name,
        toolInput: input.msg.tool_input,
      })
    } else if (input.msg.type === "permission_response") {
      await Bus.publish(TeamEvent.PermissionResponse, {
        teamName: input.teamName,
        memberName: input.to,
        requestId: input.msg.request_id,
        allow: input.msg.allow,
      })
    } else if (input.msg.type === "mode_set") {
      await Bus.publish(TeamEvent.ModeSet, {
        teamName: input.teamName,
        mode: input.msg.mode,
      })
    }

    log.info("structured message sent", {
      teamName: input.teamName,
      from: input.from,
      to: input.to,
      type: input.msg.type,
    })

    autoWake(targetSessionID, input.from, envelope.text)
    return inboxId
  }

  /**
   * Broadcast a structured message to all non-shutdown members except the sender.
   * Used for mode_set (lead pushes permission mode to all teammates simultaneously).
   */
  export async function broadcastStructured(input: {
    teamName: string
    from: string
    msg: StructuredMessage
    text?: string
  }): Promise<void> {
    const team = await Team.get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const envelope: StructuredEnvelope = {
      __structured: true,
      msg: input.msg,
      text: input.text ?? renderStructuredForModel({ __structured: true, msg: input.msg, text: "" }),
    }

    const targets = [
      ...(input.from !== "lead" && team.leadSessionID
        ? [{ name: "lead", sessionID: team.leadSessionID }]
        : []),
      ...team.members
        .filter((m) => m.name !== input.from && m.status !== "shutdown")
        .map((m) => ({ name: m.name, sessionID: m.sessionID })),
    ]

    const wireContent = encodeStructured(input.msg, envelope.text)
    for (const target of targets) {
      const inboxId = messageId()
      await Inbox.write(input.teamName, target.name, {
        id: inboxId,
        from: input.from,
        text: wireContent,
        timestamp: Date.now(),
      }).catch((err: unknown) => {
        log.warn("broadcastStructured inbox write failed", { target: target.name, error: String(err) })
      })
      await injectMessage(target.sessionID, input.from, envelope.text, inboxId).catch((err: unknown) => {
        log.warn("broadcastStructured inject failed", { target: target.name, error: String(err) })
      })
      autoWake(target.sessionID, input.from, envelope.text)
    }

    if (input.msg.type === "mode_set") {
      await Bus.publish(TeamEvent.ModeSet, { teamName: input.teamName, mode: input.msg.mode })
    }

    log.info("structured broadcast sent", {
      teamName: input.teamName,
      from: input.from,
      type: input.msg.type,
      targets: targets.length,
    })
  }

  /** Resolve a named recipient to their session ID, throwing if not found/shutdown */
  function resolveRecipientSession(team: Awaited<ReturnType<typeof Team.get>>, to: string): string {
    if (!team) throw new Error("Team not found")
    if (to === "lead") {
      if (!team.leadSessionID) throw new Error("Lead session not found")
      return team.leadSessionID
    }
    const member = team.members.find((m) => m.name === to)
    if (!member) throw new Error(`Member "${to}" not found`)
    if (member.status === "shutdown") throw new Error(`Member "${to}" has shut down`)
    return member.sessionID
  }

  /**
   * Broadcast a message from one member to all other members.
   */
  export async function broadcast(input: { teamName: string; from: string; text: string }): Promise<void> {
    validateText(input.text)
    const team = await Team.get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    // Send to all active members except the sender
    const memberTargets = team.members
      .filter((m) => m.name !== input.from && m.status !== "shutdown")
      .map((m) => ({ name: m.name, sessionID: m.sessionID }))

    const targets =
      input.from !== "lead" && team.leadSessionID
        ? [{ name: "lead", sessionID: team.leadSessionID }, ...memberTargets]
        : memberTargets

    const errors: Array<{ target: string; phase: string; error: string }> = []
    for (const target of targets) {
      const inboxId = messageId()

      // Write to inbox (source of truth)
      const wrote = await Inbox.write(input.teamName, target.name, {
        id: inboxId,
        from: input.from,
        text: input.text,
        timestamp: Date.now(),
      }).then(
        () => true,
        (err) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn("broadcast inbox write failed", { target: target.name, error: msg })
          errors.push({ target: target.name, phase: "inbox", error: msg })
          return false
        },
      )

      // Only inject if inbox write succeeded — no point delivering a message
      // that won't survive recovery
      if (wrote) {
        await injectMessage(target.sessionID, input.from, input.text, inboxId).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn("broadcast inject failed", { target: target.name, error: msg })
          errors.push({ target: target.name, phase: "inject", error: msg })
        })
      }
    }

    const delivered = targets.length - errors.filter((e) => e.phase === "inbox").length
    log.info("broadcast sent", {
      teamName: input.teamName,
      from: input.from,
      targets: targets.length,
      delivered,
      errors: errors.length,
    })
    if (errors.length > 0) log.warn("broadcast partial failure", { teamName: input.teamName, errors })
    Team.touch(input.teamName)

    await Bus.publish(TeamEvent.Broadcast, {
      teamName: input.teamName,
      from: input.from,
      text: input.text,
    })

    // Auto-wake all idle recipient sessions
    for (const target of targets) {
      autoWake(target.sessionID, input.from, input.text)
    }
  }

  /**
   * Mark all messages as read in an agent's inbox, then send
   * delivery receipts back to each sender. Receipts are batched
   * per sender and flow through the same inbox + inject + auto-wake
   * path as regular team messages.
   */
  export async function markRead(teamName: string, agentName: string): Promise<number> {
    const read = await Inbox.markRead(teamName, agentName)
    if (read.length === 0) return 0

    // Group by sender for batched receipts.
    // Skip messages that are themselves receipts — sending a receipt for a
    // receipt creates an infinite feedback loop in multi-agent scenarios.
    const bySender = new Map<string, number>()
    for (const msg of read) {
      if (msg.text.startsWith("[receipt]")) continue
      bySender.set(msg.from, (bySender.get(msg.from) ?? 0) + 1)
    }

    // Send a receipt to each distinct sender
    const team = await Team.get(teamName)
    if (team) {
      for (const [sender, count] of bySender) {
        // Find sender's session
        let senderSessionID: string | undefined
        if (sender === "lead") {
          senderSessionID = team.leadSessionID ?? undefined
        } else {
          const member = team.members.find((m) => m.name === sender)
          if (member && member.status !== "shutdown") senderSessionID = member.sessionID
        }
        if (!senderSessionID) continue

        const text = count === 1 ? `${agentName} has read your message` : `${agentName} has read your ${count} messages`

        const receiptId = messageId()
        await Inbox.write(teamName, sender, {
          id: receiptId,
          from: agentName,
          text: `[receipt] ${text}`,
          timestamp: Date.now(),
        }).catch((err: unknown) => {
          log.warn("receipt inbox write failed", {
            teamName,
            sender,
            error: err instanceof Error ? err.message : String(err),
          })
        })

        await injectMessage(senderSessionID, agentName, `[receipt] ${text}`, receiptId).catch((err: unknown) => {
          log.warn("receipt inject failed", {
            teamName,
            sender,
            error: err instanceof Error ? err.message : String(err),
          })
        })

        autoWake(senderSessionID, agentName, `[receipt] ${text}`)
      }
      log.info("delivery receipts sent", { teamName, from: agentName, senders: [...bySender.keys()] })
    }

    return read.length
  }

  /**
   * Reinject unread inbox messages that were never delivered to the session.
   * Deduplicates by inboxMessageId stored in part metadata.
   * Returns the number of messages reinjected.
   */
  export async function recoverInbox(teamName: string, agentName: string, sessionID: string): Promise<number> {
    const pending = await Inbox.unread(teamName, agentName)
    if (pending.length === 0) return 0

    // Find inbox message IDs already present in the session
    const msgs = await Session.messages({ sessionID })
    const delivered = new Set<string>()
    for (const msg of msgs) {
      for (const part of msg.parts) {
        const meta = (part as { metadata?: Record<string, unknown> }).metadata
        if (meta?.inboxMessageId) delivered.add(meta.inboxMessageId as string)
      }
    }

    let count = 0
    for (const msg of pending) {
      if (delivered.has(msg.id)) continue
      await injectMessage(sessionID, msg.from, msg.text, msg.id)
      count++
    }

    if (count > 0)
      log.info("inbox recovery", { teamName, agentName, reinjected: count, skipped: pending.length - count })
    return count
  }

  /**
   * Auto-wake an idle session after a team message is injected.
   * If the session is idle (no active prompt loop), starts a new loop
   * so the LLM picks up and processes the injected message.
   */
  async function autoWake(sessionID: string, from: string, text: string) {
    if (process.env.OPENCODE_DISABLE_TEAM_AUTOWAKE === "1") return
    try {
      const status = await SessionStatus.get(sessionID)
      if (status.type !== "idle") return
      const info = await Team.findBySession(sessionID)
      // Lead auto-wake policy:
      // - Wake for substantive teammate updates so orchestration can continue
      //   without manual nudges.
      // - Do NOT wake on receipts/noise.
      // - Do NOT wake on interruption notices triggered by lead cancellation,
      //   which would immediately restart the lead after an intentional escape.
      if (info?.role === "lead") {
        if (text.startsWith("[receipt]")) return
        if (text.includes("I was interrupted by the lead and am now idle.")) return
        if (text.includes("I was interrupted while working.")) return
      }
      // Don't wake a teammate that's fully shut down.
      // We DO wake for shutdown_requested — the teammate needs to process
      // the shutdown message and wrap up. The .then() handler below
      // transitions shutdown_requested → shutdown when the loop ends.
      if (info && info.role === "member") {
        const member = info.team.members.find((m) => m.name === info.memberName)
        if (member?.status === "shutdown") return
      }
      log.info("auto-waking idle session", { sessionID, from })
      Team.trackLoop(
        sessionID,
        SessionPrompt.loop({ sessionID })
        .then(async () => {
          // When an auto-woken loop ends, check if shutdown was requested.
          // Shutdown is authoritative — the teammate gets one loop to wrap up
          // (summarize findings, send final messages) then transitions to shutdown.
          // Both this handler and the spawn .then() check for shutdown_requested;
          // transitionMemberStatus is idempotent (from === status returns early).
          const match = await Team.findBySession(sessionID)
          if (!match || match.role !== "member") return
          const team = await Team.get(match.team.name)
          const member = team?.members.find((m) => m.name === match.memberName)
          if (member?.status === "shutdown_requested") {
            await Team.transitionMemberStatus(match.team.name, match.memberName!, "shutdown")
            log.info("auto-wake loop completed shutdown", { teamName: match.team.name, name: match.memberName })
          }
        })
        .catch((err: unknown) => {
          log.warn("auto-wake loop failed", { sessionID, error: err instanceof Error ? err.message : String(err) })
        }),
      )
    } catch (err) {
      log.warn("auto-wake failed", { sessionID, error: err instanceof Error ? (err as Error).message : String(err) })
    }
  }

  /**
   * Inject a synthetic user message into a session from a teammate.
   * This is how teammates "receive" messages — as user messages
   * with a TeamMessagePart that the prompt loop will process.
   *
   * If `text` is a structured JSON envelope (from sendStructured), it is
   * first rendered into model-readable text before injection. Raw JSON is
   * never injected into the session history.
   */
  async function injectMessage(
    sessionID: string,
    fromName: string,
    text: string,
    inboxMessageId?: string,
  ): Promise<void> {
    // Render structured messages to human-readable text before injecting.
    // This ensures the model always sees readable instructions, never raw JSON.
    const envelope = parseStructuredContent(text)
    const rendered = envelope ? renderStructuredForModel(envelope) : text

    const msgs = await Session.messages({ sessionID })
    const lastUser = msgs.findLast((m) => m.info.role === "user")
    if (!lastUser) {
      throw new Error(`No user message found in session ${sessionID}`)
    }
    const userInfo = lastUser.info as { agent: string; model: { providerID: string; modelID: string } }

    const msgId = MessageID.ascending()
    await Session.updateMessage({
      id: msgId,
      sessionID,
      role: "user",
      agent: userInfo.agent,
      model: userInfo.model,
      time: { created: Date.now() },
    })

    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msgId,
      sessionID,
      type: "text",
      text: `[Team message from ${fromName}]: ${rendered}`,
      synthetic: true,
      ...(inboxMessageId ? { metadata: { inboxMessageId } } : {}),
    })
  }
}
