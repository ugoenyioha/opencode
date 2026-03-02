import { cmd } from "./cmd"
import { Log } from "../../util/log"
import { randomBytes, createCipheriv, createDecipheriv } from "crypto"
import WebSocket from "ws"
import { GlobalBus } from "../../bus/global"
import { Server } from "../../server/server"
import { resolveNetworkOptions } from "../network"
import { UI } from "../ui"

const ALGORITHM = "aes-256-gcm"

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
    const wsUrl = new URL(`/relay/${sessionId}?role=host`, args.relay)
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"

    const ws = new WebSocket(wsUrl.toString(), {
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
        try {
          const payloadStr = JSON.stringify(event.payload)
          const encrypted = encrypt(payloadStr, rawKey)
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

    // 6. Receive encrypted commands from Viewer -> proxy them to the local API
    ws.on("message", async (data: Buffer) => {
      try {
        const decryptedStr = decrypt(data, rawKey)
        const command = JSON.parse(decryptedStr) as { method: string; path: string; body?: any; headers?: any }

        // Proxy the request to the local server
        const proxyUrl = new URL(command.path, localBaseUrl)
        const fetchOpts: RequestInit = {
          method: command.method,
          headers: command.headers || { "Content-Type": "application/json" },
        }
        if (command.body && (command.method === "POST" || command.method === "PUT" || command.method === "PATCH")) {
          fetchOpts.body = typeof command.body === "string" ? command.body : JSON.stringify(command.body)
        }

        const proxyRes = await fetch(proxyUrl, fetchOpts)

        // We do not need to send the response back via the WebSocket!
        // The local server emits standard GlobalBus events for state changes, which we are
        // already intercepting and forwarding via `localEventHandler` above.
        // If the viewer needs synchronous responses for specific RPCs, we can add a reply mechanism later.
      } catch (e) {
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
