import { cmd } from "./cmd"
import { Log } from "../../util/log"
import { randomBytes, createCipheriv, createDecipheriv } from "crypto"
import WebSocket from "ws"
import { GlobalBus } from "../../bus/global"
import { Server } from "../../server/server"
import { resolveNetworkOptions } from "../network"
import { UI } from "../ui"

const ALGORITHM = "aes-256-gcm"
const MAX_WS_MESSAGE_BYTES = 64 * 1024
const MAX_BODY_BYTES = 256 * 1024
const MAX_BUFFERED_BYTES = 1_000_000
const FETCH_TIMEOUT_MS = 10_000
const RATE_PER_SECOND = 30
const RATE_BURST = 60
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])
const ALLOWED_PATH_PREFIXES = [
  "/session",
  "/event",
  "/project",
  "/config",
  "/agent",
  "/tool",
  "/file",
  "/provider",
  "/mcp",
  "/team",
  "/permission",
  "/question",
  "/vcs",
  "/path",
  "/command",
  "/lsp",
  "/formatter",
  "/api/",
]
const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "transfer-encoding",
  "content-length",
  "cookie",
  "authorization",
])

type RemoteCommand = {
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}

function encrypt(text: string, key: Buffer) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Format: iv(12):authTag(16):encryptedData
  return Buffer.concat([iv, authTag, encrypted])
}

function decrypt(data: Buffer, key: Buffer) {
  const iv = data.subarray(0, 12)
  const authTag = data.subarray(12, 28)
  const encrypted = data.subarray(28)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(encrypted) + decipher.final("utf8")
}

function containsControl(input: string) {
  return /[\u0000-\u001f\u007f]/.test(input)
}

function bodySize(input: unknown) {
  if (input === undefined) return 0
  if (typeof input === "string") {
    return Buffer.byteLength(input)
  }
  return Buffer.byteLength(JSON.stringify(input))
}

function parseHeaders(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const entries = Object.entries(input)
  const next: Record<string, string> = {}
  for (const [rawKey, rawValue] of entries) {
    if (typeof rawValue !== "string") {
      throw new Error("Invalid header value")
    }
    const key = rawKey.toLowerCase()
    if (key.startsWith("sec-websocket-") || key.startsWith("proxy-") || key.startsWith("x-forwarded-")) {
      continue
    }
    if (BLOCKED_HEADERS.has(key)) {
      continue
    }
    next[key] = rawValue
  }
  return next
}

function allowedPath(path: string) {
  return ALLOWED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))
}

function parseCommand(input: string): RemoteCommand {
  const decoded = JSON.parse(input) as unknown
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Invalid command payload")
  }

  const method = (decoded as { method?: unknown }).method
  const path = (decoded as { path?: unknown }).path
  const headers = parseHeaders((decoded as { headers?: unknown }).headers)
  const body = (decoded as { body?: unknown }).body

  if (typeof method !== "string") {
    throw new Error("Missing method")
  }
  const nextMethod = method.toUpperCase()
  if (!ALLOWED_METHODS.has(nextMethod)) {
    throw new Error("Method not allowed")
  }

  if (typeof path !== "string") {
    throw new Error("Missing path")
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || containsControl(path)) {
    throw new Error("Invalid path")
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    throw new Error("Absolute paths are not allowed")
  }
  if (!allowedPath(path)) {
    throw new Error("Path not allowed")
  }

  if (bodySize(body) > MAX_BODY_BYTES) {
    throw new Error("Body too large")
  }

  const nextBody = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  return {
    method: nextMethod,
    path,
    headers,
    body: nextBody,
  }
}

function toBuffer(data: WebSocket.RawData) {
  if (typeof data === "string") return Buffer.from(data)
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

export const RemoteControlCommand = cmd({
  command: "remote-control",
  builder: (yargs) =>
    yargs
      .option("relay", {
        type: "string",
        description: "URL of the remote control relay server",
        default: process.env.OPENCODE_RELAY_URL || "http://127.0.0.1:8787",
      })
      .option("viewer", {
        type: "string",
        description: "Base URL of the web viewer",
        default: process.env.OPENCODE_VIEWER_URL || "http://localhost:5173",
      })
      .option("port", {
        type: "number",
        description: "Port to run the local API server on (defaults to random)",
        default: 0,
      }),
  describe: "Securely exposes your local OpenCode agent to a remote viewer",
  handler: async (args) => {
    const log = Log.create({ service: "remote-control" })
    UI.println(UI.Style.TEXT_INFO + "Starting OpenCode Remote Control host..." + UI.Style.TEXT_NORMAL)

    // 1. Generate AES-256-GCM Key
    const rawKey = randomBytes(32)
    const keyBase64 = rawKey.toString("base64url")

    // 2. Start local OpenCode server (this binds the necessary routes and local API)
    // We bind it locally so that we can process SDK commands via the standard HTTP layer
    const networkOpts = await resolveNetworkOptions({ port: args.port, host: "127.0.0.1" } as any)
    const server = await Server.listen(networkOpts)
    const localBaseUrl = `http://${server.hostname}:${server.port}`

    // 3. Register session with Relay
    UI.println(UI.Style.TEXT_DIM + `Connecting to relay at ${args.relay}...` + UI.Style.TEXT_NORMAL)
    let sessionData: { sessionId: string; token: string }
    try {
      const response = await fetch(`${args.relay}/api/session/create`, { method: "POST" })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      sessionData = await (response.json() as Promise<{ sessionId: string; token: string }>)
    } catch (e) {
      UI.error(`Failed to register with relay: ${(e as Error).message}`)
      process.exit(1)
    }

    const { sessionId, token } = sessionData

    // 4. Connect to Relay via WebSocket
    const wsUrl = new URL(`/relay/${sessionId}`, args.relay)
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"

    const ws = new WebSocket(wsUrl.toString(), ["oc-v1"], {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    ws.on("open", () => {
      UI.println(UI.Style.TEXT_SUCCESS + "Connected to Relay securely." + UI.Style.TEXT_NORMAL)
    })

    // 5. Intercept local GlobalBus events and forward them securely to the Relay
    const localEventHandler = (event: { directory?: string; payload: unknown }) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          log.warn("dropping remote event due to websocket backpressure")
          return
        }
        try {
          const payloadStr = JSON.stringify(event.payload)
          const encrypted = encrypt(payloadStr, rawKey)
          if (encrypted.byteLength > MAX_WS_MESSAGE_BYTES) {
            log.warn("dropping oversized remote event")
            return
          }
          ws.send(encrypted)
        } catch (e) {
          log.warn("failed to encrypt and send event", { e })
        }
      }
    }
    GlobalBus.on("event", localEventHandler)

    // Send a heartbeat event to keep the connection alive and send initial connection signal
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const encrypted = encrypt(JSON.stringify({ type: "server.heartbeat" }), rawKey)
        ws.send(encrypted)
      }
    }, 10000)

    // Send initial connected event immediately
    ws.on("open", () => {
      const connectedEvent = encrypt(JSON.stringify({ type: "server.connected", properties: {} }), rawKey)
      ws.send(connectedEvent)
    })

    let rateTokens = RATE_BURST
    let rateAt = Date.now()
    const consume = () => {
      const now = Date.now()
      rateTokens = Math.min(RATE_BURST, rateTokens + ((now - rateAt) / 1000) * RATE_PER_SECOND)
      rateAt = now
      if (rateTokens < 1) return false
      rateTokens -= 1
      return true
    }

    // 6. Receive encrypted commands from Viewer -> proxy them to the local API
    ws.on("message", async (data: WebSocket.RawData) => {
      const packet = toBuffer(data)
      if (packet.byteLength > MAX_WS_MESSAGE_BYTES) {
        ws.close(1009, "Message too large")
        return
      }
      if (!consume()) {
        ws.close(1008, "Rate limit exceeded")
        return
      }
      try {
        const decryptedStr = decrypt(packet, rawKey)
        const command = parseCommand(decryptedStr)

        // Proxy the request to the local server
        const proxyUrl = new URL(command.path, localBaseUrl)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        const fetchOpts: RequestInit = {
          method: command.method,
          headers: {
            ...command.headers,
            ...(command.body ? { "content-type": command.headers["content-type"] ?? "application/json" } : {}),
          },
          signal: controller.signal,
        }
        if (command.body && (command.method === "POST" || command.method === "PUT" || command.method === "PATCH")) {
          fetchOpts.body = command.body
        }
        await fetch(proxyUrl, fetchOpts).finally(() => clearTimeout(timeout))

        // We do not need to send the response back via the WebSocket!
        // The local server emits standard GlobalBus events for state changes, which we are
        // already intercepting and forwarding via `localEventHandler` above.
        // If the viewer needs synchronous responses for specific RPCs, we can add a reply mechanism later.
      } catch (e) {
        if (e instanceof Error && /not allowed|Invalid|Missing|too large/i.test(e.message)) {
          ws.close(1008, "Invalid command")
          return
        }
        log.warn("failed to process incoming remote command", { error: (e as Error).message })
      }
    })

    ws.on("close", () => {
      UI.println(UI.Style.TEXT_WARNING + "Connection to Relay lost. Exiting." + UI.Style.TEXT_NORMAL)
      clearInterval(heartbeat)
      GlobalBus.off("event", localEventHandler)
      server.stop()
      process.exit(1)
    })

    ws.on("error", (err) => {
      UI.error(`Relay WebSocket error: ${err.message}`)
    })

    // 7. Output Viewer URL
    const viewerUrl = `${args.viewer}/remote?relay=${encodeURIComponent(args.relay)}&session=${sessionId}#key=${keyBase64}`
    console.log("\n" + "=".repeat(70))
    console.log("🚀 REMOTE CONTROL SESSION ACTIVE")
    console.log("=".repeat(70))
    console.log("Share this URL to securely access your OpenCode workspace:")
    console.log(`\n\x1b[36m${viewerUrl}\x1b[0m\n`)
    console.log("⚠️  WARNING: Anyone with this link can execute commands on your machine.")
    console.log("   The link contains the E2E encryption key. Do not share it publicly.")
    console.log("=".repeat(70) + "\n")

    // Keep alive until ctrl+c
    let stopping = false
    const shutdown = async () => {
      if (stopping) return
      stopping = true
      UI.println(UI.Style.TEXT_DIM + "Shutting down remote control session..." + UI.Style.TEXT_NORMAL)
      clearInterval(heartbeat)
      GlobalBus.off("event", localEventHandler)
      ws.close()
      await server.stop()
      process.exit(0)
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)

    await new Promise(() => {})
  },
})
