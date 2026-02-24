process.env["OPENCODE_A2A_API_KEY"] = "test-a2a-key"

import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin"
import { Log } from "../../src/util/log"
import * as Spiffe from "../../src/server/spiffe"

Log.init({ print: false })

const AUTH_HEADER = { "X-A2A-Key": "test-a2a-key" }

async function projectWithPluginAuthz() {
  return tmpdir({
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skills", "sidecar-preserve")
      await fs.mkdir(skillDir, { recursive: true })
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: sidecar-preserve
description: Build and preserve the sidecar container image
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
description: A2A test agent
mode: a2a
skills: [sidecar-preserve]
a2a:
  baseUrl: https://example.test
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
              authz: {
                provider: "plugin",
                plugin: {
                  id: "runtime-authz",
                  policy: {
                    mode: "enforce",
                  },
                },
              },
            },
          },
        }),
      )
    },
  })
}

describe("a2a plugin authz context", () => {
  test("propagates user principal and omits workload principal without trusted source", async () => {
    await using tmp = await projectWithPluginAuthz()
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const base = Plugin.trigger.bind(Plugin)
        let captured: any
        const triggerSpy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
          if (name === "a2a.authz") {
            captured = input
            output.decision = { allow: true }
            return output
          }
          return base(name, input, output)
        })

        try {
          const app = Server.App()
          const response = await app.request("/a2a/neo-sidecar/tasks", {
            method: "GET",
            headers: {
              "x-opencode-directory": tmp.path,
              authorization: "Bearer secret-token",
              ...AUTH_HEADER,
            },
          })

          expect(response.status).toBe(200)
          expect(captured.agent).toBe("neo-sidecar")
          expect(captured.action).toBe("invoke")
          expect(captured.user_principal).toBe("api-key")
          expect(captured.workload_principal).toBeUndefined()
          expect(captured.plugin.id).toBe("runtime-authz")
          expect(captured.plugin.policy).toEqual({ mode: "enforce" })
          expect(captured.headers.authorization).toBe("[redacted]")
          expect(captured.headers["x-a2a-key"]).toBe("[redacted]")
          expect(captured.headers["x-opencode-workload"]).toBeUndefined()
        } finally {
          triggerSpy.mockRestore()
        }
      },
    })
  })

  test("accepts trusted workload header token when explicitly enabled", async () => {
    await using tmp = await projectWithPluginAuthz()
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
        process.env["OPENCODE_A2A_TRUST_WORKLOAD_HEADER"] = "true"
        process.env["OPENCODE_SPIFFE_AUDIENCE"] = "test-audience"
        process.env["OPENCODE_SPIFFE_ALLOWED_IDS"] = "spiffe://trust.domain/ns/default/sa/caller"
      },
      fn: async () => {
        let captured: any
        const base = Plugin.trigger.bind(Plugin)
        const spiffeSpy = spyOn(Spiffe, "verifySPIFFE").mockResolvedValue("spiffe://trust.domain/ns/default/sa/caller")
        const triggerSpy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
          if (name === "a2a.authz") {
            captured = input
            output.decision = { allow: true }
            return output
          }
          return base(name, input, output)
        })
        try {
          const app = Server.App()
          const response = await app.request("/a2a/neo-sidecar/tasks", {
            method: "GET",
            headers: {
              "x-opencode-directory": tmp.path,
              "x-opencode-workload": "Bearer trusted-workload-jwt-svid",
              ...AUTH_HEADER,
            },
          })
          expect(response.status).toBe(200)
          expect(captured.workload_principal).toBe("spiffe://trust.domain/ns/default/sa/caller")
          expect(spiffeSpy).toHaveBeenCalledWith(
            "trusted-workload-jwt-svid",
            "test-audience",
            ["spiffe://trust.domain/ns/default/sa/caller"],
          )
          expect(captured.headers["x-opencode-workload"]).toBe("[redacted]")
        } finally {
          spiffeSpy.mockRestore()
          triggerSpy.mockRestore()
          delete process.env["OPENCODE_A2A_TRUST_WORKLOAD_HEADER"]
          delete process.env["OPENCODE_SPIFFE_AUDIENCE"]
          delete process.env["OPENCODE_SPIFFE_ALLOWED_IDS"]
        }
      },
    })
  })

  test("fails closed to no workload_principal when trusted workload token fails SPIFFE verify", async () => {
    await using tmp = await projectWithPluginAuthz()
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
        process.env["OPENCODE_A2A_TRUST_WORKLOAD_HEADER"] = "true"
        process.env["OPENCODE_SPIFFE_AUDIENCE"] = "test-audience"
        process.env["OPENCODE_SPIFFE_ALLOWED_IDS"] = "spiffe://trust.domain/ns/default/sa/caller"
      },
      fn: async () => {
        let captured: any
        const base = Plugin.trigger.bind(Plugin)
        const spiffeSpy = spyOn(Spiffe, "verifySPIFFE").mockResolvedValue(false)
        const triggerSpy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
          if (name === "a2a.authz") {
            captured = input
            output.decision = { allow: true }
            return output
          }
          return base(name, input, output)
        })
        try {
          const app = Server.App()
          const response = await app.request("/a2a/neo-sidecar/tasks", {
            method: "GET",
            headers: {
              "x-opencode-directory": tmp.path,
              "x-opencode-workload": "Bearer invalid-workload-token",
              ...AUTH_HEADER,
            },
          })
          expect(response.status).toBe(200)
          expect(captured.workload_principal).toBeUndefined()
          expect(spiffeSpy).toHaveBeenCalledWith(
            "invalid-workload-token",
            "test-audience",
            ["spiffe://trust.domain/ns/default/sa/caller"],
          )
          expect(captured.headers["x-opencode-workload"]).toBe("[redacted]")
        } finally {
          spiffeSpy.mockRestore()
          triggerSpy.mockRestore()
          delete process.env["OPENCODE_A2A_TRUST_WORKLOAD_HEADER"]
          delete process.env["OPENCODE_SPIFFE_AUDIENCE"]
          delete process.env["OPENCODE_SPIFFE_ALLOWED_IDS"]
        }
      },
    })
  })

  test("ignores trusted workload header when allowlist is not configured", async () => {
    await using tmp = await projectWithPluginAuthz()
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
        process.env["OPENCODE_A2A_TRUST_WORKLOAD_HEADER"] = "true"
        process.env["OPENCODE_SPIFFE_AUDIENCE"] = "test-audience"
        delete process.env["OPENCODE_SPIFFE_ALLOWED_IDS"]
      },
      fn: async () => {
        let captured: any
        const base = Plugin.trigger.bind(Plugin)
        const spiffeSpy = spyOn(Spiffe, "verifySPIFFE").mockResolvedValue("spiffe://trust.domain/ns/default/sa/caller")
        const triggerSpy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
          if (name === "a2a.authz") {
            captured = input
            output.decision = { allow: true }
            return output
          }
          return base(name, input, output)
        })
        try {
          const app = Server.App()
          const response = await app.request("/a2a/neo-sidecar/tasks", {
            method: "GET",
            headers: {
              "x-opencode-directory": tmp.path,
              "x-opencode-workload": "Bearer trusted-workload-jwt-svid",
              ...AUTH_HEADER,
            },
          })
          expect(response.status).toBe(200)
          expect(captured.workload_principal).toBeUndefined()
          expect(spiffeSpy).not.toHaveBeenCalled()
        } finally {
          spiffeSpy.mockRestore()
          triggerSpy.mockRestore()
          delete process.env["OPENCODE_A2A_TRUST_WORKLOAD_HEADER"]
          delete process.env["OPENCODE_SPIFFE_AUDIENCE"]
          delete process.env["OPENCODE_SPIFFE_ALLOWED_IDS"]
        }
      },
    })
  })

  test("fails closed when a2a.authz throws", async () => {
    await using tmp = await projectWithPluginAuthz()
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const base = Plugin.trigger.bind(Plugin)
        const triggerSpy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
          if (name === "a2a.authz") throw new Error("authz plugin unavailable")
          return base(name, input, output)
        })

        try {
          const app = Server.App()
          const response = await app.request("/a2a/neo-sidecar/tasks", {
            method: "GET",
            headers: {
              "x-opencode-directory": tmp.path,
              ...AUTH_HEADER,
            },
          })
          expect(response.status).toBe(403)
        } finally {
          triggerSpy.mockRestore()
        }
      },
    })
  })

  test("uses action=view on discovery and hides denied agents", async () => {
    await using tmp = await projectWithPluginAuthz()
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const base = Plugin.trigger.bind(Plugin)
        const triggerSpy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
          if (name === "a2a.authz" && input.action === "view") {
            output.decision = { allow: false, reason: "hidden" }
            return output
          }
          return base(name, input, output)
        })

        try {
          const app = Server.App()
          const response = await app.request("/.well-known/agents.json", {
            headers: {
              "x-opencode-directory": tmp.path,
              ...AUTH_HEADER,
            },
          })
          expect(response.status).toBe(200)
          const body = (await response.json()) as any
          expect(body.agents).toHaveLength(0)
        } finally {
          triggerSpy.mockRestore()
        }
      },
    })
  })
})
