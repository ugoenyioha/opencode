import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"

Log.init({ print: false })

function pluginSource() {
  return `
export default async function PluginRoute() {
  return {
    "http.route": [
      {
        method: "POST",
        path: "/hook/:id",
        handler: async (req, params) => {
          return new Response(JSON.stringify({ id: params.id, method: req.method }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        },
      },
      {
        method: "GET",
        path: "/global/health",
        handler: async () => {
          return new Response("plugin-health", { status: 418 })
        },
      },
      {
        method: "GET",
        path: "/hook/plugin-only",
        auth: "plugin",
        handler: async () => {
          return new Response("plugin-only", { status: 200 })
        },
      },
    ],
  }
}
`
}

async function project(withExternalRoutes: boolean) {
  return tmpdir({
    init: async (dir) => {
      const plugin = path.join(dir, "plugin-route.ts")
      await Bun.write(plugin, pluginSource())
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: [`file://${plugin}`],
          server: {
            allowExternalRoutes: withExternalRoutes,
          },
        }),
      )
    },
  })
}

describe("plugin http.route", () => {
  test("ignores external routes by default", async () => {
    await using tmp = await project(false)
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
        Env.remove("OPENCODE_ALLOW_EXTERNAL_ROUTES")
      },
      fn: async () => {
        expect((await Config.get()).server?.allowExternalRoutes).toBe(false)
        expect((await Plugin.collectRoutes(false)).length).toBe(0)
        const cwd = process.cwd()
        process.chdir(tmp.path)
        const response = await (async () => {
          const app = Server.App()
          return app.request("/hook/abc", {
            method: "POST",
            body: "{}",
            headers: { "content-type": "application/json" },
          })
        })().finally(() => process.chdir(cwd))
        expect(await response.text()).not.toContain('"id":"abc"')
      },
    })
  })

  test("registers external routes when enabled", async () => {
    await using tmp = await project(true)
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
        Env.remove("OPENCODE_ALLOW_EXTERNAL_ROUTES")
      },
      fn: async () => {
        expect((await Config.get()).server?.allowExternalRoutes).toBe(true)
        expect((await Plugin.collectRoutes(true)).length).toBeGreaterThan(0)
        const cwd = process.cwd()
        process.chdir(tmp.path)
        const response = await (async () => {
          const app = Server.App()
          return app.request("/hook/xyz", {
            method: "POST",
            body: "{}",
            headers: { "content-type": "application/json" },
          })
        })().finally(() => process.chdir(cwd))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          id: "xyz",
          method: "POST",
        })
      },
    })
  })

  test("mounts plugin routes before default routes", async () => {
    await using tmp = await project(true)
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
        Env.remove("OPENCODE_ALLOW_EXTERNAL_ROUTES")
      },
      fn: async () => {
        const cwd = process.cwd()
        process.chdir(tmp.path)
        const response = await (async () => {
          const app = Server.App()
          return app.request("/global/health")
        })().finally(() => process.chdir(cwd))
        expect(response.status).toBe(418)
        expect(await response.text()).toBe("plugin-health")
      },
    })
  })

  test("does not treat plugin auth strategy as pre-authorized", async () => {
    await using tmp = await project(true)
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
        Env.remove("OPENCODE_ALLOW_EXTERNAL_ROUTES")
      },
      fn: async () => {
        const cwd = process.cwd()
        process.chdir(tmp.path)
        const response = await (async () => {
          const app = Server.App()
          return app.request("/hook/plugin-only")
        })().finally(() => process.chdir(cwd))
        expect(response.status).toBe(401)
      },
    })
  })
})
