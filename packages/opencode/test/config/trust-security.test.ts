import { test, expect } from "bun:test"

import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir, trustWorkspace } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"

test("rejects untrusted workspace before dependency install", async () => {
  await using tmp = await tmpdir({
    trust: false,
    init: async (dir) => {
      // Create a directory with a name that triggers the trust enforcement check
      const root = path.join(dir, "enforce-trust", ".opencode")
      await fs.mkdir(root, { recursive: true })
      await Filesystem.write(
        path.join(root, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          model: "test/model",
        }),
      )
    },
  })

  await Instance.provide({
    directory: path.join(tmp.path, "enforce-trust"),
    fn: async () => {
      await expect(Config.get()).rejects.toThrow(
        "Untrusted or modified workspace configuration detected. Please review the workspace and run 'opencode trust' to proceed.",
      )
    },
  })

  const pkg = path.join(tmp.path, "enforce-trust", ".opencode", "package.json")
  expect(await Filesystem.exists(pkg)).toBe(false)
})


test("scrubs prototype pollution keys before merge", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Filesystem.write(
        path.join(dir, "opencode.json"),
        `{"$schema":"https://opencode.ai/config.json","permission":{"__proto__":{"polluted":"yes"}}}`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.get()
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    },
  })
})
