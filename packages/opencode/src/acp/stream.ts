import type { AnyMessage, Stream } from "@agentclientprotocol/sdk"
import { Log } from "@/util/log"

const log = Log.create({ service: "acp-stream" })

type SocketState = {
  controller: ReadableStreamDefaultController<AnyMessage>
  buffer: string
}

/**
 * Creates an ACP Stream from a unix domain socket using NDJSON framing.
 *
 * Listens on the given unix socket path. When a client connects, bidirectional
 * NDJSON communication begins — same wire format as stdio, but over a socket
 * for higher bandwidth and no pipe buffer limitations.
 *
 * Only one client connection is accepted at a time (ACP is 1:1).
 */
export function socketStream(path: string): Promise<{ stream: Stream; cleanup: () => void }> {
  return new Promise((resolve) => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    // Clean up stale socket
    try {
      const { unlinkSync } = require("fs")
      unlinkSync(path)
    } catch {}

    const server = Bun.listen<SocketState>({
      unix: path,
      socket: {
        open(socket) {
          log.info("acp client connected", { path })

          let readableController: ReadableStreamDefaultController<AnyMessage>

          const readable = new ReadableStream<AnyMessage>({
            start(controller) {
              readableController = controller
            },
          })

          socket.data = { controller: readableController!, buffer: "" }

          const writable = new WritableStream<AnyMessage>({
            write(message) {
              const line = JSON.stringify(message) + "\n"
              socket.write(encoder.encode(line))
            },
          })

          resolve({
            stream: { readable, writable },
            cleanup: () => {
              server.stop()
              try {
                const { unlinkSync } = require("fs")
                unlinkSync(path)
              } catch {}
            },
          })
        },
        data(socket, data) {
          socket.data.buffer += decoder.decode(data as Uint8Array, { stream: true })
          const lines = socket.data.buffer.split("\n")
          socket.data.buffer = lines.pop() || ""
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              socket.data.controller.enqueue(JSON.parse(trimmed))
            } catch (err) {
              log.error("failed to parse NDJSON message", { error: err, line: trimmed })
            }
          }
        },
        close(socket) {
          log.info("acp client disconnected", { path })
          socket.data.controller.close()
        },
        error(socket, err) {
          log.error("acp socket error", { error: err, path })
          socket.data.controller.error(err)
        },
      },
    })

    log.info("acp socket listening", { path })
  })
}

type WSState = {
  controller: ReadableStreamDefaultController<AnyMessage>
}

/**
 * Creates an ACP Stream over a WebSocket connection on a unix socket.
 *
 * Starts a Bun HTTP server on the given unix socket path that accepts
 * WebSocket upgrades. ACP JSON-RPC messages are sent as WebSocket text frames
 * — one JSON message per frame, no newline delimiter needed.
 *
 * Benefits over NDJSON socket:
 * - Frame boundaries handled by WebSocket protocol (no newline parsing)
 * - Binary frame support for future extensions
 * - Built-in ping/pong keepalive
 */
export function websocketStream(path: string): Promise<{ stream: Stream; cleanup: () => void }> {
  return new Promise((resolve) => {
    // Clean up stale socket
    try {
      const { unlinkSync } = require("fs")
      unlinkSync(path)
    } catch {}

    let readableController: ReadableStreamDefaultController<AnyMessage>

    const readable = new ReadableStream<AnyMessage>({
      start(controller) {
        readableController = controller
      },
    })

    let activeSocket: import("bun").ServerWebSocket<WSState> | undefined

    const writable = new WritableStream<AnyMessage>({
      write(message) {
        if (!activeSocket) throw new Error("WebSocket not connected")
        activeSocket.send(JSON.stringify(message))
      },
    })

    const server = Bun.serve<WSState>({
      unix: path,
      fetch(req, server) {
        if (server.upgrade(req, { data: { controller: readableController } })) return undefined
        return new Response("WebSocket upgrade required", { status: 426 })
      },
      websocket: {
        open(socket) {
          log.info("acp websocket client connected", { path })
          activeSocket = socket
          resolve({
            stream: { readable, writable },
            cleanup: () => {
              server.stop()
              try {
                const { unlinkSync } = require("fs")
                unlinkSync(path)
              } catch {}
            },
          })
        },
        message(_socket, data) {
          const text = typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array)
          try {
            readableController.enqueue(JSON.parse(text))
          } catch (err) {
            log.error("failed to parse WebSocket message", { error: err })
          }
        },
        close() {
          log.info("acp websocket client disconnected", { path })
          activeSocket = undefined
          readableController.close()
        },
      },
    })

    log.info("acp websocket listening", { path })
  })
}
