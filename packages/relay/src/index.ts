import { SessionRelay } from "./durable"
import { SignJWT, jwtVerify } from "jose"

export { SessionRelay }

export interface Env {
  SESSION_RELAY: DurableObjectNamespace
  JWT_SECRET?: string // Secret used to sign session tokens. Must be set in wrangler secrets.
  JWT_ISSUER?: string
  JWT_AUDIENCE?: string
  WS_ALLOWED_ORIGINS?: string
}

const DEFAULT_ISSUER = "opencode-relay"
const DEFAULT_AUDIENCE = "opencode-remote-control"
const SESSION_ID = /^[a-f0-9-]{36}$/i

function issuer(env: Env) {
  return env.JWT_ISSUER || DEFAULT_ISSUER
}

function audience(env: Env) {
  return env.JWT_AUDIENCE || DEFAULT_AUDIENCE
}

function validSessionId(input: string) {
  return SESSION_ID.test(input)
}

function parseProtocols(value: string | null) {
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseToken(request: Request) {
  const header = request.headers.get("Authorization")
  if (header?.startsWith("Bearer ")) {
    return {
      token: header.slice(7).trim(),
      protocol: undefined,
    }
  }

  const protocols = parseProtocols(request.headers.get("Sec-WebSocket-Protocol"))
  const auth = protocols.find((item) => item.startsWith("auth."))
  if (!auth) {
    return {
      token: undefined,
      protocol: protocols.includes("oc-v1") ? "oc-v1" : undefined,
    }
  }

  return {
    token: auth.slice(5),
    protocol: protocols.includes("oc-v1") ? "oc-v1" : undefined,
  }
}

function originAllowed(request: Request, env: Env) {
  const raw = env.WS_ALLOWED_ORIGINS?.trim()
  if (!raw) return true
  const origin = request.headers.get("Origin")
  if (!origin) return true
  const allowed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return allowed.includes(origin)
}

async function getSecretKey(env: Env): Promise<Uint8Array> {
  const secret = env.JWT_SECRET
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be configured and be at least 32 characters long")
  }
  const encoder = new TextEncoder()
  return encoder.encode(secret)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // CORS Headers for API routes
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders })
    }

    if (path === "/health") {
      return new Response("OK", { status: 200, headers: corsHeaders })
    }

    // --- API Routes ---

    if (path === "/api/session/create" && request.method === "POST") {
      // 1. Generate a random session ID
      const sessionId = crypto.randomUUID()

      // 2. Generate a Host JWT valid for this specific session
      let key: Uint8Array
      try {
        key = await getSecretKey(env)
      } catch {
        return new Response("Relay auth configuration error", { status: 500, headers: corsHeaders })
      }
      const hostToken = await new SignJWT({ role: "host", sessionId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setIssuer(issuer(env))
        .setAudience(audience(env))
        .setJti(crypto.randomUUID())
        .setExpirationTime("24h") // Host session lasts max 24 hours
        .sign(key)

      return new Response(JSON.stringify({ sessionId, token: hostToken }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    if (path === "/api/session/join" && request.method === "POST") {
      try {
        const body = (await request.json()) as { sessionId?: string }
        if (!body.sessionId || !validSessionId(body.sessionId)) {
          return new Response("Missing sessionId", { status: 400, headers: corsHeaders })
        }

        // 3. Generate a Viewer JWT valid for this specific session
        let key: Uint8Array
        try {
          key = await getSecretKey(env)
        } catch {
          return new Response("Relay auth configuration error", { status: 500, headers: corsHeaders })
        }
        const viewerToken = await new SignJWT({ role: "viewer", sessionId: body.sessionId })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setIssuer(issuer(env))
          .setAudience(audience(env))
          .setJti(crypto.randomUUID())
          .setExpirationTime("1h") // Viewer token expires relatively quickly
          .sign(key)

        return new Response(JSON.stringify({ token: viewerToken }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      } catch (e) {
        return new Response("Invalid JSON", { status: 400, headers: corsHeaders })
      }
    }

    // --- WebSocket Routes ---

    if (path.startsWith("/relay/")) {
      const urlSessionId = path.split("/")[2]
      if (!urlSessionId || !validSessionId(urlSessionId)) {
        return new Response("Missing session ID", { status: 400 })
      }

      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 400 })
      }

      if (!originAllowed(request, env)) {
        return new Response("Origin not allowed", { status: 403 })
      }

      // Check for token in Authorization header or WebSocket subprotocol auth token.
      const auth = parseToken(request)
      const token = auth.token
      if (!token) {
        return new Response("Missing token", { status: 401 })
      }

      try {
        // Validate the JWT
        const key = await getSecretKey(env)
        const { payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
          issuer: issuer(env),
          audience: audience(env),
        })

        if (payload.role !== "host" && payload.role !== "viewer") {
          return new Response("Invalid token role", { status: 403 })
        }

        if (typeof payload.sessionId !== "string" || !validSessionId(payload.sessionId)) {
          return new Response("Invalid token session", { status: 403 })
        }

        if (payload.sessionId !== urlSessionId) {
          return new Response("Token does not match session", { status: 403 })
        }

        // Add the verified role to the request so the Durable Object knows who is connecting.
        const headers = new Headers(request.headers)
        headers.set("X-Verified-Role", payload.role)
        if (auth.protocol) {
          headers.set("X-WS-Protocol", auth.protocol)
          headers.set("Sec-WebSocket-Protocol", auth.protocol)
        } else {
          headers.delete("X-WS-Protocol")
          headers.delete("Sec-WebSocket-Protocol")
        }
        const upstream = new Request(request, { headers })

        const id = env.SESSION_RELAY.idFromName(urlSessionId)
        const stub = env.SESSION_RELAY.get(id)

        return stub.fetch(upstream)
      } catch {
        return new Response("Invalid or expired token", { status: 401 })
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders })
  },
}
