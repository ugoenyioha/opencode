import { randomBytes, createCipheriv, createDecipheriv } from "crypto"
import WebSocket from "ws"
import { GlobalBus } from "../bus/global"
import { Server } from "../server/server"
import { Log } from "../util/log"

const ALGORITHM = "aes-256-gcm"
const MAX_WS_MESSAGE_BYTES = 64 * 1024
const MAX_BODY_BYTES = 256 * 1024
const MAX_BUFFERED_BYTES = 1_000_000
const FETCH_TIMEOUT_MS = 10_000
const RATE_PER_SECOND = 30
const RATE_BURST = 60
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])
const ALLOWED_PATH_PREFIXES = [
  "/session", "/event", "/project", "/config", "/agent", "/tool", "/file",
  "/provider", "/mcp", "/team", "/permission", "/question", "/vcs", "/path",
  "/command", "/lsp", "/formatter", "/api/"
]
const BLOCKED_HEADERS = new Set([
  "host", "connection", "upgrade", "transfer-encoding", "content-length", "cookie", "authorization"
])

type RemoteCommand = {
  id: string
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

function containsControl(input: string) { return /[\u0000-\u001f\u007f]/.test(input) }
function bodySize(input: unknown) {
  if (input === undefined) return 0
  if (typeof input === "string") return Buffer.byteLength(input)
  return Buffer.byteLength(JSON.stringify(input))
}
function parseHeaders(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const next: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (typeof rawValue !== "string") throw new Error("Invalid header value")
    const key = rawKey.toLowerCase()
    if (key.startsWith("sec-websocket-") || key.startsWith("proxy-") || key.startsWith("x-forwarded-")) continue
    if (BLOCKED_HEADERS.has(key)) continue
    next[key] = rawValue
  }
  return next
}
function allowedPath(path: string) {
  return ALLOWED_PATH_PREFIXES.some((prefix) => {
    const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix
    return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`)
  })
}
function parseCommand(input: string): RemoteCommand {
  const decoded = JSON.parse(input) as any
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid command payload")
  const id = decoded.id
  const method = decoded.method
  const path = decoded.path
  const headers = parseHeaders(decoded.headers)
  const body = decoded.body
  if (typeof id !== "string") throw new Error("Missing request id")
  if (typeof method !== "string") throw new Error("Missing method")
  const nextMethod = method.toUpperCase()
  if (!ALLOWED_METHODS.has(nextMethod)) throw new Error("Method not allowed")
  if (typeof path !== "string") throw new Error("Missing path")
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || containsControl(path)) throw new Error("Invalid path")
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) throw new Error("Absolute paths are not allowed")
  const resolvedPath = new URL(path, "http://localhost")
  const nextPath = resolvedPath.pathname + resolvedPath.search
  if (!allowedPath(resolvedPath.pathname)) throw new Error("Path not allowed")
  if (bodySize(body) > MAX_BODY_BYTES) throw new Error("Body too large")
  const nextBody = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  return { id, method: nextMethod, path: nextPath, headers, body: nextBody }
}
function toBuffer(data: WebSocket.RawData) {
  if (typeof data === "string") return Buffer.from(data)
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

export class RemoteHost {
  private ws: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private stopping = false
  public url: string | null = null

  constructor(
    private args: { relay: string; viewer: string; onDisconnect?: () => void }
  ) {}

  async start() {
    const log = Log.create({ service: "remote-control-host" })
    const rawKey = randomBytes(32)
    const keyBase64 = rawKey.toString("base64url")

    let sessionData: { sessionId: string; token: string }
    const response = await fetch(`${this.args.relay}/api/session/create`, { method: "POST" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    sessionData = await response.json()

    const { sessionId, token } = sessionData

    const wsUrl = new URL(`/relay/${sessionId}`, this.args.relay)
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"

    const ws = new WebSocket(wsUrl.toString(), ["oc-v1"], {
      headers: { Authorization: `Bearer ${token}` }
    })
    this.ws = ws

    const localEventHandler = (event: { directory?: string; payload: unknown }) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          log.warn("dropping remote event due to websocket backpressure")
          return
        }
        try {
          const encrypted = encrypt(JSON.stringify(event.payload), rawKey)
          if (encrypted.byteLength > MAX_WS_MESSAGE_BYTES) return
          ws.send(encrypted)
        } catch (e) {
          log.warn("failed to encrypt and send event", { e })
        }
      }
    }
    GlobalBus.on("event", localEventHandler)

    this.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encrypt(JSON.stringify({ type: "server.heartbeat" }), rawKey))
      }
    }, 10000)

    ws.on("open", () => {
      ws.send(encrypt(JSON.stringify({ type: "server.connected", properties: {} }), rawKey))
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

    ws.on("message", async (data: WebSocket.RawData) => {
      const packet = toBuffer(data)
      if (packet.byteLength > MAX_WS_MESSAGE_BYTES) { ws.close(1009, "Message too large"); return }
      if (!consume()) { ws.close(1008, "Rate limit exceeded"); return }
      try {
        const decryptedStr = decrypt(packet, rawKey)
        const command = parseCommand(decryptedStr)

        const fetchOpts: RequestInit = {
          method: command.method,
          headers: {
            ...command.headers,
            ...(command.body ? { "content-type": command.headers["content-type"] ?? "application/json" } : {}),
          },
        }
        if (command.body && ["POST", "PUT", "PATCH"].includes(command.method)) {
          fetchOpts.body = command.body
        }

        const request = new Request(`http://localhost${command.path}`, fetchOpts)
        const proxyRes = await Server.App().fetch(request)

        const resContentType = proxyRes.headers.get("content-type") || ""
        let resBody: string | undefined
        if (resContentType.includes("application/json") || resContentType.includes("text/")) {
          resBody = await proxyRes.text().catch(() => undefined)
        }

        const rpcPayload = {
          type: "rpc_response",
          id: command.id,
          status: proxyRes.status,
          headers: Object.fromEntries(proxyRes.headers.entries()),
          body: resBody,
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encrypt(JSON.stringify(rpcPayload), rawKey))
        }
      } catch (e) {
        if (e instanceof Error && /not allowed|Invalid|Missing|too large/i.test(e.message)) {
          ws.close(1008, "Invalid command")
          return
        }
        log.warn("failed to process incoming remote command", { error: (e as Error).message })
      }
    })

    ws.on("close", () => {
      this.cleanup(localEventHandler)
      if (!this.stopping && this.args.onDisconnect) this.args.onDisconnect()
    })

    ws.on("error", (err) => {
      log.error(`Relay WebSocket error: ${err.message}`)
    })

    this.url = `${this.args.viewer}/remote?relay=${encodeURIComponent(this.args.relay)}&session=${sessionId}#key=${keyBase64}`
    return this.url
  }

  private cleanup(handler: any) {
    if (this.heartbeat) clearInterval(this.heartbeat)
    GlobalBus.off("event", handler)
  }

  async stop() {
    this.stopping = true
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}
