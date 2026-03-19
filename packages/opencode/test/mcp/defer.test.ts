import { describe, expect, test, spyOn } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { MCP } from "../../src/mcp"
import { Flag } from "../../src/flag/flag"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("MCP Deferred Tool Loading", () => {
  test("defers tool loading when threshold is met", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { jsonSchema } = await import("ai")

        const mockTools: Record<string, any> = {}
        for (let i = 0; i < 25; i++) {
          mockTools[`mcp_tool_${i}`] = {
            description: `Test tool ${i}`,
            parameters: jsonSchema({ type: "object", properties: {} }),
            execute: async () => `Result ${i}`,
          }
        }

        spyOn(MCP, "tools").mockResolvedValue(mockTools)

        const originalThreshold = Flag.OPENCODE_MCP_DEFER_THRESHOLD
        try {
          // Override the threshold
          ;(Flag as any).OPENCODE_MCP_DEFER_THRESHOLD = 20

          // Initial resolution with empty messages
          const initialTools = await SessionPrompt.resolveTools({
            messages: [],
            agent: {
              permission: [{ permission: "*", action: "allow", pattern: "*" }],
            } as any,
            model: { api: { id: "test" }, providerID: "test" } as any,
            session: { id: "ses_1234" } as any,
            processor: { message: { id: "msg_1" } } as any,
            bypassAgentCheck: true,
          })

          // Should only have the synthetic tool_search tool
          const mcpToolNames = Object.keys(initialTools).filter(
            (name) => name.startsWith("mcp_") || name === "tool_search",
          )
          expect(mcpToolNames.length).toBe(1)
          expect(mcpToolNames[0]).toBe("tool_search")

          // Execute tool_search
          const searchResult = await (initialTools["tool_search"] as any).execute({ query: "tool 5" }, {
            toolCallId: "call_1",
          } as any)
          const searchResultStr = typeof searchResult === "string" ? searchResult : JSON.stringify(searchResult)
          expect(searchResultStr).toContain("mcp_tool_5")

          // Second resolution with completed tool_search tool call in messages
          const subsequentTools = await SessionPrompt.resolveTools({
            messages: [
              {
                role: "assistant",
                parts: [
                  {
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "tool_search",
                    args: { query: "tool 5" },
                  },
                ],
              },
              {
                role: "tool",
                parts: [
                  {
                    type: "tool",
                    tool: "tool_search",
                    state: {
                      status: "completed",
                      metadata: { discoveredTools: ["mcp_tool_5"] },
                    },
                  },
                ],
              },
            ] as any,
            agent: {
              permission: [{ permission: "*", action: "allow", pattern: "*" }],
            } as any,
            model: { api: { id: "test" }, providerID: "test" } as any,
            session: { id: "ses_1234" } as any,
            processor: { message: { id: "msg_2" } } as any,
            bypassAgentCheck: true,
          })

          // Should have tool_search AND mcp_tool_5
          const subsequentMcpToolNames = Object.keys(subsequentTools).filter(
            (name) => name.startsWith("mcp_") || name === "tool_search",
          )
          expect(subsequentMcpToolNames).toContain("tool_search")
          expect(subsequentMcpToolNames).toContain("mcp_tool_5")
        } finally {
          ;(Flag as any).OPENCODE_MCP_DEFER_THRESHOLD = originalThreshold
        }
      },
    })
  })

  test("keeps discovered tools active after compaction", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { jsonSchema } = await import("ai")

        const mockTools: Record<string, any> = {}
        for (let i = 0; i < 25; i++) {
          mockTools[`mcp_tool_${i}`] = {
            description: `Test tool ${i}`,
            parameters: jsonSchema({ type: "object", properties: {} }),
            execute: async () => `Result ${i}`,
          }
        }

        spyOn(MCP, "tools").mockResolvedValue(mockTools)

        const originalThreshold = Flag.OPENCODE_MCP_DEFER_THRESHOLD
        try {
          ;(Flag as any).OPENCODE_MCP_DEFER_THRESHOLD = 20

          const tools = await SessionPrompt.resolveTools({
            messages: [
              {
                info: { id: "msg_1", role: "user" },
                parts: [
                  {
                    id: "part_1",
                    sessionID: "ses_1234",
                    messageID: "msg_1",
                    type: "compaction",
                    auto: true,
                    discoveredTools: ["mcp_tool_5"],
                  },
                ],
              },
            ] as any,
            agent: {
              permission: [{ permission: "*", action: "allow", pattern: "*" }],
            } as any,
            model: { api: { id: "test" }, providerID: "test" } as any,
            session: { id: "ses_1234" } as any,
            processor: { message: { id: "msg_2" } } as any,
            bypassAgentCheck: true,
          })

          const names = Object.keys(tools).filter((name) => name.startsWith("mcp_") || name === "tool_search")
          expect(names).toContain("tool_search")
          expect(names).toContain("mcp_tool_5")
        } finally {
          ;(Flag as any).OPENCODE_MCP_DEFER_THRESHOLD = originalThreshold
        }
      },
    })
  })

  test("keeps alwaysLoadTools pinned even when MCP tools are deferred", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          gemini: {
            type: "local",
            command: ["npx", "gemini"],
            alwaysLoadTools: ["web_search"],
            instructions: "Use this server for comprehensive web search.",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { jsonSchema } = await import("ai")
        spyOn(MCP, "tools").mockResolvedValue({
          gemini_web_search: {
            description: "Search the web",
            parameters: jsonSchema({ type: "object", properties: {} }),
            execute: async () => "search",
          },
          gemini_other_tool: {
            description: "Other deferred tool",
            parameters: jsonSchema({ type: "object", properties: {} }),
            execute: async () => "other",
          },
        } as any)
        spyOn(MCP, "toolMeta").mockResolvedValue({
          gemini_web_search: { server: "gemini", tool: "web_search" },
          gemini_other_tool: { server: "gemini", tool: "other_tool" },
        })

        const originalThreshold = Flag.OPENCODE_MCP_DEFER_THRESHOLD
        try {
          ;(Flag as any).OPENCODE_MCP_DEFER_THRESHOLD = 1
          const tools = await SessionPrompt.resolveTools({
            messages: [],
            agent: { permission: [{ permission: "*", action: "allow", pattern: "*" }] } as any,
            model: { api: { id: "test" }, providerID: "test" } as any,
            session: { id: "ses_1234" } as any,
            processor: { message: { id: "msg_1" } } as any,
            bypassAgentCheck: true,
          })

          const names = Object.keys(tools).filter((name) => name.startsWith("gemini_") || name === "tool_search")
          expect(names).toContain("gemini_web_search")
          expect(names).toContain("tool_search")
          expect(names).not.toContain("gemini_other_tool")
        } finally {
          ;(Flag as any).OPENCODE_MCP_DEFER_THRESHOLD = originalThreshold
        }
      },
    })
  })
})
