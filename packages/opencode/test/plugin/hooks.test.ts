import { describe, expect, test, spyOn } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MCP } from "../../src/mcp"
import { McpElicitation } from "../../src/mcp/elicitation"

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

  test("mcp elicitation hooks can auto-answer requests", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const triggerSpy = spyOn(Plugin, "trigger").mockImplementation(async (name, input, output) => {
          if (name === "mcp.elicitation") {
            return { ...output, response: { text: "approved" } } as any
          }
          return output as any
        })

        const calls: unknown[] = []
        let idx = 0
        const client = {
          async callTool(input: { arguments?: unknown }) {
            calls.push(input.arguments ?? {})
            idx += 1
            if (idx === 1) {
              const err = new Error("needs elicitation") as Error & {
                code: number
                data: { elicitations: { message: string }[] }
              }
              err.code = -32042
              err.data = {
                elicitations: [{ message: "Please confirm before continuing." }],
              }
              throw err
            }
            return { content: [{ type: "text", text: "ok" }] }
          },
        }

        const ask = spyOn(McpElicitation, "ask")
        const tool = await MCP.tool(
          {
            name: "lookup",
            description: "lookup test",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          } as any,
          client as any,
        )

        await tool.execute!({ query: "phase4" }, { toolCallId: "call_1" } as any)

        expect(ask).not.toHaveBeenCalled()
        expect(triggerSpy).toHaveBeenCalledWith(
          "mcp.elicitation",
          expect.objectContaining({ tool: "lookup" }),
          expect.objectContaining({ reject: false }),
        )
        expect(calls[1]).toEqual({ query: "phase4", text: "approved" })

        ask.mockRestore()
        triggerSpy.mockRestore()
      },
    })
  })
})
