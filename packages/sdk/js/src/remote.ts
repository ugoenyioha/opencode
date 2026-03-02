import { OpencodeClient } from "./gen/sdk.gen.js"
import { createClient } from "./gen/client/client.gen.js"
import type { Config } from "./gen/client/types.gen.js"

export interface RemoteClientConfig extends Config {
  relayUrl: string
  sessionId: string
  token: string
  encryptionKey: CryptoKey // Web Crypto API AES-GCM Key
}

// 12 bytes for IV, 16 bytes for Auth Tag
const IV_LENGTH = 12
const TAG_LENGTH = 16

async function encryptPayload(payload: string, key: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encoded = new TextEncoder().encode(payload)
  
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  )
  
  // encrypted buffer contains ciphertext + auth tag
  const result = new Uint8Array(iv.length + encrypted.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(encrypted), iv.length)
  
  return result
}

async function decryptPayload(data: ArrayBuffer, key: CryptoKey): Promise<string> {
  const buffer = new Uint8Array(data)
  const iv = buffer.slice(0, IV_LENGTH)
  const encryptedAndTag = buffer.slice(IV_LENGTH)
  
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encryptedAndTag
  )
  
  return new TextDecoder().decode(decrypted)
}

export function createRemoteClient(config: RemoteClientConfig) {
  // 1. Establish WebSocket connection to the Relay
  const wsUrl = new URL(`/relay/${config.sessionId}?token=${config.token}`, config.relayUrl)
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"
  
  let ws: WebSocket | null = null;
  // Browser standard websocket API
  if (typeof window !== "undefined" && window.WebSocket) {
    ws = new WebSocket(wsUrl.toString())
    ws.binaryType = "arraybuffer"
  } else {
    // We are running in Node/Bun context (e.g. CLI attach command)
    // We expect the consumer to provide a global WebSocket polyfill or we handle it gracefully
    const WsCtor = (globalThis as any).WebSocket
    if (WsCtor) {
      ws = new WsCtor(wsUrl.toString())
      if (ws) ws.binaryType = "arraybuffer"
    } else {
      throw new Error("No WebSocket constructor available in the global scope.")
    }
  }

  // 2. Event emitter for SSE stream simulation
  type Listener = (event: MessageEvent) => void
  const listeners = new Set<Listener>()

  if (ws) {
    ws.onmessage = async (event: MessageEvent) => {
      try {
        if (!(event.data instanceof ArrayBuffer)) {
           console.warn("Received non-binary data on remote WebSocket")
           return
        }
        const decryptedStr = await decryptPayload(event.data, config.encryptionKey)
        const payload = JSON.parse(decryptedStr)
        
        // This simulates the SSE stream behavior that the OpenCode app expects
        // It creates a mock MessageEvent with the decrypted data
        const mockEvent = new MessageEvent("message", {
          data: JSON.stringify(payload)
        })
        
        for (const listener of listeners) {
          listener(mockEvent)
        }
      } catch (e) {
        console.error("Failed to decrypt or process remote message", e)
      }
    }
  }

  // 3. Custom fetch implementation that routes requests over the WebSocket
  const remoteFetch: any = async (req: Request) => {
    // Intercept SSE /event connection requests
    if (req.url.endsWith("/event")) {
      const mockStream = new ReadableStream({
        start(controller) {
          const streamListener = (e: MessageEvent) => {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(`data: ${e.data}\n\n`))
          }
          listeners.add(streamListener)
          
          // Provide a way to cleanup on abort
          req.signal?.addEventListener("abort", () => {
            listeners.delete(streamListener)
            controller.close()
          })
        }
      })
      
      return new Response(mockStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      })
    }

    // For standard API requests, we send them over the WebSocket as commands
    return new Promise(async (resolve, reject) => {
       if (!ws || ws.readyState !== ws.OPEN) {
         return reject(new Error("WebSocket is not connected"))
       }

       const urlObj = new URL(req.url)
       let body = undefined
       if (req.body) {
         const reader = req.body.getReader()
         const { value } = await reader.read()
         if (value) body = new TextDecoder().decode(value)
       }

       const command = {
         method: req.method,
         path: urlObj.pathname + urlObj.search,
         body: body ? JSON.parse(body) : undefined,
         headers: Object.fromEntries((req.headers as any).entries())
       }

       try {
         const encrypted = await encryptPayload(JSON.stringify(command), config.encryptionKey)
         ws.send(encrypted)
         
         // In this dumb-pipe RPC model, the remote host performs the action and emits the result 
         // as an SSE event via the message bus, so we don't strictly need to wait for a 1-to-1 HTTP response.
         // We can return a generic 200 OK to unblock the caller.
         resolve(new Response(JSON.stringify({ status: "ok" }), {
           status: 200,
           headers: { "Content-Type": "application/json" }
         }))
       } catch (e) {
         reject(e)
       }
    })
  }

  const baseConfig = { ...config, fetch: remoteFetch }
  const client = createClient(baseConfig)
  return new OpencodeClient({ client })
}

export async function importRemoteKey(base64Key: string): Promise<CryptoKey> {
  // Convert base64url to Uint8Array
  const base64 = base64Key.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  )
}
