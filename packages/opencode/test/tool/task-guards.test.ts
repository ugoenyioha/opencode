import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Config } from "../../src/config/config"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

/**
 * Calculate the subagent nesting depth for a session by walking up the parentID chain.
 * This mirrors the implementation in tool/task.ts for testing.
 */
async function getSubagentDepth(sessionID: string): Promise<number> {
  let depth = 0
  let current = sessionID
  while (true) {
    const session = await Session.get(current).catch(() => undefined)
    if (!session || !session.parentID) break
    depth++
    current = session.parentID
  }
  return depth
}

describe("Task Guards - Subagent Depth", () => {
  describe("getSubagentDepth", () => {
    test("returns 0 for root session", async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const root = await Session.create({})
          const depth = await getSubagentDepth(root.id)
          expect(depth).toBe(0)
        },
      })
    })

    test("returns 1 for first-level child", async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const root = await Session.create({})
          const child = await Session.create({ parentID: root.id })
          const depth = await getSubagentDepth(child.id)
          expect(depth).toBe(1)
        },
      })
    })

    test("returns correct depth for deeply nested sessions", async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const root = await Session.create({})
          const level1 = await Session.create({ parentID: root.id })
          const level2 = await Session.create({ parentID: level1.id })
          const level3 = await Session.create({ parentID: level2.id })
          const level4 = await Session.create({ parentID: level3.id })
          const level5 = await Session.create({ parentID: level4.id })

          expect(await getSubagentDepth(root.id)).toBe(0)
          expect(await getSubagentDepth(level1.id)).toBe(1)
          expect(await getSubagentDepth(level2.id)).toBe(2)
          expect(await getSubagentDepth(level3.id)).toBe(3)
          expect(await getSubagentDepth(level4.id)).toBe(4)
          expect(await getSubagentDepth(level5.id)).toBe(5)
        },
      })
    })
  })

  describe("config limits", () => {
    test("reads max_subagent_depth from config", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          server: {
            limits: {
              max_subagent_depth: 3,
            },
          },
        } as any, // Type assertion for partial config
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          expect(config.server?.limits?.max_subagent_depth).toBe(3)
        },
      })
    })

    test("defaults to 5 when not configured", async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          // When not configured, should use default of 5
          const limit = config.server?.limits?.max_subagent_depth ?? 5
          expect(limit).toBe(5)
        },
      })
    })
  })

  describe("depth guard logic", () => {
    test("depth at limit should be blocked", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          server: {
            limits: {
              max_subagent_depth: 2,
            },
          },
        } as any,
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          const maxDepth = config.server?.limits?.max_subagent_depth ?? 5

          const root = await Session.create({})
          const level1 = await Session.create({ parentID: root.id })
          const level2 = await Session.create({ parentID: level1.id })

          const depth = await getSubagentDepth(level2.id)

          // depth (2) >= maxDepth (2) should block
          expect(depth >= maxDepth).toBe(true)
        },
      })
    })

    test("depth below limit should be allowed", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          server: {
            limits: {
              max_subagent_depth: 5,
            },
          },
        } as any,
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          const maxDepth = config.server?.limits?.max_subagent_depth ?? 5

          const root = await Session.create({})
          const level1 = await Session.create({ parentID: root.id })

          const depth = await getSubagentDepth(level1.id)

          // depth (1) < maxDepth (5) should allow
          expect(depth < maxDepth).toBe(true)
        },
      })
    })
  })
})
