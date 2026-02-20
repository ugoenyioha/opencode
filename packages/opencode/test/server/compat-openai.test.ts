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

describe("openai compat routes", () => {
  test("chat completions returns non-stream success response", async () => {
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
            messages: [{ role: "user", content: "hello there" }],
          }),
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.object).toBe("chat.completion")
        expect(body.model).toBe("opencode/gpt-5-nano")
        expect(body.choices[0].message.role).toBe("assistant")
        expect(typeof body.choices[0].message.content).toBe("string")
      },
    })
  }, 30000)

  test("responses returns non-stream success response", async () => {
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
            input: "how are you",
          }),
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.object).toBe("response")
        expect(body.model).toBe("opencode/gpt-5-nano")
        expect(body.output[0].type).toBe("message")
      },
    })
  }, 30000)

  test("chat completions accepts structured content arrays", async () => {
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
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "hello there" },
                  { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
                ],
              },
            ],
          }),
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.object).toBe("chat.completion")
      },
    })
  }, 30000)

  test("responses accepts typed input items", async () => {
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
            input: [
              { type: "input_text", text: "hello" },
              { type: "input_image", image_url: "https://example.com/cat.png" },
            ],
          }),
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.object).toBe("response")
      },
    })
  }, 30000)

  test("unknown model returns mapped error", async () => {
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
            model: "opencode/gpt-unknown",
            messages: [{ role: "user", content: "hello there" }],
          }),
        })
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({
          error: {
            type: "invalid_request_error",
            message: "The model 'opencode/gpt-unknown' does not exist.",
            code: "model_not_found",
          },
        })
      },
    })
  })

  test("rejects max_tokens above configured compat cap", async () => {
    await using tmp = await project({
      server: {
        compat: {
          max_output_tokens: 64,
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
            "content-type": "text/plain",
            "x-opencode-directory": tmp.path,
          },
          body: "hello",
        })
        expect(response.status).toBe(400)
      },
    })
  })

  test("rejects malformed json body", async () => {
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
          body: "{",
        })
        expect(response.status).toBe(400)
      },
    })
  })

  test("rejects oversized request bodies", async () => {
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
          body: "x".repeat(530 * 1024),
        })
        expect(response.status).toBe(429)
        const body = (await response.json()) as any
        expect(body.error?.message).toBe("Request body too large")
      },
    })
  })

  test("uses provider-specific cap over global compat cap", async () => {
    await using tmp = await project({
      server: {
        compat: {
          max_output_tokens: 128,
          openai: {
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
        const response = await app.request("/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
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
