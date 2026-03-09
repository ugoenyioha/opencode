import { describe, expect, test, spyOn } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"

const root = path.join(__dirname, "../..")

describe("Plugin hooks", () => {
  test("config.change is triggered on update", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: root,
      fn: async () => {
        const triggerSpy = spyOn(Plugin, "trigger")
        await Config.update({ experimental: { mcp_timeout: 1000 } })
        expect(triggerSpy).toHaveBeenCalledWith("config.change", {}, {})
      },
    })
  })

  test("chat.instructions.loaded is triggered on session loop", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const triggerSpy = spyOn(Plugin, "trigger")
        const session = await Session.create({})

        const llmSpy = spyOn(LLM, "stream").mockResolvedValue({
          finishReason: "stop",
          text: Promise.resolve("hi"),
          calls: [],
          usage: { promptTokens: 0, completionTokens: 0 },
        } as any)

        await SessionPrompt.prompt({
          sessionID: session.id,
          parts: [{ type: "text", text: "hello" }],
        })

        expect(triggerSpy).toHaveBeenCalledWith(
          "chat.instructions.loaded",
          expect.objectContaining({
            sessionID: session.id,
            agent: expect.any(String),
            model: expect.any(Object),
          }),
          expect.objectContaining({
            instructions: expect.any(Array),
          }),
        )

        llmSpy.mockRestore()
      },
    })
  })
})
