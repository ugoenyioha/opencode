import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const projectRoot = path.join(__dirname, "../..")

describe("session.summarize", () => {
  test("endpoint accepts instructions parameter", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            auto: false,
            instructions: "focus on the authentication flow",
          }),
        })

        // Schema validation passes - if provider is found it returns 200,
        // if provider not found (test env with cached instance) it returns 400 with ProviderModelNotFoundError
        const body = (await response.json()) as { name?: string }
        if (response.status === 400) {
          // Acceptable in full test suite where provider cache may not have our key
          expect(body.name).toBe("ProviderModelNotFoundError")
        } else {
          expect(response.status).toBe(200)
        }
      },
    })
  })

  test("endpoint accepts request without instructions", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            auto: false,
          }),
        })

        const body = (await response.json()) as { name?: string }
        if (response.status === 400) {
          expect(body.name).toBe("ProviderModelNotFoundError")
        } else {
          expect(response.status).toBe(200)
        }
      },
    })
  })

  test("endpoint rejects invalid instructions type", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            auto: false,
            instructions: 12345,
          }),
        })

        expect(response.status).toBe(400)
      },
    })
  })

  test("endpoint rejects missing required fields", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            auto: false,
          }),
        })

        expect(response.status).toBe(400)
      },
    })
  })
})

describe("session.compaction.create", () => {
  test("stores compaction part", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const session = await Session.create({})

        await SessionCompaction.create({
          sessionID: session.id,
          agent: "code",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          auto: true,
        })

        const msgs = await Session.messages({ sessionID: session.id })
        const compactionPart = msgs.flatMap((m) => m.parts).find((p) => p.type === "compaction")

        expect(compactionPart).toBeDefined()
        expect(compactionPart!.type).toBe("compaction")
        if (compactionPart!.type === "compaction") {
          expect(compactionPart!.auto).toBe(true)
        }
      },
    })
  })

  test("stores compaction part when auto is false", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const session = await Session.create({})

        await SessionCompaction.create({
          sessionID: session.id,
          agent: "code",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          auto: false,
        })

        const msgs = await Session.messages({ sessionID: session.id })
        const compactionPart = msgs.flatMap((m) => m.parts).find((p) => p.type === "compaction")

        expect(compactionPart).toBeDefined()
        expect(compactionPart!.type).toBe("compaction")
        if (compactionPart!.type === "compaction") {
          expect(compactionPart!.auto).toBe(false)
        }
      },
    })
  })

  test("stores compaction part without boundaryMessageID", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const session = await Session.create({})

        await SessionCompaction.create({
          sessionID: session.id,
          agent: "code",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          auto: false,
        })

        const msgs = await Session.messages({ sessionID: session.id })
        const compactionPart = msgs.flatMap((m) => m.parts).find((p) => p.type === "compaction")

        expect(compactionPart).toBeDefined()
        expect(compactionPart!.type).toBe("compaction")
        if (compactionPart!.type === "compaction") {
          expect(compactionPart!.auto).toBe(false)
        }
      },
    })
  })
})

describe("session.summarize with boundaryMessageID", () => {
  test("endpoint accepts boundaryMessageID parameter", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            auto: false,
            boundaryMessageID: "msg_some_message_id",
          }),
        })

        const body = (await response.json()) as { name?: string }
        if (response.status === 400) {
          expect(body.name).toBe("ProviderModelNotFoundError")
        } else {
          expect(response.status).toBe(200)
        }
      },
    })
  })

  test("endpoint rejects invalid boundaryMessageID type", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            auto: false,
            boundaryMessageID: 12345,
          }),
        })

        expect(response.status).toBe(400)
      },
    })
  })
})

describe("filterCompacted with boundaryMessageID", () => {
  // Helper to create a mock async iterable of messages (newest first, as stream() yields)
  async function* mockStream(messages: MessageV2.WithParts[]): AsyncIterable<MessageV2.WithParts> {
    // stream() yields newest first
    for (let i = messages.length - 1; i >= 0; i--) {
      yield messages[i]
    }
  }

  test("full compaction drops all messages before boundary", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        // Simulate: msg1 (user) -> msg2 (assistant) -> msg3 (user) -> msg4 (assistant)
        //           -> msg5 (compaction user) -> msg6 (summary assistant)
        // Full compaction (no boundary) should keep only msg5 + msg6
        const messages: MessageV2.WithParts[] = [
          {
            info: {
              id: "01",
              sessionID: "s1",
              role: "user" as const,
              time: { created: 1 },
              agent: "code",
              model: { providerID: "a", modelID: "m" },
            },
            parts: [
              { id: "p01", messageID: "01", sessionID: "s1", type: "text" as const, text: "hello" },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "02",
              sessionID: "s1",
              role: "assistant" as const,
              time: { created: 2 },
              parentID: "01",
              modelID: "m",
              providerID: "a",
              agent: "code",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            } as MessageV2.Assistant,
            parts: [
              { id: "p02", messageID: "02", sessionID: "s1", type: "text" as const, text: "hi" },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "03",
              sessionID: "s1",
              role: "user" as const,
              time: { created: 3 },
              agent: "code",
              model: { providerID: "a", modelID: "m" },
            },
            parts: [
              { id: "p03", messageID: "03", sessionID: "s1", type: "text" as const, text: "do stuff" },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "04",
              sessionID: "s1",
              role: "assistant" as const,
              time: { created: 4 },
              parentID: "03",
              modelID: "m",
              providerID: "a",
              agent: "code",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            } as MessageV2.Assistant,
            parts: [
              { id: "p04", messageID: "04", sessionID: "s1", type: "text" as const, text: "did stuff" },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "05",
              sessionID: "s1",
              role: "user" as const,
              time: { created: 5 },
              agent: "code",
              model: { providerID: "a", modelID: "m" },
            },
            parts: [
              { id: "p05", messageID: "05", sessionID: "s1", type: "compaction" as const, auto: false },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "06",
              sessionID: "s1",
              role: "assistant" as const,
              time: { created: 6 },
              parentID: "05",
              modelID: "m",
              providerID: "a",
              agent: "compaction",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              summary: true,
              finish: "stop",
            } as MessageV2.Assistant,
            parts: [
              { id: "p06", messageID: "06", sessionID: "s1", type: "text" as const, text: "summary" },
            ] as MessageV2.Part[],
          },
        ]

        const result = await MessageV2.filterCompacted(mockStream(messages))
        // Full compaction: keeps compaction user msg + summary assistant
        expect(result.length).toBe(2)
        expect(result[0].info.id).toBe("05")
        expect(result[1].info.id).toBe("06")
      },
    })
  })

  test("partial compaction keeps messages from boundary onward", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        // Simulate: msg1 (user) -> msg2 (assistant) -> msg3 (user) -> msg4 (assistant)
        //           -> msg5 (compaction user, boundary=msg3) -> msg6 (summary assistant)
        // Partial compaction: should keep msg3, msg4, msg5, msg6 (drop msg1, msg2)
        const messages: MessageV2.WithParts[] = [
          {
            info: {
              id: "01",
              sessionID: "s1",
              role: "user" as const,
              time: { created: 1 },
              agent: "code",
              model: { providerID: "a", modelID: "m" },
            },
            parts: [
              { id: "p01", messageID: "01", sessionID: "s1", type: "text" as const, text: "hello" },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "02",
              sessionID: "s1",
              role: "assistant" as const,
              time: { created: 2 },
              parentID: "01",
              modelID: "m",
              providerID: "a",
              agent: "code",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            } as MessageV2.Assistant,
            parts: [
              { id: "p02", messageID: "02", sessionID: "s1", type: "text" as const, text: "hi" },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "03",
              sessionID: "s1",
              role: "user" as const,
              time: { created: 3 },
              agent: "code",
              model: { providerID: "a", modelID: "m" },
            },
            parts: [
              { id: "p03", messageID: "03", sessionID: "s1", type: "text" as const, text: "do stuff" },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "04",
              sessionID: "s1",
              role: "assistant" as const,
              time: { created: 4 },
              parentID: "03",
              modelID: "m",
              providerID: "a",
              agent: "code",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            } as MessageV2.Assistant,
            parts: [
              { id: "p04", messageID: "04", sessionID: "s1", type: "text" as const, text: "did stuff" },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "05",
              sessionID: "s1",
              role: "user" as const,
              time: { created: 5 },
              agent: "code",
              model: { providerID: "a", modelID: "m" },
            },
            parts: [
              {
                id: "p05",
                messageID: "05",
                sessionID: "s1",
                type: "compaction" as const,
                auto: false,
                boundaryMessageID: "03",
              },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "06",
              sessionID: "s1",
              role: "assistant" as const,
              time: { created: 6 },
              parentID: "05",
              modelID: "m",
              providerID: "a",
              agent: "compaction",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              summary: true,
              finish: "stop",
            } as MessageV2.Assistant,
            parts: [
              { id: "p06", messageID: "06", sessionID: "s1", type: "text" as const, text: "summary of old stuff" },
            ] as MessageV2.Part[],
          },
        ]

        const result = await MessageV2.filterCompacted(mockStream(messages))
        // Partial compaction with boundary at msg3: keeps msg3, msg4, msg5 (compaction), msg6 (summary)
        expect(result.length).toBe(4)
        expect(result[0].info.id).toBe("03")
        expect(result[1].info.id).toBe("04")
        expect(result[2].info.id).toBe("05")
        expect(result[3].info.id).toBe("06")
      },
    })
  })

  test("no compaction returns all messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const messages: MessageV2.WithParts[] = [
          {
            info: {
              id: "01",
              sessionID: "s1",
              role: "user" as const,
              time: { created: 1 },
              agent: "code",
              model: { providerID: "a", modelID: "m" },
            },
            parts: [
              { id: "p01", messageID: "01", sessionID: "s1", type: "text" as const, text: "hello" },
            ] as MessageV2.Part[],
          },
          {
            info: {
              id: "02",
              sessionID: "s1",
              role: "assistant" as const,
              time: { created: 2 },
              parentID: "01",
              modelID: "m",
              providerID: "a",
              agent: "code",
              path: { cwd: "/", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
            } as MessageV2.Assistant,
            parts: [
              { id: "p02", messageID: "02", sessionID: "s1", type: "text" as const, text: "hi" },
            ] as MessageV2.Part[],
          },
        ]

        const result = await MessageV2.filterCompacted(mockStream(messages))
        expect(result.length).toBe(2)
        expect(result[0].info.id).toBe("01")
        expect(result[1].info.id).toBe("02")
      },
    })
  })
})
