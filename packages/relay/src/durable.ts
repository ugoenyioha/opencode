import { Env } from "./index";

export class SessionRelay {
  state: DurableObjectState;
  env: Env;
  
  // In-memory references to active sockets
  hostSocket: WebSocket | null = null;
  viewerSockets: Set<WebSocket> = new Set();
  
  // Ring buffer for the last N messages to support viewer reconnection
  messageBuffer: Array<string | ArrayBuffer> = [];
  readonly MAX_BUFFER_SIZE = 100;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    
    // We would ideally load the messageBuffer from state.storage here,
    // but for the sake of simplicity and speed (since it's a transient session anyway)
    // we'll keep it strictly in memory. 
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Array<string | ArrayBuffer>>("messageBuffer");
      if (stored) {
        this.messageBuffer = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    // We already verified the JWT in the Worker before passing it to the DO
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const role = request.headers.get("X-Verified-Role");
    if (role !== "host" && role !== "viewer") {
      return new Response("Invalid role", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the socket and tag it for the WebSockets API
    this.state.acceptWebSocket(server, [role]);

    if (role === "host") {
      if (this.hostSocket) {
        // Kick out the old host if a new one connects with a valid token
        this.hostSocket.close(1000, "New host connected");
      }
      this.hostSocket = server;
      
      // Clear the buffer when a new host connects (it's a fresh session run)
      this.messageBuffer = [];
      await this.state.storage.delete("messageBuffer");
      
    } else if (role === "viewer") {
      this.viewerSockets.add(server);
      
      // Immediately flush the history buffer to the new viewer so they catch up on state
      for (const msg of this.messageBuffer) {
        try {
          server.send(msg);
        } catch (e) {
          // Ignore error on immediate flush, they probably disconnected instantly
        }
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const tags = this.state.getTags(ws);
    const isHost = tags.includes("host");

    if (isHost) {
      // 1. Buffer the message
      this.messageBuffer.push(message);
      if (this.messageBuffer.length > this.MAX_BUFFER_SIZE) {
        this.messageBuffer.shift(); // Remove oldest message
      }
      // Fire-and-forget save to storage so DO evictions don't lose it entirely
      this.state.storage.put("messageBuffer", this.messageBuffer).catch(() => {});

      // 2. Broadcast host messages to all connected viewers
      for (const viewer of this.viewerSockets) {
        try {
          viewer.send(message);
        } catch (e) {
          this.viewerSockets.delete(viewer);
        }
      }
    } else {
      // Forward viewer messages (commands) strictly to the host
      if (this.hostSocket) {
        try {
          this.hostSocket.send(message);
        } catch (e) {
          this.hostSocket = null;
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const tags = this.state.getTags(ws);
    if (tags.includes("host")) {
      this.hostSocket = null;
    } else {
      this.viewerSockets.delete(ws);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    const tags = this.state.getTags(ws);
    if (tags.includes("host")) {
      this.hostSocket = null;
    } else {
      this.viewerSockets.delete(ws);
    }
  }
}
