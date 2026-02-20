import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"

Log.init({ print: false })

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

describe("compat core routes", () => {
  test("returns 404 when compat providers are disabled", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: { enabled: false },
          anthropic: { enabled: false },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        expect((await app.request("/v1/models", { headers: { "x-opencode-directory": tmp.path } })).status).toBe(404)
        expect(
          (
            await app.request("/v1/messages", {
              method: "POST",
              headers: { "x-opencode-directory": tmp.path },
              body: "{}",
            })
          ).status,
        ).toBe(404)
      },
    })
  })

  test("openai requires bearer or x-api-key auth", async () => {
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
        const response = await app.request("/v1/models", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({
          error: {
            type: "authentication_error",
            message: "Unauthorized",
            code: "invalid_api_key",
          },
        })
      },
    })
  })

  test("openai model list returns available model ids", async () => {
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
        const response = await app.request("/v1/models", {
          headers: {
            authorization: "Bearer test-token",
            "x-opencode-directory": tmp.path,
          },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.object).toBe("list")
        expect(Array.isArray(body.data)).toBe(true)
        expect(body.data.length).toBeGreaterThan(0)
        expect(typeof body.data[0].id).toBe("string")
      },
    })
  })

  test("openai model list accepts x-api-key header", async () => {
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
        const response = await app.request("/v1/models", {
          headers: {
            "x-api-key": "test-token",
            "x-opencode-directory": tmp.path,
          },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.object).toBe("list")
      },
    })
  })

  test("openai model list works without pre-created instance context", async () => {
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
    const previous = process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
    try {
      process.env.OPENCODE_TOOL_ENDPOINT_API_KEY = "test-token"
      const app = Server.App()
      const response = await app.request("/v1/models", {
        headers: {
          authorization: "Bearer test-token",
          "x-api-key": "test-token",
          "x-opencode-directory": tmp.path,
        },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as any
      expect(body.object).toBe("list")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
      else process.env.OPENCODE_TOOL_ENDPOINT_API_KEY = previous
    }
  })

  test("openai invalid chat request returns mapped bad request", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: { enabled: true },
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
            "content-type": "application/json",
            authorization: "Bearer test-token",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({ model: "x", messages: [] }),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          error: {
            type: "invalid_request_error",
            message: "Invalid request",
            code: "invalid_request",
          },
        })
      },
    })
  })

  test("anthropic requires auth and ignores anthropic-version", async () => {
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
        const unauthorized = await app.request("/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({}),
        })
        expect(unauthorized.status).toBe(401)
        expect(await unauthorized.json()).toEqual({
          type: "error",
          error: {
            type: "authentication_error",
            message: "Unauthorized",
          },
        })

        const noVersion = await app.request("/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "test-token",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            messages: [{ role: "user", content: "hello world" }],
          }),
        })
        expect(noVersion.status).toBe(200)
        expect(await noVersion.json()).toEqual({ input_tokens: 2 })

        const withVersion = await app.request("/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "test-token",
            "anthropic-version": "2099-12-31",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            messages: [{ role: "user", content: "hello world" }],
          }),
        })
        expect(withVersion.status).toBe(200)
        expect(await withVersion.json()).toEqual({ input_tokens: 2 })
      },
    })
  })

  test("anthropic count_tokens returns deterministic token count", async () => {
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
            "content-type": "application/json",
            "x-api-key": "test-token",
            "anthropic-version": "2023-06-01",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            messages: [
              { role: "user", content: "hello world" },
              { role: "assistant", content: "ok" },
            ],
          }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ input_tokens: 3 })
      },
    })
  })
})
