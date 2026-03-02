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

  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded)

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

  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedAndTag)

  return new TextDecoder().decode(decrypted)
}

export function createRemoteFetch(config: RemoteClientConfig): typeof fetch {
  const wsUrl = new URL(`/relay/${config.sessionId}`, config.relayUrl)
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"
  const protocols = ["oc-v1", `auth.${config.token}`]

  let ws: WebSocket | null = null
  if (typeof window !== "undefined" && window.WebSocket) {
    ws = new WebSocket(wsUrl.toString(), protocols)
    ws.binaryType = "arraybuffer"
  } else {
    const wsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!wsCtor) {
      throw new Error("No WebSocket constructor available in the global scope.")
    }
    ws = new wsCtor(wsUrl.toString(), protocols)
    ws.binaryType = "arraybuffer"
  }

  type Listener = (event: MessageEvent) => void
  const listeners = new Set<Listener>()

  // A map of pending RPC requests waiting for a response from the host
  const pendingRequests = new Map<string, { resolve: (res: Response) => void; reject: (err: Error) => void }>()

  ws.onmessage = async (event: MessageEvent) => {
    try {
      if (!(event.data instanceof ArrayBuffer)) {
        console.warn("Received non-binary data on remote WebSocket")
        return
      }
      const decryptedStr = await decryptPayload(event.data, config.encryptionKey)
      const payload = JSON.parse(decryptedStr)

      // Handle RPC responses (standard HTTP proxy results)
      if (payload.type === "rpc_response") {
        const pending = pendingRequests.get(payload.id)
        if (pending) {
          pendingRequests.delete(payload.id)
          pending.resolve(
            new Response(payload.body, {
              status: payload.status,
              headers: payload.headers,
            }),
          )
        }
        return
      }

      // Handle standard SSE stream events from the global bus
      const mockEvent = new MessageEvent("message", {
        data: JSON.stringify(payload),
      })

      for (const listener of listeners) {
        listener(mockEvent)
      }
    } catch (e) {
      console.error("Failed to decrypt or process remote message", e)
    }
  }

  const remoteFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    if (req.url.endsWith("/event")) {
      const mockStream = new ReadableStream({
        start(controller) {
          const streamListener = (e: MessageEvent) => {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(`data: ${e.data}\n\n`))
          }
          listeners.add(streamListener)

          req.signal?.addEventListener("abort", () => {
            listeners.delete(streamListener)
            controller.close()
          })
        },
      })

      return new Response(mockStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      })
    }

    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== ws.OPEN) {
        return reject(new Error("WebSocket is not connected"))
      }

      const processRequest = async () => {
        let body: string | undefined
        if (req.body) {
          const reader = req.body.getReader()
          const { value } = await reader.read()
          if (value) body = new TextDecoder().decode(value)
        }

        const urlObj = new URL(req.url)
        const id = crypto.randomUUID()

        const command = {
          id,
          method: req.method,
          path: urlObj.pathname + urlObj.search,
          body: body ? JSON.parse(body) : undefined,
          headers: Object.fromEntries(req.headers.entries()),
        }

        const encrypted = await encryptPayload(JSON.stringify(command), config.encryptionKey)
        ws!.send(encrypted)

        // Wait up to 15 seconds for an RPC response
        const timeout = setTimeout(() => {
          pendingRequests.delete(id)
          reject(new Error("Remote proxy request timed out"))
        }, 15000)

        pendingRequests.set(id, {
          resolve: (res) => {
            clearTimeout(timeout)
            resolve(res)
          },
          reject: (err) => {
            clearTimeout(timeout)
            reject(err)
          },
        })
      }

      processRequest().catch(reject)
    })
  }) as unknown as typeof fetch

  return remoteFetch
}

export function createRemoteClient(config: RemoteClientConfig) {
  const client = createClient({ ...config, fetch: createRemoteFetch(config) })
  return new OpencodeClient({ client })
}

export async function importRemoteKey(base64Key: string): Promise<CryptoKey> {
  // Convert base64url to Uint8Array
  const base64 = base64Key.replace(/-/g, "+").replace(/_/g, "/")
  const pad = base64.length % 4
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64
  const binaryString = atob(padded)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}
