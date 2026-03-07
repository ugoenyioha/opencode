import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { tmpdir } from "../fixture/fixture"
import { Plugin } from "../../src/plugin"

describe("plugin.phantom-proxy", () => {
  let mockServerUrl: string
  let mockServer: any

  beforeAll(() => {
    // Start a dummy upstream server to mock OpenAI
    mockServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/v1/chat/completions") {
          const auth = req.headers.get("authorization")
          if (auth === "Bearer real-secret-key") {
            const body = req.method === "POST" ? await req.text() : ""
            return new Response(JSON.stringify({ success: true, method: req.method, body }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-mock-upstream": "true",
              },
            })
          }
          return new Response("Unauthorized upstream", { status: 401 })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    mockServerUrl = `http://127.0.0.1:${mockServer.port}`
  })

  afterAll(() => {
    if (mockServer) {
      mockServer.stop()
    }
  })

  test("injects shell.env variables and proxies requests correctly", async () => {
    await using tmp = await tmpdir({
      config: {
        hardened: true,
        sandbox: {
          proxyCredentials: {
            openai: {
              upstream: mockServerUrl + "/v1",
              injectHeader: "Authorization",
              credentialFormat: "Bearer {}",
              envVarKey: "OPENAI_API_KEY",
              baseUrlEnvVar: "OPENAI_BASE_URL",
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // Provide the real secret to the host env
        Env.set("OPENAI_API_KEY", "real-secret-key")
        Env.set("OPENCODE_HARDENED_MODE", "true")
      },
      fn: async () => {
        // Debug config
        const config = await import("../../src/config/config").then((m) => m.Config.get())
        console.log("Config loaded in test:", JSON.stringify(config.sandbox, null, 2))

        // 1. Verify shell.env hook behavior
        const output = { env: {} as Record<string, string>, passthrough: [] as string[] }
        await Plugin.trigger("shell.env", { cwd: tmp.path }, output)

        expect(output.env["OPENAI_BASE_URL"]).toBeDefined()
        expect(output.env["OPENAI_BASE_URL"]).toContain("/phantom/openai")

        const phantomToken = output.env["OPENAI_API_KEY"]
        expect(phantomToken).toBeDefined()
        expect(phantomToken).not.toBe("real-secret-key") // It must be the generated phantom token

        expect(output.passthrough).toContain("OPENAI_BASE_URL")
        expect(output.passthrough).toContain("OPENAI_API_KEY")

        // 2. Verify http.route behavior via the Server App
        const app = Server.App()

        // Extract the path from the generated base URL
        const url = new URL(output.env["OPENAI_BASE_URL"])
        const proxyPath = url.pathname

        // Attempt a request without the token
        let res = await app.request(`${proxyPath}/chat/completions?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
        })
        expect(res.status).toBe(401)
        expect(await res.text()).toContain("Missing phantom token")

        // Attempt a request with an invalid token
        res = await app.request(`${proxyPath}/chat/completions?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer invalid-token`,
          },
        })
        expect(res.status).toBe(401)
        expect(await res.text()).toContain("Invalid phantom token")

        // Attempt a request with the valid phantom token
        res = await app.request(`${proxyPath}/chat/completions?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${phantomToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "hello" }),
        })

        expect(res.status).toBe(200)
        expect(res.headers.get("x-mock-upstream")).toBe("true")
        const data = await res.json()
        expect(data.success).toBe(true)
        expect(data.method).toBe("POST")
        expect(data.body).toBe(JSON.stringify({ prompt: "hello" }))
      },
    })
  })
})
