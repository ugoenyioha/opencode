import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { proxy } from "hono/proxy"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { LSP } from "../lsp"
import { Format } from "../format"
import { TuiRoutes } from "./routes/tui"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Skill } from "../skill/skill"
import { Auth } from "../auth"
import { Session } from "../session"
import { Flag } from "../flag/flag"
import { Command } from "../command"
import { Global } from "../global"
import { WorkspaceContext } from "../control-plane/workspace-context"
import { WorkspaceRouterMiddleware } from "../control-plane/workspace-router-middleware"
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { ExperimentalRoutes } from "./routes/experimental"
import { TeamRoutes } from "./routes/team"
import { ProviderRoutes } from "./routes/provider"
import { lazy } from "../util/lazy"
import { InstanceBootstrap } from "../project/bootstrap"
import { NotFoundError } from "../storage/db"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { websocket } from "hono/bun"
import { HTTPException } from "hono/http-exception"
import { errors } from "./error"
import { Filesystem } from "@/util/filesystem"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { GlobalRoutes } from "./routes/global"
import { MDNS } from "./mdns"
import { Plugin } from "@/plugin"
import { ToolRoutes, isSensitiveTool } from "./routes/tool"
import { CompatRoutes } from "./compat"
import { evaluateAuthorization, type RouteAuthRule } from "./auth-policy"
import { emitAuthBoundary, emitAuthDecision } from "./auth-observability"
import { validateStartupAuthConfig } from "./auth-startup-validation"
import { INTERNAL_CLIENT_IP_HEADER, rateLimitMiddleware } from "./rate-limit"
import { MemoryRateLimitStore, SqliteRateLimitStore, type RateLimitStore } from "./rate-limit/store"
import { Identifier } from "../id/id"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

import { RemoteHost } from "@/remote/host"

let activeRemoteHost: RemoteHost | null = null

export namespace Server {
  const log = Log.create({ service: "server" })

  const rateLimitStore = (() => {
    let init: Promise<RateLimitStore> | undefined
    return () => {
      if (!init) init = createRateLimitStore()
      return init
    }
  })()

  async function createRateLimitStore(): Promise<RateLimitStore> {
    try {
      const config = await Config.getGlobal()
      const backend = config.server?.limits?.rate_limit_backend
      const driver = backend?.driver ?? "sqlite"
      if (driver === "memory") return new MemoryRateLimitStore()
      return new SqliteRateLimitStore({ path: backend?.sqlite?.path })
    } catch (error) {
      log.warn("failed to initialize rate-limit store", {
        error: error instanceof Error ? error.message : String(error),
      })
      return new MemoryRateLimitStore()
    }
  }

  let _url: URL | undefined
  let _corsWhitelist: string[] = []

  const PLUGIN_ROUTE_MISS_HEADER = "x-opencode-plugin-route"

  function resolveRequestDirectory(c: {
    req: { query: (key: string) => string | undefined; header: (key: string) => string | undefined }
  }) {
    const raw = c.req.query("directory") || c.req.header("x-opencode-directory")
    if (!raw) return process.cwd()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }

  function allowExternalRoutes(config: Config.Info) {
    const value = process.env.OPENCODE_ALLOW_EXTERNAL_ROUTES
    if (value !== undefined) {
      const normalized = value.toLowerCase()
      return normalized === "1" || normalized === "true"
    }
    return config.server?.allowExternalRoutes === true
  }

  const pluginRoutes = Instance.state(async () => {
    const config = await Config.get()
    const app = new Hono()
    app.notFound(
      () =>
        new Response("", {
          status: 404,
          headers: {
            [PLUGIN_ROUTE_MISS_HEADER]: "miss",
          },
        }),
    )

    const routesWithSource = await Plugin.collectRoutesWithSource(allowExternalRoutes(config))

    const authRoutes = routesWithSource
      .filter((r) => r.source === "internal" || !(Array.isArray(r.route.auth) && r.route.auth.length === 0))
      .map((r) => ({
        method: (r.route.method === "*" ? "ALL" : r.route.method).toUpperCase(),
        path: r.route.path,
        auth: r.route.auth,
      }))

    for (const { route } of routesWithSource) {
      app.on((route.method === "*" ? "ALL" : route.method) as any, route.path, async (c) => {
        return route.handler(c.req.raw, c.req.param())
      })
    }

    return { app, authRoutes }
  })

  export function url(): URL {
    return _url ?? new URL("http://localhost:4096")
  }

  const app = new Hono()
  export const App: () => Hono = lazy(
    () =>
      // TODO: Break server.ts into smaller route files to fix type inference
      app
        .onError((err, c) => {
          log.error("failed", {
            error: err,
          })
          if (err instanceof NamedError) {
            let status: ContentfulStatusCode
            if (err instanceof NotFoundError) status = 404
            else if (err instanceof Provider.ModelNotFoundError) status = 400
            else if (err.name.startsWith("Worktree")) status = 400
            else status = 500
            return c.json(err.toObject(), { status })
          }
          if (err instanceof HTTPException) return err.getResponse()
          const message = err instanceof Error && err.stack ? err.stack : err.toString()
          return c.json(new NamedError.Unknown({ message }).toObject(), {
            status: 500,
          })
        })
        .use(async (c, next) => {
          // Allow CORS preflight requests to succeed without auth.
          if (c.req.method === "OPTIONS") return next()
          let routeRules: RouteAuthRule[] = []
          try {
            const directory = resolveRequestDirectory(c)
            routeRules = await Instance.provide({
              directory,
              init: InstanceBootstrap,
              fn: async () => {
                const rules = [...(await pluginRoutes()).authRoutes]
                const endpoint = (await Config.get()).server?.toolEndpoint
                if (endpoint?.enabled) {
                  rules.unshift({
                    method: "POST",
                    path: "/tool/:toolName",
                    auth: endpoint.auth ?? "api-key",
                  })
                }
                return rules
              },
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes("No context found for instance")) {
              routeRules = []
            } else {
              log.error("failed to load route auth rules", { error })
              return c.json({ error: "Unauthorized" }, 401)
            }
          }
          // Extract client IP for auth decision (G9 security fix)
          let clientIP = c.req.raw.headers.get(INTERNAL_CLIENT_IP_HEADER) ?? ""
          if (!clientIP && process.env.NODE_ENV === "test") {
            clientIP = "127.0.0.1"
          }
          const auth = await evaluateAuthorization(c.req.method, c.req.path, c.req.raw.headers, routeRules, clientIP)

          if (auth.policyMode === "defer") {
            emitAuthBoundary({
              surface: auth.surface,
              route: auth.route,
              policyMode: "defer",
            })
          }

          const shouldEmitDecision =
            (auth.policyMode === "global-default" || auth.policyMode === "strategies") &&
            auth.route !== "anthropic.compat"

          if (shouldEmitDecision) {
            emitAuthDecision({
              source: "centralized",
              surface: auth.surface,
              route: auth.route,
              policyMode: auth.policyMode,
              outcome: auth.ok ? "allow" : "deny",
              strategy: auth.strategy,
              reason: auth.reason,
            })
          }

          if (auth.ok) return next()
          return c.json({ error: "Unauthorized" }, 401)
        })
        .use(
          rateLimitMiddleware(
            async () => {
              try {
                const config = await Config.getGlobal()
                return config.server?.limits?.rate_limit_rpm ?? 600
              } catch {
                return 600
              }
            },
            ["1", "true", "yes", "on"].includes((process.env.OPENCODE_TRUST_PROXY_HEADERS ?? "").trim().toLowerCase()),
            { store: rateLimitStore() },
          ),
        )
        .use(async (c, next) => {
          const skipLogging = c.req.path === "/log"
          if (!skipLogging) {
            log.info("request", {
              method: c.req.method,
              path: c.req.path,
            })
          }
          const timer = log.time("request", {
            method: c.req.method,
            path: c.req.path,
          })
          await next()
          if (!skipLogging) {
            timer.stop()
          }
        })
        .use(
          cors({
            origin(input) {
              if (!input) return

              if (input.startsWith("http://localhost:")) return input
              if (input.startsWith("http://127.0.0.1:")) return input
              if (
                input === "tauri://localhost" ||
                input === "http://tauri.localhost" ||
                input === "https://tauri.localhost"
              )
                return input

              // *.opencode.ai (https only, adjust if needed)
              if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
                return input
              }
              if (_corsWhitelist.includes(input)) {
                return input
              }

              return
            },
          }),
        )
        .put(
          "/auth/:providerID",
          describeRoute({
            summary: "Set auth credentials",
            description: "Set authentication credentials",
            operationId: "auth.set",
            responses: {
              200: {
                description: "Successfully set authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          validator("json", Auth.Info),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            const info = c.req.valid("json")
            await Auth.set(providerID, info)
            return c.json(true)
          },
        )
        .delete(
          "/auth/:providerID",
          describeRoute({
            summary: "Remove auth credentials",
            description: "Remove authentication credentials",
            operationId: "auth.remove",
            responses: {
              200: {
                description: "Successfully removed authentication credentials",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "param",
            z.object({
              providerID: z.string(),
            }),
          ),
          async (c) => {
            const providerID = c.req.valid("param").providerID
            await Auth.remove(providerID)
            return c.json(true)
          },
        )
        .use(async (c, next) => {
          if (c.req.path === "/log") return next()
          const workspaceID = c.req.query("workspace") || c.req.header("x-opencode-workspace")
          const raw = c.req.query("directory") || c.req.header("x-opencode-directory")
          let directory: string | undefined
          if (raw) {
            try {
              directory = Filesystem.resolve(decodeURIComponent(raw))
            } catch {
              directory = Filesystem.resolve(raw)
            }
          }
          if (!directory) {
            // For session-scoped routes, resolve directory from the stored session
            const match = c.req.path.match(/(?:\/api\/v\d+)?\/session\/(ses_[^/]+)/)
            if (match) {
              const parsed = Identifier.schema("session").safeParse(match[1])
              if (parsed.success) {
                directory = await Session.findDirectory(parsed.data)
              }
            }
          }
          if (!directory) directory = Filesystem.resolve(process.cwd())
          return WorkspaceContext.provide({
            workspaceID,
            async fn() {
              return Instance.provide({
                directory,
                init: InstanceBootstrap,
                async fn() {
                  return next()
                },
              })
            },
          })
        })
        .use(WorkspaceRouterMiddleware)
        .use(async (c, next) => {
          if (c.req.path === "/log") return next()
          const output: {
            response?: {
              status: number
              body: string
              headers?: Record<string, string>
            }
          } = {}
          const trustProxyHeaders = ["1", "true", "yes", "on"].includes(
            (Env.get("OPENCODE_TRUST_PROXY_HEADERS") ?? "").trim().toLowerCase(),
          )
          const forwarded = trustProxyHeaders ? c.req.header("x-forwarded-for") : undefined
          const clientIP = trustProxyHeaders
            ? forwarded?.split(",")[0]?.trim() || c.req.header("x-real-ip") || c.req.header("cf-connecting-ip") || ""
            : ""
          await Plugin.trigger(
            "http.request",
            {
              method: c.req.method,
              path: c.req.path,
              headers: Object.fromEntries(c.req.raw.headers.entries()),
              clientIP,
            },
            output,
          )
          if (!output.response) return next()
          const headers = new Headers(output.response.headers ?? {})
          return new Response(output.response.body, {
            status: output.response.status,
            headers,
          })
        })
        .use(async (c, next) => {
          if (c.req.path === "/log") return next()
          const response = await pluginRoutes().then((r) => r.app.fetch(c.req.raw.clone()))
          if (response.headers.get(PLUGIN_ROUTE_MISS_HEADER) === "miss") {
            return next()
          }
          return response
        })
        .get(
          "/doc",
          openAPIRouteHandler(app, {
            documentation: {
              info: {
                title: "opencode",
                version: "0.0.3",
                description: "opencode api",
              },
              openapi: "3.1.1",
            },
          }),
        )
        .use(
          validator(
            "query",
            z.object({
              directory: z.string().optional(),
              workspace: z.string().optional(),
            }),
          ),
        )
        .route("/", CompatRoutes())
        .route("/global", GlobalRoutes())
        .route("/project", ProjectRoutes())
        .route("/pty", PtyRoutes())
        .route("/config", ConfigRoutes())
        .route("/experimental", ExperimentalRoutes())
        .route("/session", SessionRoutes())
        .route("/permission", PermissionRoutes())
        .route("/question", QuestionRoutes())
        .route("/provider", ProviderRoutes())
        .route("/", FileRoutes())
        .route("/tool", ToolRoutes())
        .route("/mcp", McpRoutes())
        .route("/team", TeamRoutes())
        .route("/tui", TuiRoutes())
        .post(
          "/instance/remote/start",
          describeRoute({
            summary: "Start remote control",
            description: "Starts a secure remote control session.",
            operationId: "instance.remote.start",
            responses: {
              200: {
                description: "Remote control started",
                content: {
                  "application/json": {
                    schema: resolver(z.object({ url: z.string() })),
                  },
                },
              },
            },
          }),
          validator("json", z.object({ relay: z.string(), viewer: z.string() })),
          async (c) => {
            if (activeRemoteHost) {
              await activeRemoteHost.stop()
            }
            const { relay, viewer } = c.req.valid("json")
            activeRemoteHost = new RemoteHost({
              relay,
              viewer,
              onDisconnect: () => {
                activeRemoteHost = null
              },
            })
            const url = await activeRemoteHost.start()
            return c.json({ url })
          },
        )
        .post(
          "/instance/remote/stop",
          describeRoute({
            summary: "Stop remote control",
            description: "Stops the active remote control session.",
            operationId: "instance.remote.stop",
            responses: {
              200: {
                description: "Remote control stopped",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          async (c) => {
            if (activeRemoteHost) {
              await activeRemoteHost.stop()
              activeRemoteHost = null
            }
            return c.json(true)
          },
        )
        .post(
          "/instance/dispose",
          describeRoute({
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
            operationId: "instance.dispose",
            responses: {
              200: {
                description: "Instance disposed",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
            },
          }),
          async (c) => {
            await Instance.dispose()
            return c.json(true)
          },
        )
        .get(
          "/path",
          describeRoute({
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenCode instance.",
            operationId: "path.get",
            responses: {
              200: {
                description: "Path",
                content: {
                  "application/json": {
                    schema: resolver(
                      z
                        .object({
                          home: z.string(),
                          state: z.string(),
                          config: z.string(),
                          worktree: z.string(),
                          directory: z.string(),
                        })
                        .meta({
                          ref: "Path",
                        }),
                    ),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json({
              home: Global.Path.home,
              state: Global.Path.state,
              config: Global.Path.config,
              worktree: Instance.worktree,
              directory: Instance.directory,
            })
          },
        )
        .get(
          "/vcs",
          describeRoute({
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
            operationId: "vcs.get",
            responses: {
              200: {
                description: "VCS info",
                content: {
                  "application/json": {
                    schema: resolver(Vcs.Info),
                  },
                },
              },
            },
          }),
          async (c) => {
            const branch = await Vcs.branch()
            return c.json({
              branch,
            })
          },
        )
        .get(
          "/command",
          describeRoute({
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
            operationId: "command.list",
            responses: {
              200: {
                description: "List of commands",
                content: {
                  "application/json": {
                    schema: resolver(Command.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const commands = await Command.list()
            return c.json(commands)
          },
        )
        .post(
          "/log",
          describeRoute({
            summary: "Write log",
            description: "Write a log entry to the server logs with specified level and metadata.",
            operationId: "app.log",
            responses: {
              200: {
                description: "Log entry written successfully",
                content: {
                  "application/json": {
                    schema: resolver(z.boolean()),
                  },
                },
              },
              ...errors(400),
            },
          }),
          validator(
            "json",
            z.object({
              service: z.string().meta({ description: "Service name for the log entry" }),
              level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
              message: z.string().meta({ description: "Log message" }),
              extra: z
                .record(z.string(), z.any())
                .optional()
                .meta({ description: "Additional metadata for the log entry" }),
            }),
          ),
          async (c) => {
            const { service, level, message, extra } = c.req.valid("json")
            const logger = Log.create({ service })

            switch (level) {
              case "debug":
                logger.debug(message, extra)
                break
              case "info":
                logger.info(message, extra)
                break
              case "error":
                logger.error(message, extra)
                break
              case "warn":
                logger.warn(message, extra)
                break
            }

            return c.json(true)
          },
        )
        .get(
          "/agent",
          describeRoute({
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
            operationId: "app.agents",
            responses: {
              200: {
                description: "List of agents",
                content: {
                  "application/json": {
                    schema: resolver(Agent.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const modes = await Agent.list()
            return c.json(modes)
          },
        )
        .get(
          "/skill",
          describeRoute({
            summary: "List skills",
            description: "Get a list of all available skills in the OpenCode system.",
            operationId: "app.skills",
            responses: {
              200: {
                description: "List of skills",
                content: {
                  "application/json": {
                    schema: resolver(Skill.Info.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            const skills = await Skill.all()
            return c.json(skills)
          },
        )
        .get(
          "/lsp",
          describeRoute({
            summary: "Get LSP status",
            description: "Get LSP server status",
            operationId: "lsp.status",
            responses: {
              200: {
                description: "LSP server status",
                content: {
                  "application/json": {
                    schema: resolver(LSP.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await LSP.status())
          },
        )
        .get(
          "/formatter",
          describeRoute({
            summary: "Get formatter status",
            description: "Get formatter status",
            operationId: "formatter.status",
            responses: {
              200: {
                description: "Formatter status",
                content: {
                  "application/json": {
                    schema: resolver(Format.Status.array()),
                  },
                },
              },
            },
          }),
          async (c) => {
            return c.json(await Format.status())
          },
        )
        .get(
          "/event",
          describeRoute({
            summary: "Subscribe to events",
            description: "Get events",
            operationId: "event.subscribe",
            responses: {
              200: {
                description: "Event stream",
                content: {
                  "text/event-stream": {
                    schema: resolver(BusEvent.payloads()),
                  },
                },
              },
            },
          }),
          async (c) => {
            log.info("event connected")
            c.header("X-Accel-Buffering", "no")
            c.header("X-Content-Type-Options", "nosniff")
            return streamSSE(c, async (stream) => {
              stream.writeSSE({
                data: JSON.stringify({
                  type: "server.connected",
                  properties: {},
                }),
              })
              const unsub = Bus.subscribeAll(async (event) => {
                await stream.writeSSE({
                  data: JSON.stringify(event),
                })
                if (event.type === Bus.InstanceDisposed.type) {
                  stream.close()
                }
              })

              // Send heartbeat every 10s to prevent stalled proxy streams.
              const heartbeat = setInterval(() => {
                stream.writeSSE({
                  data: JSON.stringify({
                    type: "server.heartbeat",
                    properties: {},
                  }),
                })
              }, 10_000)

              await new Promise<void>((resolve) => {
                stream.onAbort(() => {
                  clearInterval(heartbeat)
                  unsub()
                  resolve()
                  log.info("event disconnected")
                })
              })
            })
          },
        )
        .all("/*", async (c) => {
          const path = c.req.path

          const response = await proxy(`https://app.opencode.ai${path}`, {
            ...c.req,
            headers: {
              ...c.req.raw.headers,
              host: "app.opencode.ai",
            },
          })
          response.headers.set(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:",
          )
          return response
        }) as unknown as Hono,
  )

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(App() as Hono, {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  async function verifyToolEndpointConfig() {
    await Instance.provide({
      directory: process.cwd(),
      init: InstanceBootstrap,
      fn: async () => {
        const config = await Config.get()
        const endpoint = config.server?.toolEndpoint
        if (!endpoint?.enabled) return
        if (!endpoint.allowedTools?.length) {
          throw new Error("server.toolEndpoint.enabled requires a non-empty server.toolEndpoint.allowedTools")
        }
        if (endpoint.allowSensitiveTools !== true) {
          const blocked = endpoint.allowedTools.filter((tool: string) => isSensitiveTool(tool))
          if (blocked.length) {
            throw new Error(
              `server.toolEndpoint.allowedTools contains sensitive tool(s): ${blocked.join(", ")}. Set server.toolEndpoint.allowSensitiveTools=true to explicitly override.`,
            )
          }
        }

        await validateStartupAuthConfig({
          config,
          getEnv: (key) => Env.get(key),
          getApiKey: () => Flag.OPENCODE_TOOL_ENDPOINT_API_KEY,
          hasExternalHttpHook: () => Plugin.hasExternal("http.request"),
        })
      },
    })
  }

  /**
   * Fetch wrapper for in-process callers.
   *
   * Marks requests as loopback so internal SDK clients can hit the
   * in-process app without going through a network listener.
   */
  export async function internalFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    request.headers.set(INTERNAL_CLIENT_IP_HEADER, "127.0.0.1")
    return App().fetch(request)
  }

  export async function listen(opts: {
    port: number
    hostname: string
    unix?: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
  }) {
    await verifyToolEndpointConfig()
    _corsWhitelist = opts.cors ?? []

    const appFetch = App().fetch
    const fetch = (request: Request, server: Bun.Server<any>) => {
      const headers = new Headers(request.headers)
      headers.delete(INTERNAL_CLIENT_IP_HEADER)
      const ip = server.requestIP(request)?.address
      if (ip) headers.set(INTERNAL_CLIENT_IP_HEADER, ip)
      return appFetch(new Request(request, { headers }))
    }

    const args = {
      idleTimeout: 0,
      fetch,
      websocket: websocket,
    } as const

    // Unix socket mode
    if (opts.unix) {
      // Remove stale socket file if it exists
      try {
        const { unlinkSync } = require("fs")
        unlinkSync(opts.unix)
      } catch {}
      const server = Bun.serve({ fetch: args.fetch, websocket: args.websocket, unix: opts.unix })
      _url = new URL(`unix://${opts.unix}`)
      const originalStop = server.stop.bind(server)
      server.stop = async (closeActiveConnections?: boolean) => {
        try {
          const { unlinkSync } = require("fs")
          unlinkSync(opts.unix!)
        } catch {}
        return originalStop(closeActiveConnections)
      }
      return server
    }

    // TCP mode
    const tcpArgs = { ...args, hostname: opts.hostname }
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...tcpArgs, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = server.url

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }
}
