/**
 * Pure handler functions for DialogTeam keybinding actions.
 * Extracted for testability — no Solid/TUI context dependencies.
 */

export interface TeamActionDeps {
  teamName: string
  role: "lead" | "member"
  members: Array<{ name: string; sessionID: string }>
  delegate?: boolean
  leadSessionID: string
  sdkUrl: string
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  showToast: (msg: string, variant: "info" | "error") => void
}

/** Parse option value format "type:id" */
function parseOption(value: string): { type: string; id: string } {
  const [type, id] = value.split(":", 2)
  return { type: type ?? "", id: id ?? "" }
}

/**
 * Handle `s` — graceful shutdown of selected member.
 * Lead-only. Shows error toast if not lead or non-member option selected.
 */
export async function handleShutdown(optionValue: string, deps: TeamActionDeps): Promise<void> {
  if (deps.role !== "lead") {
    deps.showToast("Only the team lead can shut down teammates", "error")
    return
  }
  const { type, id: sessionID } = parseOption(optionValue)
  if (type !== "member" || !sessionID) return
  const member = deps.members.find((m) => m.sessionID === sessionID)
  if (!member) return
  await deps
    .fetch(`${deps.sdkUrl}/team/${deps.teamName}/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadSessionID: deps.leadSessionID, member: member.name }),
    })
    .then(() => deps.showToast(`Shutdown requested for ${member.name}`, "info"))
    .catch(() => deps.showToast(`Failed to shutdown ${member.name}`, "error"))
}

/**
 * Handle `k` — cancel (kill) selected member's prompt loop immediately.
 * Lead-only. Shows error toast if not lead.
 */
export async function handleCancel(optionValue: string, deps: TeamActionDeps): Promise<void> {
  if (deps.role !== "lead") {
    deps.showToast("Only the team lead can cancel teammates", "error")
    return
  }
  const { type, id: sessionID } = parseOption(optionValue)
  if (type !== "member" || !sessionID) return
  const member = deps.members.find((m) => m.sessionID === sessionID)
  if (!member) return
  await deps
    .fetch(`${deps.sdkUrl}/team/${deps.teamName}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberName: member.name }),
    })
    .then(() => deps.showToast(`Cancelled ${member.name}`, "info"))
    .catch(() => deps.showToast(`Failed to cancel ${member.name}`, "error"))
}

/**
 * Handle `d` — toggle delegate mode for the team.
 * Lead-only. Reads current delegate state from deps.delegate.
 */
export async function handleDelegateToggle(deps: TeamActionDeps): Promise<void> {
  if (deps.role !== "lead") {
    deps.showToast("Only the team lead can toggle delegate mode", "error")
    return
  }
  const next = !deps.delegate
  await deps
    .fetch(`${deps.sdkUrl}/team/${deps.teamName}/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    })
    .then(() => deps.showToast(`Delegate mode ${next ? "enabled" : "disabled"}`, "info"))
    .catch(() => deps.showToast("Failed to toggle delegate mode", "error"))
}
