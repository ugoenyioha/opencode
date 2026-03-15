import { describe, expect, spyOn, test } from "bun:test"
import { MCP } from "../../src/mcp"
import { McpElicitation } from "../../src/mcp/elicitation"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("mcp elicitation", () => {
  test("retries tool execution with elicitation reply merged into args", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const calls: unknown[] = []
        let idx = 0
        const client = {
          async callTool(input: { arguments?: unknown }) {
            calls.push(input.arguments ?? {})
            idx += 1
            if (idx === 1) {
              const err = new Error("needs elicitation") as Error & {
                code: number
                data: { elicitations: { message: string; elicitationId: string }[] }
              }
              err.code = -32042
              err.data = {
                elicitations: [
                  {
                    message: "Please confirm before continuing.",
                    elicitationId: "elic-123",
                  },
                ],
              }
              throw err
            }
            return {
              content: [
                {
                  type: "text",
                  text: "ok",
                },
              ],
            }
          },
        }

        const tool = await MCP.tool(
          {
            name: "lookup",
            description: "lookup test",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
            },
          } as any,
          client as any,
        )

        const ask = spyOn(McpElicitation, "ask")
        const run = tool.execute!({ query: "phase4" }, { toolCallId: "call_1" } as any)

        for (let i = 0; i < 30 && ask.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }

        expect(ask.mock.calls.length).toBe(1)
        const input = ask.mock.calls[0]![0]
        expect(input.tool).toBe("lookup")
        expect(input.prompt).toEqual({
          message: "Please confirm before continuing.",
          elicitationId: "elic-123",
        })

        await McpElicitation.reply({
          requestID: input.requestID,
          text: "approved",
        })

        const out = await run
        expect(out.content[0].type).toBe("text")

        expect(calls.length).toBe(2)
        expect(calls[0]).toEqual({ query: "phase4" })
        expect(calls[1]).toEqual({ query: "phase4", text: "approved" })

        ask.mockRestore()
      },
    })
  })

  test("merges structured elicitation data into tool args", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const calls: unknown[] = []
        let idx = 0
        const client = {
          async callTool(input: { arguments?: unknown }) {
            calls.push(input.arguments ?? {})
            idx += 1
            if (idx === 1) {
              const err = new Error("needs elicitation") as Error & {
                code: number
                data: {
                  elicitations: [{ message: string; fields: { name: string; type: string; required: boolean }[] }]
                }
              }
              err.code = -32042
              err.data = {
                elicitations: [
                  {
                    message: "Need deployment details.",
                    fields: [{ name: "env", type: "text", required: true }],
                  },
                ],
              }
              throw err
            }
            return {
              content: [{ type: "text", text: "ok" }],
            }
          },
        }

        const tool = await MCP.tool(
          {
            name: "deploy",
            description: "deploy test",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
            },
          } as any,
          client as any,
        )

        const ask = spyOn(McpElicitation, "ask")
        const run = tool.execute!({ query: "phase4" }, { toolCallId: "call_2" } as any)

        for (let i = 0; i < 30 && ask.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }

        const input = ask.mock.calls[0]![0]
        expect(input.prompt).toEqual({
          message: "Need deployment details.",
          fields: [{ name: "env", type: "text", required: true }],
        })

        await McpElicitation.reply({
          requestID: input.requestID,
          data: { env: "prod" },
        })

        await run
        expect(calls[1]).toEqual({ query: "phase4", env: "prod" })

        ask.mockRestore()
      },
    })
  })
})
