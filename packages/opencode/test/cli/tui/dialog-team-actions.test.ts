/**
 * Unit tests for DialogTeam keybinding action handlers (k/s/d).
 *
 * Tests the pure handler functions extracted from dialog-team.tsx
 * without any Solid/TUI/Instance context dependencies.
 */
import { describe, expect, test } from "bun:test"
import { handleShutdown, handleCancel, handleDelegateToggle } from "../../../src/cli/cmd/tui/component/dialog-team-actions"
import type { TeamActionDeps } from "../../../src/cli/cmd/tui/component/dialog-team-actions"

function makeDeps(overrides: Partial<TeamActionDeps> = {}): TeamActionDeps {
  return {
    teamName: "test-team",
    role: "lead",
    members: [
      { name: "worker-1", sessionID: "ses-worker-1" },
      { name: "worker-2", sessionID: "ses-worker-2" },
    ],
    delegate: false,
    leadSessionID: "ses-lead",
    sdkUrl: "http://opencode.internal",
    fetch: async () => new Response("ok", { status: 200 }),
    showToast: () => {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// handleShutdown — `s` keybind
// ---------------------------------------------------------------------------
describe("handleShutdown", () => {
  test("non-lead shows error toast and does not fetch", async () => {
    const toasts: Array<{ msg: string; variant: string }> = []
    const fetched: string[] = []
    const deps = makeDeps({
      role: "member",
      showToast: (msg, variant) => toasts.push({ msg, variant }),
      fetch: async (url) => { fetched.push(url); return new Response("ok") },
    })

    await handleShutdown("member:ses-worker-1", deps)

    expect(toasts).toHaveLength(1)
    expect(toasts[0].variant).toBe("error")
    expect(toasts[0].msg).toContain("Only the team lead")
    expect(fetched).toHaveLength(0)
  })

  test("non-member option type is ignored silently", async () => {
    const fetched: string[] = []
    const deps = makeDeps({
      fetch: async (url) => { fetched.push(url); return new Response("ok") },
    })

    await handleShutdown("task:some-task-id", deps)
    expect(fetched).toHaveLength(0)
  })

  test("unknown sessionID is ignored silently", async () => {
    const fetched: string[] = []
    const deps = makeDeps({
      fetch: async (url) => { fetched.push(url); return new Response("ok") },
    })

    await handleShutdown("member:ses-unknown", deps)
    expect(fetched).toHaveLength(0)
  })

  test("lead + valid member calls shutdown endpoint with correct body", async () => {
    const calls: Array<{ url: string; body: any }> = []
    const toasts: Array<{ msg: string; variant: string }> = []
    const deps = makeDeps({
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init?.body as string ?? "{}") })
        return new Response("ok")
      },
      showToast: (msg, variant) => toasts.push({ msg, variant }),
    })

    await handleShutdown("member:ses-worker-1", deps)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://opencode.internal/team/test-team/shutdown")
    expect(calls[0].body.member).toBe("worker-1")
    expect(calls[0].body.leadSessionID).toBe("ses-lead")
    expect(toasts[0].variant).toBe("info")
    expect(toasts[0].msg).toContain("worker-1")
  })

  test("fetch failure shows error toast", async () => {
    const toasts: Array<{ msg: string; variant: string }> = []
    const deps = makeDeps({
      fetch: async () => { throw new Error("network error") },
      showToast: (msg, variant) => toasts.push({ msg, variant }),
    })

    await handleShutdown("member:ses-worker-1", deps)

    expect(toasts).toHaveLength(1)
    expect(toasts[0].variant).toBe("error")
    expect(toasts[0].msg).toContain("Failed to shutdown")
  })
})

// ---------------------------------------------------------------------------
// handleCancel — `k` keybind
// ---------------------------------------------------------------------------
describe("handleCancel", () => {
  test("non-lead shows error toast and does not fetch", async () => {
    const toasts: Array<{ msg: string; variant: string }> = []
    const fetched: string[] = []
    const deps = makeDeps({
      role: "member",
      showToast: (msg, variant) => toasts.push({ msg, variant }),
      fetch: async (url) => { fetched.push(url); return new Response("ok") },
    })

    await handleCancel("member:ses-worker-1", deps)

    expect(toasts[0].variant).toBe("error")
    expect(toasts[0].msg).toContain("Only the team lead")
    expect(fetched).toHaveLength(0)
  })

  test("lead + valid member calls cancel endpoint with correct body", async () => {
    const calls: Array<{ url: string; body: any }> = []
    const toasts: Array<{ msg: string; variant: string }> = []
    const deps = makeDeps({
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init?.body as string ?? "{}") })
        return new Response("ok")
      },
      showToast: (msg, variant) => toasts.push({ msg, variant }),
    })

    await handleCancel("member:ses-worker-2", deps)

    expect(calls[0].url).toBe("http://opencode.internal/team/test-team/cancel")
    expect(calls[0].body.memberName).toBe("worker-2")
    expect(toasts[0].variant).toBe("info")
    expect(toasts[0].msg).toContain("worker-2")
  })

  test("task option type is ignored silently", async () => {
    const fetched: string[] = []
    const deps = makeDeps({
      fetch: async (url) => { fetched.push(url); return new Response("ok") },
    })

    await handleCancel("task:task-123", deps)
    expect(fetched).toHaveLength(0)
  })

  test("fetch failure shows error toast", async () => {
    const toasts: Array<{ msg: string; variant: string }> = []
    const deps = makeDeps({
      fetch: async () => { throw new Error("network error") },
      showToast: (msg, variant) => toasts.push({ msg, variant }),
    })

    await handleCancel("member:ses-worker-1", deps)

    expect(toasts[0].variant).toBe("error")
    expect(toasts[0].msg).toContain("Failed to cancel")
  })
})

// ---------------------------------------------------------------------------
// handleDelegateToggle — `d` keybind
// ---------------------------------------------------------------------------
describe("handleDelegateToggle", () => {
  test("non-lead shows error toast and does not fetch", async () => {
    const toasts: Array<{ msg: string; variant: string }> = []
    const fetched: string[] = []
    const deps = makeDeps({
      role: "member",
      showToast: (msg, variant) => toasts.push({ msg, variant }),
      fetch: async (url) => { fetched.push(url); return new Response("ok") },
    })

    await handleDelegateToggle(deps)

    expect(toasts[0].variant).toBe("error")
    expect(toasts[0].msg).toContain("Only the team lead")
    expect(fetched).toHaveLength(0)
  })

  test("enables delegate when currently disabled", async () => {
    const calls: Array<{ url: string; body: any }> = []
    const toasts: Array<{ msg: string; variant: string }> = []
    const deps = makeDeps({
      delegate: false,
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init?.body as string ?? "{}") })
        return new Response("ok")
      },
      showToast: (msg, variant) => toasts.push({ msg, variant }),
    })

    await handleDelegateToggle(deps)

    expect(calls[0].url).toBe("http://opencode.internal/team/test-team/delegate")
    expect(calls[0].body.enabled).toBe(true)
    expect(toasts[0].msg).toContain("enabled")
    expect(toasts[0].variant).toBe("info")
  })

  test("disables delegate when currently enabled", async () => {
    const calls: Array<{ url: string; body: any }> = []
    const toasts: Array<{ msg: string; variant: string }> = []
    const deps = makeDeps({
      delegate: true,
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init?.body as string ?? "{}") })
        return new Response("ok")
      },
      showToast: (msg, variant) => toasts.push({ msg, variant }),
    })

    await handleDelegateToggle(deps)

    expect(calls[0].body.enabled).toBe(false)
    expect(toasts[0].msg).toContain("disabled")
  })

  test("fetch failure shows error toast", async () => {
    const toasts: Array<{ msg: string; variant: string }> = []
    const deps = makeDeps({
      fetch: async () => { throw new Error("network error") },
      showToast: (msg, variant) => toasts.push({ msg, variant }),
    })

    await handleDelegateToggle(deps)

    expect(toasts[0].variant).toBe("error")
    expect(toasts[0].msg).toContain("Failed to toggle delegate mode")
  })

  test("correct team name and delegate URL used", async () => {
    const calls: Array<{ url: string }> = []
    const deps = makeDeps({
      teamName: "my-special-team",
      sdkUrl: "http://localhost:4096",
      fetch: async (url) => { calls.push({ url }); return new Response("ok") },
    })

    await handleDelegateToggle(deps)

    expect(calls[0].url).toBe("http://localhost:4096/team/my-special-team/delegate")
  })
})
