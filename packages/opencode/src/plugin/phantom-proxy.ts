import type { Plugin } from "@opencode-ai/plugin"
import { Server } from "../server/server"
import { Log } from "../util/log"
import { Sandbox } from "../sandbox"
import { Env } from "../env"

const log = Log.create({ service: "phantom-proxy" })

// In-memory store mapping phantom tokens to their credential metadata
const ACTIVE_TOKENS = new Map<
  string,
  {
    upstream: string
    envVarKey: string
    injectHeader: string
    credentialFormat: string
  }
>()

export const PhantomProxyPlugin: Plugin = async () => ({
  "shell.env": async (input, output) => {
    // Determine the effective sandbox config for the current agent context
    const sandboxConfig = await Sandbox.getEffectiveConfig()

    const credentials = sandboxConfig.proxyCredentials
    if (!credentials || Object.keys(credentials).length === 0) return

    // Ensure passthrough array exists
    if (!output.passthrough) output.passthrough = []

    for (const [service, config] of Object.entries(credentials)) {
      // Generate a secure, 32-byte hex token for this session
      const phantomToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")

      // Store the mapping for the route handler
      ACTIVE_TOKENS.set(phantomToken, {
        upstream: config.upstream,
        envVarKey: config.envVarKey,
        injectHeader: config.injectHeader,
        credentialFormat: config.credentialFormat,
      })

      // Construct the local proxy URL using the dynamic server origin
      const baseUrl = `${Server.url().origin}/phantom/${service}`

      // Inject the fake variables into the shell environment
      output.env[config.baseUrlEnvVar] = baseUrl
      output.env[config.envVarKey] = phantomToken

      // Add them to passthrough so scrubEnv doesn't destroy them
      output.passthrough.push(config.baseUrlEnvVar, config.envVarKey)

      log.debug("injected phantom proxy routing", { service, baseUrlEnvVar: config.baseUrlEnvVar })
    }
  },

  "http.route": [
    {
      method: "*",
      path: "/phantom/:service/*",
      auth: [], // The phantom token IS the authentication
      handler: async (req, params) => {
        const service = params.service
        if (!service) {
          return new Response(JSON.stringify({ error: "Missing service" }), { status: 400 })
        }

        // 1. Extract the token from the request
        const authHeader =
          req.headers.get("authorization") || req.headers.get("x-api-key") || req.headers.get("x-goog-api-key") || ""
        const providedToken = authHeader.replace(/^Bearer\s+/i, "").trim()

        if (!providedToken) {
          log.warn("phantom proxy request missing token", { service })
          return new Response(JSON.stringify({ error: "Unauthorized: Missing phantom token" }), { status: 401 })
        }

        // 2. Look up the credential mapping
        const meta = ACTIVE_TOKENS.get(providedToken)
        if (!meta) {
          log.warn("phantom proxy invalid token", { service })
          return new Response(JSON.stringify({ error: "Unauthorized: Invalid phantom token" }), { status: 401 })
        }

        // 3. Retrieve the real credential from the host environment
        const realSecret = Env.get(meta.envVarKey)
        if (!realSecret) {
          log.error("phantom proxy missing host credential", { service, envVarKey: meta.envVarKey })
          return new Response(JSON.stringify({ error: "Service Unavailable: Host credential not configured" }), {
            status: 503,
          })
        }

        // 4. Construct the upstream request
        const urlObj = new URL(req.url)
        const matchStr = `/phantom/${service}`
        const idx = urlObj.pathname.indexOf(matchStr)
        const tailPath = idx >= 0 ? urlObj.pathname.slice(idx + matchStr.length) : urlObj.pathname

        const targetUrl = new URL(`${meta.upstream.replace(/\/$/, "")}${tailPath}${urlObj.search}`)

        // 5. Clone headers and strictly strip existing auth to prevent attacker injection
        const headers = new Headers(req.headers)
        headers.delete("host")
        headers.delete("authorization")
        headers.delete("x-api-key")
        headers.delete("x-goog-api-key")

        // 6. Inject the real credential
        const formattedCredential = meta.credentialFormat.replace("{}", realSecret)
        headers.set(meta.injectHeader, formattedCredential)

        // 7. Proxy the request preserving streaming semantics
        try {
          const proxiedReq = new Request(targetUrl.toString(), {
            method: req.method,
            headers,
            body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
            // @ts-ignore - Required by Bun for streaming request bodies
            duplex: "half",
          })

          const response = await fetch(proxiedReq)

          const resHeaders = new Headers(response.headers)
          // Strip hop-by-hop headers
          resHeaders.delete("transfer-encoding")
          resHeaders.delete("content-encoding")

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: resHeaders,
          })
        } catch (error: any) {
          log.error("phantom proxy upstream error", { service, error: error.message })
          return new Response(JSON.stringify({ error: "Upstream Proxy Error", details: error.message }), {
            status: 502,
          })
        }
      },
    },
  ],
})
