import { Env } from "./index"

export class SessionRelay {
  state: DurableObjectState
  env: Env
  readonly MAX_VIEWERS = 64
  readonly MAX_MESSAGE_BYTES = 64 * 1024
  readonly MAX_BUFFER_SIZE = 25
  readonly MAX_BACKLOG_BYTES = 1_000_000
  readonly RATE_PER_SECOND = 30
  readonly RATE_BURST = 60

  // In-memory references to active sockets
  hostSocket: WebSocket | null = null
  viewerSockets: Set<WebSocket> = new Set()
  viewerRate = new Map<WebSocket, { tokens: number; t: number }>()

  // Ring buffer for the last N messages to support viewer reconnection
  messageBuffer: Array<string | ArrayBuffer> = []
  latestState: string | ArrayBuffer | null = null
  persistPending: Promise<void> | null = null
  persistQueued = false
  sessionGeneration = 0

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env

    // We would ideally load the messageBuffer from state.storage here,
    // but for the sake of simplicity and speed (since it's a transient session anyway)
    // we'll keep it strictly in memory.
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Array<string | ArrayBuffer>>("messageBuffer")
      if (stored) {
        this.messageBuffer = stored
      }
      const storedState = await this.state.storage.get<string | ArrayBuffer>("latestState")
      if (storedState) {
        this.latestState = storedState
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    // We already verified the JWT in the Worker before passing it to the DO
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 })
    }

    const role = request.headers.get("X-Verified-Role")
    if (role !== "host" && role !== "viewer") {
      return new Response("Invalid role", { status: 403 })
    }

    if (role === "viewer" && this.viewerSockets.size >= this.MAX_VIEWERS) {
      return new Response("Session is full", { status: 503 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept the socket and tag it for the WebSockets API
    this.state.acceptWebSocket(server, [role])

    if (role === "host") {
      if (this.hostSocket) {
        // Kick out the old host if a new one connects with a valid token
        this.hostSocket.close(1000, "New host connected")
      }
      this.hostSocket = server
      this.sessionGeneration += 1

      // Clear the buffer when a new host connects (it's a fresh session run)
      this.messageBuffer = []
      this.latestState = null
      await this.state.storage.delete(["messageBuffer", "latestState"])
    } else if (role === "viewer") {
      this.viewerSockets.add(server)
      this.viewerRate.set(server, { tokens: this.RATE_BURST, t: Date.now() })

      // Immediately flush the history buffer to the new viewer so they catch up on state
      if (this.latestState) {
        try {
          server.send(this.latestState)
        } catch {
          this.viewerSockets.delete(server)
          this.viewerRate.delete(server)
          return new Response(null, { status: 101, webSocket: client }) // Need to return, but let the block end
        }
      }

      for (const msg of this.messageBuffer) {
        try {
          server.send(msg)
        } catch {
          // Ignore error on immediate flush, they probably disconnected instantly
          this.viewerSockets.delete(server)
          this.viewerRate.delete(server)
          break
        }
      }
    }

    return new Response(null, {
      status: 101,
      headers: request.headers.get("X-WS-Protocol")
        ? { "Sec-WebSocket-Protocol": request.headers.get("X-WS-Protocol")! }
        : undefined,
      webSocket: client,
    })
  }

  messageSize(message: string | ArrayBuffer) {
    if (typeof message === "string") {
      return new TextEncoder().encode(message).byteLength
    }
    return message.byteLength
  }

  consume(ws: WebSocket) {
    const now = Date.now()
    const current = this.viewerRate.get(ws) ?? { tokens: this.RATE_BURST, t: now }
    const tokens = Math.min(this.RATE_BURST, current.tokens + ((now - current.t) / 1000) * this.RATE_PER_SECOND)
    if (tokens < 1) {
      this.viewerRate.set(ws, { tokens, t: now })
      return false
    }
    this.viewerRate.set(ws, { tokens: tokens - 1, t: now })
    return true
  }

  persistBuffer() {
    if (this.persistPending) {
      this.persistQueued = true
      return
    }

    const generation = this.sessionGeneration
    const buffer = [...this.messageBuffer]
    const state = this.latestState

    this.persistPending = Promise.resolve()
      .then(async () => {
        if (generation !== this.sessionGeneration) {
          return
        }
        await this.state.storage.put({ messageBuffer: buffer, latestState: state })
      })
      .catch(() => {})
      .then(() => {
        this.persistPending = null
        if (!this.persistQueued) {
          return
        }
        this.persistQueued = false
        this.persistBuffer()
      })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (this.messageSize(message) > this.MAX_MESSAGE_BYTES) {
      ws.close(1009, "Message too large")
      return
    }

    const tags = this.state.getTags(ws)
    const isHost = tags.includes("host")

    if (isHost) {
      // 1. Buffer the message
      try {
        const payloadStr = typeof message === "string" ? message : new TextDecoder().decode(message)
        // Check if this is the handshake state and pin it
        if (payloadStr.includes('"type":"server.connected"')) {
          this.latestState = message
        } else if (payloadStr.includes('"type":"server.heartbeat"')) {
          // don't buffer heartbeats
        } else {
          this.messageBuffer.push(message)
          if (this.messageBuffer.length > this.MAX_BUFFER_SIZE) {
            this.messageBuffer.shift() // Remove oldest message
          }
        }
      } catch {
        // Fallback for purely binary frames
        this.messageBuffer.push(message)
        if (this.messageBuffer.length > this.MAX_BUFFER_SIZE) {
          this.messageBuffer.shift() // Remove oldest message
        }
      }
      this.persistBuffer()

      // 2. Broadcast host messages to all connected viewers
      for (const viewer of this.viewerSockets) {
        const backlog = (viewer as WebSocket & { bufferedAmount?: number }).bufferedAmount ?? 0
        if (backlog > this.MAX_BACKLOG_BYTES) {
          viewer.close(1008, "Backpressure limit")
          this.viewerSockets.delete(viewer)
          this.viewerRate.delete(viewer)
          continue
        }
        try {
          viewer.send(message)
        } catch {
          this.viewerSockets.delete(viewer)
          this.viewerRate.delete(viewer)
        }
      }
    } else {
      if (!this.consume(ws)) {
        ws.close(1008, "Rate limit exceeded")
        this.viewerSockets.delete(ws)
        this.viewerRate.delete(ws)
        return
      }
      // Forward viewer messages (commands) strictly to the host
      if (this.hostSocket) {
        const host = this.hostSocket
        try {
          host.send(message)
        } catch {
          host.close(1011, "Host send failed")
          if (this.hostSocket === host) {
            this.hostSocket = null
          }
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const tags = this.state.getTags(ws)
    if (tags.includes("host")) {
      if (this.hostSocket === ws) {
        this.hostSocket = null
        // Explicitly disconnect viewers so UI does not hang
        for (const viewer of this.viewerSockets) {
          viewer.close(1011, "Host disconnected")
        }
        this.viewerSockets.clear()
        this.viewerRate.clear()
      }
    } else {
      this.viewerSockets.delete(ws)
      this.viewerRate.delete(ws)
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    const tags = this.state.getTags(ws)
    if (tags.includes("host")) {
      if (this.hostSocket === ws) {
        this.hostSocket = null
        // Explicitly disconnect viewers so UI does not hang
        for (const viewer of this.viewerSockets) {
          viewer.close(1011, "Host error")
        }
        this.viewerSockets.clear()
        this.viewerRate.clear()
      }
    } else {
      this.viewerSockets.delete(ws)
      this.viewerRate.delete(ws)
    }
  }
}
