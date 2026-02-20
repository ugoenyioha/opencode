import { describe, expect, test } from "bun:test"
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

describe("anthropic compat routes", () => {
  test("messages returns non-stream success response", async () => {
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
            messages: [{ role: "user", content: "hello there" }],
          }),
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.type).toBe("message")
        expect(body.model).toBe("opencode/gpt-5-nano")
        expect(body.role).toBe("assistant")
        expect(body.content[0].type).toBe("text")
        expect(typeof body.content[0].text).toBe("string")
      },
    })
  }, 30000)

  test("messages with unknown model returns mapped error", async () => {
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
            model: "opencode/gpt-unknown",
            max_tokens: 128,
            messages: [{ role: "user", content: "hello" }],
          }),
        })
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({
          type: "error",
          error: {
            type: "not_found_error",
            message: "Model 'opencode/gpt-unknown' not found.",
          },
        })
      },
    })
  })

  test("count_tokens handles mixed content blocks", async () => {
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
        const response = await app.request("/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "x-api-key": "test-token",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "hello world" },
                  { type: "tool_use", name: "skip" },
                ],
              },
              { role: "assistant", content: "ok" },
            ],
          }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ input_tokens: 5 })
      },
    })
  })

  test("messages accepts mixed non-text blocks", async () => {
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
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "hello there" },
                  { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
                ],
              },
            ],
          }),
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.type).toBe("message")
      },
    })
  }, 30000)

  test("rejects max_tokens above configured compat cap", async () => {
    await using tmp = await project({
      server: {
        compat: {
          max_output_tokens: 64,
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
            max_tokens: 65,
            messages: [{ role: "user", content: "hello there" }],
          }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as any
        expect(body.error?.message).toBe("max_tokens must be less than or equal to 64")
      },
    })
  })

  test("rejects non-json content type", async () => {
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
            "content-type": "text/plain",
            "x-opencode-directory": tmp.path,
          },
          body: "hello",
        })
        expect(response.status).toBe(400)
      },
    })
  })

  test("uses provider-specific cap over global compat cap", async () => {
    await using tmp = await project({
      server: {
        compat: {
          max_output_tokens: 128,
          anthropic: {
            enabled: true,
            max_output_tokens: 64,
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
            max_tokens: 65,
            messages: [{ role: "user", content: "hello there" }],
          }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as any
        expect(body.error?.message).toBe("max_tokens must be less than or equal to 64")
      },
    })
  })
})
