import { expect, test, beforeEach, afterEach } from "bun:test"
import { isNetworkRestricted } from "../../src/util/network"
import { Config } from "../../src/config/config"
import { Sandbox } from "../../src/sandbox"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

let originalHardened: string | undefined

beforeEach(() => {
  originalHardened = process.env.OPENCODE_HARDENED_MODE
  process.env.OPENCODE_HARDENED_MODE = "true"
})

afterEach(() => {
  if (originalHardened !== undefined) {
    process.env.OPENCODE_HARDENED_MODE = originalHardened
  } else {
    delete process.env.OPENCODE_HARDENED_MODE
  }
})

test("isNetworkRestricted returns false when sandbox is none", async () => {
  await using tmp = await tmpdir({
    config: { sandbox: { bash: "none" } },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Mock Sandbox.available to return a fake backend if needed
      expect(await isNetworkRestricted()).toBe(false)
    },
  })
})

test("isNetworkRestricted returns false when sandbox network is true", async () => {
  await using tmp = await tmpdir({
    config: { sandbox: { bash: "auto", network: true } },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await isNetworkRestricted()).toBe(false)
    },
  })
})

test("isNetworkRestricted returns true when sandbox network is false", async () => {
  // We need Sandbox.available to not return 'none' for this to work
  // since network is only restricted if a sandbox is actually running
  const originalAvailable = Sandbox.available
  Sandbox.available = () => "namespace" as any

  try {
    await using tmp = await tmpdir({
      config: { sandbox: { bash: "auto", network: false } },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await isNetworkRestricted()).toBe(true)
      },
    })
  } finally {
    Sandbox.available = originalAvailable
  }
})
