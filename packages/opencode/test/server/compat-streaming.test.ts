import { beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"

async function project(config: Record<string, unknown>) {
  return tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          ...config,
        }),
      )
    },
  })
}

function responseEventTypes(body: string) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as { type?: string })
    .map((item) => item.type)
    .filter((item): item is string => typeof item === "string")
}

describe("compat streaming", () => {
  beforeAll(async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
          anthropic: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Server.App()
      },
    })
  })

  test("openai chat streaming emits done sentinel", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const response = await app.request("/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")
        const body = await response.text()
        expect(body).toContain("chat.completion.chunk")
        expect(body).toContain("data: [DONE]")
      },
    })
  }, 30000)

  test("openai responses streaming emits done sentinel", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const response = await app.request("/v1/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            stream: true,
            input: "hello",
          }),
        })
        expect(response.status).toBe(200)
        const body = await response.text()
        expect(body).toContain("response.created")
        expect(body).toContain("data: [DONE]")
      },
    })
  }, 30000)

  test("openai responses streaming emits lifecycle taxonomy", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const response = await app.request("/v1/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            stream: true,
            input: "hello",
          }),
        })
        expect(response.status).toBe(200)
        const body = await response.text()
        const types = responseEventTypes(body)
        const created = types.indexOf("response.created")
        const progress = types.indexOf("response.in_progress")
        const itemAdded = types.indexOf("response.output_item.added")
        const partAdded = types.indexOf("response.content_part.added")
        const partDone = types.indexOf("response.content_part.done")
        const itemDone = types.indexOf("response.output_item.done")
        const completed = types.indexOf("response.completed")
        expect(created).toBeGreaterThan(-1)
        expect(progress).toBeGreaterThan(created)
        expect(itemAdded).toBeGreaterThan(progress)
        expect(partAdded).toBeGreaterThan(itemAdded)
        expect(partDone).toBeGreaterThan(partAdded)
        expect(itemDone).toBeGreaterThan(partDone)
        expect(completed).toBeGreaterThan(itemDone)
        expect(body).toContain("data: [DONE]")
      },
    })
  }, 30000)

  test("anthropic messages streaming emits ordered events", async () => {
    await using tmp = await project({
      server: {
        compat: {
          anthropic: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const response = await app.request("/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": "test-token",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            max_tokens: 128,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")
        const body = await response.text()
        const start = body.indexOf("event: message_start")
        const delta = body.indexOf("event: content_block_delta")
        const stop = body.indexOf("event: message_stop")
        expect(start).toBeGreaterThan(-1)
        expect(delta).toBeGreaterThan(start)
        expect(stop).toBeGreaterThan(delta)
      },
    })
  }, 30000)
})
