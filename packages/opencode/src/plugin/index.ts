import type { Hooks, PluginInput, Plugin as PluginInstance, RouteDefinition } from "@opencode-ai/plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { Session } from "../session"
import { NamedError } from "@opencode-ai/util/error"
import { CopilotAuthPlugin } from "./copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "@gitlab/opencode-gitlab-auth"
import { HttpAuthPlugin } from "./http-auth"
import { A2APlugin } from "./a2a"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  const BUILTIN: string[] = []

  // Built-in plugins that are directly imported (not installed from npm)
  const INTERNAL_PLUGINS: PluginInstance[] = [
    CodexAuthPlugin,
    CopilotAuthPlugin,
    GitlabAuthPlugin,
    HttpAuthPlugin,
    A2APlugin,
  ]

  const state = Instance.state(async () => {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      directory: Instance.directory,
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => Server.App().fetch(...args),
    })
    const config = await Config.get()
    const hooks: {
      source: "internal" | "external"
      hook: Hooks
    }[] = []
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      serverUrl: Server.url(),
      $: Bun.$,
    }

    for (const plugin of INTERNAL_PLUGINS) {
      log.info("loading internal plugin", { name: plugin.name })
      const init = await plugin(input)
      hooks.push({ source: "internal", hook: init })
    }

    let plugins = config.plugin ?? []
    if (plugins.length) await Config.waitForDependencies()
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      plugins = [...BUILTIN, ...plugins]
    }

    for (let plugin of plugins) {
      // ignore old codex plugin since it is supported first party now
      if (plugin.includes("opencode-openai-codex-auth") || plugin.includes("opencode-copilot-auth")) continue
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
        plugin = await BunProc.install(pkg, version).catch((err) => {
          if (!builtin) throw err

          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to install builtin plugin", {
            pkg,
            version,
            error: message,
          })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to install built-in plugin ${pkg}@${version}: ${message}`,
            }).toObject(),
          })

          return ""
        })
        if (!plugin) continue
      }
      const mod = await import(plugin)
      // Prevent duplicate initialization when plugins export the same function
      // as both a named export and default export (e.g., `export const X` and `export default X`).
      // Object.entries(mod) would return both entries pointing to the same function reference.
      const seen = new Set<PluginInstance>()
      for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
        if (seen.has(fn)) continue
        seen.add(fn)
        const init = await fn(input)
        hooks.push({ source: "external", hook: init })
      }
    }

    return {
      hooks,
      input,
    }
  })

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool" | "http.route">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const item of await state().then((x) => x.hooks)) {
      const fn = item.hook[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output)
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.hooks.map((item) => item.hook))
  }

  export async function has(name: keyof Hooks) {
    for (const hook of await list()) {
      if (hook[name]) return true
    }
    return false
  }

  export async function hasExternal(name: keyof Hooks) {
    for (const item of await state().then((x) => x.hooks)) {
      if (item.source !== "external") continue
      if (item.hook[name]) return true
    }
    return false
  }

  export async function collectRoutes(allowExternal: boolean): Promise<RouteDefinition[]> {
    const hooks = await state().then((x) => x.hooks)
    return hooks.flatMap((item) => {
      if (!allowExternal && item.source === "external") return []
      return item.hook["http.route"] ?? []
    })
  }

  /**
   * Collect routes with source info. Used by server auth middleware to
   * restrict auth opt-out (auth: []) to internal plugins only —
   * external plugins must not be able to punch auth holes.
   */
  export async function collectRoutesWithSource(
    allowExternal: boolean,
  ): Promise<{ source: "internal" | "external"; route: RouteDefinition }[]> {
    const hooks = await state().then((x) => x.hooks)
    return hooks.flatMap((item) => {
      if (!allowExternal && item.source === "external") return []
      return (item.hook["http.route"] ?? []).map((route) => ({ source: item.source, route }))
    })
  }



  export async function init() {
    const hooks = await list()
    const config = await Config.get()
    for (const hook of hooks) {
      // @ts-expect-error this is because we haven't moved plugin to sdk v2
      await hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await list()
      for (const hook of hooks) {
        hook["event"]?.({
          event: input,
        })
      }
    })
  }
}
