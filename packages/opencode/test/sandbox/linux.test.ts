import { describe, expect, test } from "bun:test"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Plugin } from "../../src/plugin"

describe("Linux Sandbox Backends", () => {
  const isLinux = process.platform === "linux"

  test.if(isLinux)("executes bash securely using namespace backend", async () => {
    await using tmp = await tmpdir({
      config: {
        permission: { bash: "allow" },
        sandbox: { bash: "namespace", network: true },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        const tool = await BashTool.init()

        const result = await tool.execute({ command: "echo 'hello from namespace'", description: "test" }, {
          sessionID: "test",
          callID: "test",
          abort: new AbortController().signal,
          ask: async () => {},
          metadata: () => {},
        } as any)

        expect(result.output).toContain("hello from namespace")
      },
    })
  })

  test.if(isLinux)("executes bash securely using bwrap backend", async () => {
    await using tmp = await tmpdir({
      config: {
        permission: { bash: "allow" },
        sandbox: { bash: "bwrap", network: true },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        const tool = await BashTool.init()

        const result = await tool.execute({ command: "echo 'hello from bwrap'", description: "test" }, {
          sessionID: "test",
          callID: "test",
          abort: new AbortController().signal,
          ask: async () => {},
          metadata: () => {},
        } as any)

        expect(result.output).toContain("hello from bwrap")
      },
    })
  })

  test.if(isLinux)("executes bash securely using gvisor backend", async () => {
    await using tmp = await tmpdir({
      config: {
        permission: { bash: "allow" },
        sandbox: { bash: "gvisor", network: true },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        const tool = await BashTool.init()

        const result = await tool.execute({ command: "echo 'hello from gvisor'", description: "test" }, {
          sessionID: "test",
          callID: "test",
          abort: new AbortController().signal,
          ask: async () => {},
          metadata: () => {},
        } as any)

        expect(result.output).toContain("hello from gvisor")
      },
    })
  })
})
