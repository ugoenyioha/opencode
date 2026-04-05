import { Bus } from "../bus"
import { Log } from "../util/log"
import { PermissionNext } from "../permission/next"
import { Team } from "."
import { TeamMessaging } from "./messaging"
import { newRequestId, TeamEvent, type StructuredEnvelope } from "./events"
import { Inbox } from "./inbox"

const log = Log.create({ service: "team.permission-routing" })

/** How long a teammate waits for the lead to respond before auto-rejecting (ms) */
const TIMEOUT_MS = 5 * 60 * 1000

/** Poll interval while waiting for a permission_response in the inbox (ms) */
const POLL_MS = 1_500

/**
 * Poll the teammate's inbox for a permission_response matching rid.
 * Returns true (allow) or false (deny). Throws on timeout.
 */
async function waitForResponse(
  teamName: string,
  memberName: string,
  rid: string,
): Promise<boolean> {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const msgs = await Inbox.unread(teamName, memberName)
    for (const msg of msgs) {
      if (!msg.text.startsWith("{")) continue
      try {
        const env = JSON.parse(msg.text) as StructuredEnvelope
        if (
          env.__structured === true &&
          env.msg.type === "permission_response" &&
          env.msg.request_id === rid
        ) {
          return env.msg.allow
        }
      } catch {
        // not JSON / wrong shape — skip
      }
    }
    await Bun.sleep(POLL_MS)
  }
  throw new Error(`Permission request timed out after ${TIMEOUT_MS / 1000}s — lead did not respond.`)
}

/**
 * Phase 2: poll for the lead's response and call PermissionNext.reply().
 * Runs detached so Bus.publish can return and the lead can write the response.
 * AsyncLocalStorage context is inherited from the caller's async chain.
 */
async function pollAndReply(
  teamName: string,
  memberName: string,
  rid: string,
  requestID: string,
) {
  let allow: boolean
  try {
    allow = await waitForResponse(teamName, memberName, rid)
  } catch (err) {
    log.warn("permission routing timed out — rejecting", {
      teamName,
      memberName,
      rid,
      error: err instanceof Error ? err.message : String(err),
    })
    await PermissionNext.reply({ requestID, reply: "reject" }).catch(() => {})
    return
  }

  log.info("permission response received", { teamName, memberName, rid, allow })

  await PermissionNext.reply({
    requestID,
    reply: allow ? "once" : "reject",
  }).catch((err: unknown) => {
    log.warn("failed to apply permission reply", {
      rid,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * Subscribe to PermissionNext.Event.Asked.
 *
 * For teammate sessions:
 *   Phase 1 (awaited by Bus.publish): look up team context, send permission_request
 *     to lead inbox, emit TeamEvent.PermissionRequest. All fast DB ops.
 *   Phase 2 (detached via Promise): poll inbox for lead's response, call
 *     PermissionNext.reply(). Detached so Bus.publish can return — otherwise
 *     Bus.publish would block indefinitely (deadlock: lead's response would
 *     also need to go through Bus.publish).
 *
 * AsyncLocalStorage context propagates through Promise chains in Node/Bun,
 * so Phase 2 still runs in the correct Instance context.
 *
 * Non-teammate sessions are silently ignored (normal TUI path continues).
 * Returns the unsubscribe function for cleanup.
 */
export function initPermissionRouting(): () => void {
  return Bus.subscribe(PermissionNext.Event.Asked, async (evt) => {
    const req = evt.properties
    const info = await Team.findBySession(req.sessionID)
    if (!info || info.role !== "member") return

    const memberName = info.memberName!
    const teamName = info.team.name
    const rid = newRequestId()

    log.info("routing permission request to lead", {
      teamName,
      memberName,
      permission: req.permission,
      rid,
    })

    // Phase 1: send permission_request to lead inbox (synchronous with Bus.publish)
    const sendErr = await TeamMessaging.sendStructured({
      teamName,
      from: memberName,
      to: "lead",
      msg: {
        type: "permission_request",
        request_id: rid,
        tool_name: req.permission,
        tool_input: JSON.stringify(req.metadata ?? {}),
      },
    }).then(
      () => null,
      (err: unknown) => err,
    )

    if (sendErr) {
      log.warn("failed to send permission_request to lead — auto-rejecting", {
        teamName,
        memberName,
        error: sendErr instanceof Error ? sendErr.message : String(sendErr),
      })
      await PermissionNext.reply({ requestID: req.id, reply: "reject" }).catch(() => {})
      return
    }

    await Bus.publish(TeamEvent.PermissionRequest, {
      teamName,
      memberName,
      requestId: rid,
      toolName: req.permission,
      toolInput: JSON.stringify(req.metadata ?? {}),
    })

    // Phase 2: detach polling — do NOT await.
    // AsyncLocalStorage context is propagated through the Promise chain.
    void pollAndReply(teamName, memberName, rid, req.id)
  })
}

/**
 * Alias used by bootstrap. Returns unsubscribe for cleanup.
 */
export const setupPermissionRouting = initPermissionRouting
