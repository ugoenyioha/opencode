import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const REASONS = new Set([
  "none",
  "missing_token",
  "invalid_token",
  "invalid_api_key",
  "invalid_basic_auth",
  "jwt_verifier_error",
  "oidc_discovery_error",
  "oauth_introspection_error",
  "verifier_internal_error",
])

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

async function projectWithA2ADiscovery() {
  return tmpdir({
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skills", "sidecar-preserve")
      await fs.mkdir(skillDir, { recursive: true })
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: sidecar-preserve
description: Build and preserve sidecar image
a2a:
  expose: true
  tags: ["docker"]
---
Skill body.
`,
      )

      const agentDir = path.join(dir, ".opencode", "agents")
      await fs.mkdir(agentDir, { recursive: true })
      await Bun.write(
        path.join(agentDir, "neo-sidecar.md"),
        `---
name: neo-sidecar
description: test agent
mode: a2a
skills:
  - sidecar-preserve
---
Agent body.
`,
      )

      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          server: {
            a2a: {
              enabled: true,
              baseUrl: "https://example.test",
              auth: ["api-key"],
              securitySchemes: {
                apiKey: {
                  type: "apiKey",
                  location: "header",
                  name: "X-API-Key",
                },
              },
            },
          },
        }),
      )
    },
  })
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key])
    Env.set(key, value)
  }
  try {
    await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function collectPayloads(calls: any[][]) {
  return calls.map((call) => call[1]).filter(Boolean)
}

describe("auth observability", () => {
  test("openai uses defer boundary + compat decision with coarse surface", async () => {
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
        await withEnv(
          {
            OPENCODE_TOOL_ENDPOINT_API_KEY: "test-token",
          },
          async () => {
            const logger = Log.create({ service: "auth" })
            const debugSpy = spyOn(logger, "debug")
            const infoSpy = spyOn(logger, "info")
            const app = Server.App()
            const response = await app.request("/v1/models", {
              headers: {
                authorization: "Bearer test-token",
                "x-opencode-directory": tmp.path,
              },
            })
            expect(response.status).toBe(200)

            const debugPayloads = collectPayloads((debugSpy as any).mock.calls)
            const infoPayloads = collectPayloads((infoSpy as any).mock.calls)

            expect(
              infoPayloads.some(
                (payload) =>
                  payload.source === "centralized" &&
                  payload.surface === "openai" &&
                  payload.route === "openai.compat" &&
                  payload.outcome === "defer",
              ),
            ).toBe(true)

            expect(
              infoPayloads.some(
                (payload) =>
                  payload.source === "centralized" &&
                  payload.surface === "openai" &&
                  (payload.outcome === "allow" || payload.outcome === "deny"),
              ),
            ).toBe(false)

            expect(
              debugPayloads.some(
                (payload) =>
                  payload.source === "compat" &&
                  payload.surface === "openai" &&
                  payload.route === "openai.compat" &&
                  payload.outcome === "allow",
              ),
            ).toBe(true)

            debugSpy.mockRestore()
            infoSpy.mockRestore()
          },
        )
      },
    })
  })

  test("anthropic emits compat-only auth decisions without centralized duplicates", async () => {
    await using tmp = await project({
      server: {
        compat: {
          anthropic: { enabled: true },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await withEnv(
          {
            OPENCODE_TOOL_ENDPOINT_API_KEY: "test-token",
          },
          async () => {
            const logger = Log.create({ service: "auth" })
            const debugSpy = spyOn(logger, "debug")
            const infoSpy = spyOn(logger, "info")
            const app = Server.App()
            const response = await app.request("/v1/messages/count_tokens", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": "test-token",
                "x-opencode-directory": tmp.path,
              },
              body: JSON.stringify({
                model: "opencode/gpt-5-nano",
                messages: [{ role: "user", content: "hello" }],
              }),
            })
            expect(response.status).toBe(200)

            const debugPayloads = collectPayloads((debugSpy as any).mock.calls)
            const infoPayloads = collectPayloads((infoSpy as any).mock.calls)

            const compatAnthropic = debugPayloads.filter(
              (payload) => payload.source === "compat" && payload.surface === "anthropic" && payload.outcome === "allow",
            )
            expect(compatAnthropic.length).toBe(1)

            expect(
              [...debugPayloads, ...infoPayloads].some(
                (payload) => payload.source === "centralized" && payload.surface === "anthropic",
              ),
            ).toBe(false)

            debugSpy.mockRestore()
            infoSpy.mockRestore()
          },
        )
      },
    })
  })

  test("a2a public discovery skips centralized auth observability emission", async () => {
    await using tmp = await projectWithA2ADiscovery()
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await withEnv(
          {
            OPENCODE_TOOL_ENDPOINT_API_KEY: "test-token",
          },
          async () => {
            const logger = Log.create({ service: "auth" })
            const infoSpy = spyOn(logger, "info")
            const app = Server.App()
            const response = await app.request("/.well-known/agents.json", {
              headers: {
                "x-opencode-directory": tmp.path,
              },
            })
            expect(response.status).toBe(200)
            const infoPayloads = collectPayloads((infoSpy as any).mock.calls)
            expect(
              infoPayloads.some((payload) => payload.source === "centralized" && payload.route === "a2a.discovery"),
            ).toBe(false)
            infoSpy.mockRestore()
          },
        )
      },
    })
  })

  test("warn path uses sanitized reason taxonomy and does not leak secrets", async () => {
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
        await withEnv(
          {
            OPENCODE_TOOL_ENDPOINT_API_KEY: "fixture-api-key-123",
            OPENCODE_COMPAT_OIDC_ISSUER: "http://127.0.0.1:9",
            OPENCODE_COMPAT_OIDC_AUDIENCE: "aud-sanitized",
          },
          async () => {
            const logger = Log.create({ service: "auth" })
            const debugSpy = spyOn(logger, "debug")
            const infoSpy = spyOn(logger, "info")
            const warnSpy = spyOn(logger, "warn")

            const jwtFragment = "eyJhbGciOiJSUzI1NiJ9"
            const app = Server.App()
            const response = await app.request("/v1/models", {
              headers: {
                authorization: `Bearer ${jwtFragment}.eyJpc3MiOiJiYWQifQ.c2ln`,
                "x-api-key": "fixture-api-key-123",
                "x-opencode-directory": tmp.path,
              },
            })
            expect(response.status).toBe(401)

            const warnPayloads = collectPayloads((warnSpy as any).mock.calls)
            expect(warnPayloads.length).toBeGreaterThan(0)
            for (const payload of warnPayloads) {
              expect(REASONS.has(payload.reason)).toBe(true)
              expect(payload.surface).toBe("openai")
              expect(typeof payload.strategy).toBe("string")
            }

            const allCalls = [
              ...(debugSpy as any).mock.calls,
              ...(infoSpy as any).mock.calls,
              ...(warnSpy as any).mock.calls,
            ]
            const serialized = JSON.stringify(allCalls).toLowerCase()
            expect(serialized.includes("authorization")).toBe(false)
            expect(serialized.includes("x-api-key")).toBe(false)
            expect(serialized.includes("bearer")).toBe(false)
            expect(serialized.includes(jwtFragment.toLowerCase())).toBe(false)
            expect(serialized.includes("fixture-api-key-123")).toBe(false)

            debugSpy.mockRestore()
            infoSpy.mockRestore()
            warnSpy.mockRestore()
          },
        )
      },
    })
  })
})
