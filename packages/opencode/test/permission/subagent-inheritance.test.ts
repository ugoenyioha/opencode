import { describe, test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"

describe("subagent permission inheritance (#12566)", () => {
  test("child session inherits parent agent allow-all permission", () => {
    // Parent agent (e.g., "build") configured with "allow": "*"
    const parentPermission: PermissionNext.Ruleset = [
      { permission: "*", pattern: "*", action: "allow" },
    ]

    // Parent session may have accumulated rules (e.g., from "always" replies)
    const parentSessionPermission: PermissionNext.Ruleset = []

    // Subagent-specific overrides
    const childOverrides: PermissionNext.Ruleset = [
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ]

    // This is how the child session permission should be assembled:
    // parent agent rules + parent session rules + child overrides
    const childSessionPermission = PermissionNext.merge(
      parentPermission,
      parentSessionPermission,
      childOverrides,
    )

    // The subagent's own permission (e.g., "general" agent defaults)
    const subagentPermission: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "ask" },
    ]

    // In the child session, the effective ruleset is:
    // merge(subagent.permission, childSession.permission)
    const effective = PermissionNext.merge(subagentPermission, childSessionPermission)

    // bash should evaluate to "allow" because the parent agent's allow-all
    // rule is in the child session's permission and comes after the subagent's "ask"
    const bashRule = PermissionNext.evaluate("bash", "ls", effective)
    expect(bashRule.action).toBe("allow")

    // edit should also be allowed
    const editRule = PermissionNext.evaluate("edit", "src/foo.ts", effective)
    expect(editRule.action).toBe("allow")

    // But todowrite should be denied (child override takes precedence)
    const todoRule = PermissionNext.evaluate("todowrite", "*", effective)
    expect(todoRule.action).toBe("deny")

    // task should be denied (child override)
    const taskRule = PermissionNext.evaluate("task", "general", effective)
    expect(taskRule.action).toBe("deny")
  })

  test("child session without parent inheritance falls back to ask", () => {
    // This simulates the OLD behavior (bug) where parent rules are not inherited
    const childOverrides: PermissionNext.Ruleset = [
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ]

    // Subagent's own permission without user config allow-all
    const subagentPermission: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "ask" },
    ]

    // Without parent inheritance, the merge only has subagent + child overrides
    const effective = PermissionNext.merge(subagentPermission, childOverrides)

    // bash evaluates to "ask" — this would block in unattended mode
    const bashRule = PermissionNext.evaluate("bash", "ls", effective)
    expect(bashRule.action).toBe("ask")
  })

  test("parent session accumulated rules propagate to child", () => {
    // Parent agent has default ask-for-bash
    const parentPermission: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "ask" },
    ]

    // But the user replied "always" for bash during the parent session,
    // which gets stored in the parent session's permission
    const parentSessionPermission: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "allow" },
    ]

    const childOverrides: PermissionNext.Ruleset = [
      { permission: "todowrite", pattern: "*", action: "deny" },
    ]

    const childSessionPermission = PermissionNext.merge(
      parentPermission,
      parentSessionPermission,
      childOverrides,
    )

    const subagentPermission: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "ask" },
    ]

    const effective = PermissionNext.merge(subagentPermission, childSessionPermission)

    // bash should be "allow" because the parent session's accumulated
    // "always allow" comes after the agent defaults
    const bashRule = PermissionNext.evaluate("bash", "ls", effective)
    expect(bashRule.action).toBe("allow")
  })

  test("merge preserves last-wins semantics with findLast", () => {
    // PermissionNext.evaluate uses findLast, so later rules win
    const rules: PermissionNext.Ruleset = [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "ask" },
    ]
    const result = PermissionNext.evaluate("bash", "ls", rules)
    expect(result.action).toBe("ask") // last matching rule wins
  })

  test("child deny overrides parent allow for specific permissions", () => {
    // Parent allows everything
    const parentPermission: PermissionNext.Ruleset = [
      { permission: "*", pattern: "*", action: "allow" },
    ]

    // Child explicitly denies task (subagent should not spawn sub-subagents)
    const childOverrides: PermissionNext.Ruleset = [
      { permission: "task", pattern: "*", action: "deny" },
    ]

    // Child session permission = parent + child overrides
    // The child deny comes AFTER the parent allow
    const childSessionPermission = PermissionNext.merge(parentPermission, childOverrides)

    const subagentPermission: PermissionNext.Ruleset = []
    const effective = PermissionNext.merge(subagentPermission, childSessionPermission)

    // task should be denied because the child's deny comes last
    const taskRule = PermissionNext.evaluate("task", "general", effective)
    expect(taskRule.action).toBe("deny")

    // bash should be allowed via the parent's wildcard allow
    const bashRule = PermissionNext.evaluate("bash", "ls", effective)
    expect(bashRule.action).toBe("allow")
  })
})
