import { afterEach, describe, expect, test } from "bun:test"
import { socketStream, websocketStream } from "../../src/acp/stream"
import { tmpdir } from "os"
import { join } from "path"
import type { AnyMessage } from "@agentclientprotocol/sdk"

function tmpSocket(prefix: string) {
  return join(tmpdir(), `oc-test-${prefix}-${process.pid}-${Date.now()}.sock`)
}

function request(id: number, method: string, params?: unknown): AnyMessage {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) } as AnyMessage
}

function notification(method: string, params?: unknown): AnyMessage {
  return { jsonrpc: "2.0", method, ...(params !== undefined && { params }) } as AnyMessage
}

function response(id: number, result: unknown): AnyMessage {
  return { jsonrpc: "2.0", id, result } as AnyMessage
}

/**
 * Minimal WebSocket client over unix socket using Bun.connect + raw framing.
 * Only supports text frames (opcode 0x1) which is all ACP needs.
 */
function connectWS(path: string): Promise<{
  send: (data: string) => void
  messages: string[]
  close: () => void
  closed: Promise<void>
  opened: Promise<void>
}> {
  const messages: string[] = []
  let closedResolve: () => void
  let openedResolve: () => void
  const closed = new Promise<void>((r) => (closedResolve = r))
  const opened = new Promise<void>((r) => (openedResolve = r))

  let socket: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never
  let upgraded = false
  let headerBuf = ""

  return Bun.connect<{}>({
    unix: path,
    socket: {
      open(s) {
        socket = s as typeof socket
        // Send HTTP upgrade request
        const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64")
        s.write(
          `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        )
      },
      data(_s, raw) {
        const bytes = new Uint8Array(raw as unknown as ArrayBuffer)

        if (!upgraded) {
          // Accumulate until we see the end of HTTP headers
          headerBuf += new TextDecoder().decode(bytes)
          const idx = headerBuf.indexOf("\r\n\r\n")
          if (idx === -1) return
          // Check for 101 Switching Protocols
          if (!headerBuf.startsWith("HTTP/1.1 101")) {
            console.error("WS upgrade failed:", headerBuf.substring(0, 100))
            return
          }
          upgraded = true
          openedResolve()
          // Process any remaining bytes after headers as WS frames
          const remaining = headerBuf.substring(idx + 4)
          if (remaining.length > 0) {
            parseWSFrames(new TextEncoder().encode(remaining), messages)
          }
          return
        }

        parseWSFrames(bytes, messages)
      },
      close() {
        closedResolve()
      },
      error(_s, err) {
        console.error("ws client error:", err)
        closedResolve()
      },
    },
    data: {},
  }).then((s) => {
    socket = s as typeof socket
    return {
      send: (data: string) => {
        // Encode as masked WebSocket text frame
        socket.write(encodeWSFrame(data))
      },
      messages,
      close: () => socket.end(),
      closed,
      opened,
    }
  })
}

/** Parse WebSocket frames from raw bytes, extracting text payloads */
function parseWSFrames(bytes: Uint8Array, out: string[]) {
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) break
    const byte1 = bytes[offset]
    const byte2 = bytes[offset + 1]
    const opcode = byte1 & 0x0f
    const masked = (byte2 & 0x80) !== 0
    let payloadLen = byte2 & 0x7f
    offset += 2

    if (payloadLen === 126) {
      if (offset + 2 > bytes.length) break
      payloadLen = (bytes[offset] << 8) | bytes[offset + 1]
      offset += 2
    } else if (payloadLen === 127) {
      // 8-byte length — skip for tests (messages won't be that large)
      offset += 8
      break
    }

    let maskKey: Uint8Array | undefined
    if (masked) {
      if (offset + 4 > bytes.length) break
      maskKey = bytes.slice(offset, offset + 4)
      offset += 4
    }

    if (offset + payloadLen > bytes.length) break
    const payload = bytes.slice(offset, offset + payloadLen)
    offset += payloadLen

    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4]
      }
    }

    if (opcode === 0x1) {
      // Text frame
      out.push(new TextDecoder().decode(payload))
    }
    // Ignore close/ping/pong frames for test purposes
  }
}

/** Encode a string as a masked WebSocket text frame (client must mask) */
function encodeWSFrame(data: string): Uint8Array {
  const payload = new TextEncoder().encode(data)
  const mask = crypto.getRandomValues(new Uint8Array(4))
  const masked = new Uint8Array(payload.length)
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4]
  }

  let header: Uint8Array
  if (payload.length < 126) {
    header = new Uint8Array([0x81, 0x80 | payload.length, ...mask])
  } else if (payload.length < 65536) {
    header = new Uint8Array([0x81, 0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff, ...mask])
  } else {
    // Not needed for tests but handle for completeness
    header = new Uint8Array(14)
    header[0] = 0x81
    header[1] = 0x80 | 127
    // 8-byte big-endian length
    const view = new DataView(header.buffer, 2)
    view.setBigUint64(0, BigInt(payload.length))
    header.set(mask, 10)
  }

  const frame = new Uint8Array(header.length + masked.length)
  frame.set(header)
  frame.set(masked, header.length)
  return frame
}

// ────────────────────────────────────────────────
// socketStream tests (Option 3: NDJSON over unix socket)
// ────────────────────────────────────────────────

describe("acp.stream.socketStream", () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  test("client sends NDJSON, server readable receives parsed messages", async () => {
    const path = tmpSocket("ndjson-recv")
    const pending = socketStream(path)

    // Small delay to let Bun.listen bind
    await Bun.sleep(10)

    const client = await Bun.connect<{}>({
      unix: path,
      socket: { data() {}, open() {}, close() {}, error() {} },
      data: {},
    })

    const { stream, cleanup } = await pending
    cleanups.push(cleanup, () => client.end())

    const msg1 = request(1, "initialize", { protocolVersion: 1 })
    const msg2 = notification("session/cancel", { sessionId: "s1" })
    client.write(JSON.stringify(msg1) + "\n" + JSON.stringify(msg2) + "\n")

    const reader = stream.readable.getReader()
    const r1 = await reader.read()
    expect(r1.done).toBe(false)
    expect(r1.value).toEqual(msg1)

    const r2 = await reader.read()
    expect(r2.done).toBe(false)
    expect(r2.value).toEqual(msg2)
    reader.releaseLock()
  })

  test("server writable sends NDJSON to client", async () => {
    const path = tmpSocket("ndjson-send")
    const pending = socketStream(path)
    await Bun.sleep(10)

    let received = ""
    const client = await Bun.connect<{}>({
      unix: path,
      socket: {
        data(_s, data) {
          received += new TextDecoder().decode(data as Uint8Array)
        },
        open() {},
        close() {},
        error() {},
      },
      data: {},
    })

    const { stream, cleanup } = await pending
    cleanups.push(cleanup, () => client.end())

    const msg = response(1, { protocolVersion: 1, agentCapabilities: {} })
    const writer = stream.writable.getWriter()
    await writer.write(msg)
    writer.releaseLock()

    await Bun.sleep(50)
    const lines = received.trim().split("\n")
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0])).toEqual(msg)
  })

  test("bidirectional round-trip", async () => {
    const path = tmpSocket("ndjson-rt")
    const pending = socketStream(path)
    await Bun.sleep(10)

    const clientReceived: string[] = []
    const client = await Bun.connect<{}>({
      unix: path,
      socket: {
        data(_s, data) {
          const text = new TextDecoder().decode(data as Uint8Array)
          for (const line of text.trim().split("\n")) {
            if (line.trim()) clientReceived.push(line.trim())
          }
        },
        open() {},
        close() {},
        error() {},
      },
      data: {},
    })

    const { stream, cleanup } = await pending
    cleanups.push(cleanup, () => client.end())

    // Client -> Server
    const req = request(42, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "hello" }] })
    client.write(JSON.stringify(req) + "\n")

    const reader = stream.readable.getReader()
    const { value } = await reader.read()
    expect(value).toEqual(req)
    reader.releaseLock()

    // Server -> Client
    const resp = response(42, { stopReason: "end_turn" })
    const writer = stream.writable.getWriter()
    await writer.write(resp)
    writer.releaseLock()

    await Bun.sleep(50)
    expect(clientReceived.length).toBe(1)
    expect(JSON.parse(clientReceived[0])).toEqual(resp)
  })

  test("handles partial/chunked messages", async () => {
    const path = tmpSocket("ndjson-chunk")
    const pending = socketStream(path)
    await Bun.sleep(10)

    const client = await Bun.connect<{}>({
      unix: path,
      socket: { data() {}, open() {}, close() {}, error() {} },
      data: {},
    })

    const { stream, cleanup } = await pending
    cleanups.push(cleanup, () => client.end())

    // Send a message split across two writes
    const msg = request(7, "session/new", { cwd: "/tmp" })
    const json = JSON.stringify(msg)
    const mid = Math.floor(json.length / 2)

    client.write(json.slice(0, mid))
    await Bun.sleep(20)
    client.write(json.slice(mid) + "\n")

    const reader = stream.readable.getReader()
    const { value } = await reader.read()
    expect(value).toEqual(msg)
    reader.releaseLock()
  })

  test("100 messages in rapid burst", async () => {
    const path = tmpSocket("ndjson-burst")
    const pending = socketStream(path)
    await Bun.sleep(10)

    const client = await Bun.connect<{}>({
      unix: path,
      socket: { data() {}, open() {}, close() {}, error() {} },
      data: {},
    })

    const { stream, cleanup } = await pending
    cleanups.push(cleanup, () => client.end())

    const count = 100
    const messages: AnyMessage[] = []
    let batch = ""
    for (let i = 0; i < count; i++) {
      const msg = request(i, "test/ping", { seq: i })
      messages.push(msg)
      batch += JSON.stringify(msg) + "\n"
    }
    client.write(batch)

    const reader = stream.readable.getReader()
    for (let i = 0; i < count; i++) {
      const { value, done } = await reader.read()
      expect(done).toBe(false)
      expect(value).toEqual(messages[i])
    }
    reader.releaseLock()
  })

  test("client disconnect closes readable stream", async () => {
    const path = tmpSocket("ndjson-dc")
    const pending = socketStream(path)
    await Bun.sleep(10)

    const client = await Bun.connect<{}>({
      unix: path,
      socket: { data() {}, open() {}, close() {}, error() {} },
      data: {},
    })

    const { stream, cleanup } = await pending
    cleanups.push(cleanup)

    client.end()
    await Bun.sleep(50)

    const reader = stream.readable.getReader()
    const { done } = await reader.read()
    expect(done).toBe(true)
    reader.releaseLock()
  })

  test("cleanup removes socket file", async () => {
    const path = tmpSocket("ndjson-rm")
    const pending = socketStream(path)
    await Bun.sleep(10)

    const client = await Bun.connect<{}>({
      unix: path,
      socket: { data() {}, open() {}, close() {}, error() {} },
      data: {},
    })

    const { cleanup } = await pending

    client.end()
    await Bun.sleep(20)
    cleanup()

    const exists = await Bun.file(path).exists()
    expect(exists).toBe(false)
  })
})

// ────────────────────────────────────────────────
// websocketStream tests (Option 4: WebSocket over unix socket)
// ────────────────────────────────────────────────

describe("acp.stream.websocketStream", () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  test("client sends JSON via WebSocket, server readable receives parsed messages", async () => {
    const path = tmpSocket("ws-recv")
    const pending = websocketStream(path)
    await Bun.sleep(10)

    const ws = await connectWS(path)
    await ws.opened
    cleanups.push(() => ws.close())

    const { stream, cleanup } = await pending
    cleanups.push(cleanup)

    const msg = request(1, "initialize", { protocolVersion: 1 })
    ws.send(JSON.stringify(msg))

    const reader = stream.readable.getReader()
    const { value, done } = await reader.read()
    expect(done).toBe(false)
    expect(value).toEqual(msg)
    reader.releaseLock()
  })

  test("server writable sends JSON to WebSocket client", async () => {
    const path = tmpSocket("ws-send")
    const pending = websocketStream(path)
    await Bun.sleep(10)

    const ws = await connectWS(path)
    await ws.opened
    cleanups.push(() => ws.close())

    const { stream, cleanup } = await pending
    cleanups.push(cleanup)

    const msg = response(1, { protocolVersion: 1, agentCapabilities: {} })
    const writer = stream.writable.getWriter()
    await writer.write(msg)
    writer.releaseLock()

    await Bun.sleep(100)
    expect(ws.messages.length).toBe(1)
    expect(JSON.parse(ws.messages[0])).toEqual(msg)
  })

  test("bidirectional round-trip", async () => {
    const path = tmpSocket("ws-rt")
    const pending = websocketStream(path)
    await Bun.sleep(10)

    const ws = await connectWS(path)
    await ws.opened
    cleanups.push(() => ws.close())

    const { stream, cleanup } = await pending
    cleanups.push(cleanup)

    // Client -> Server
    const req = request(42, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "hello" }] })
    ws.send(JSON.stringify(req))

    const reader = stream.readable.getReader()
    const { value } = await reader.read()
    expect(value).toEqual(req)
    reader.releaseLock()

    // Server -> Client
    const resp = response(42, { stopReason: "end_turn" })
    const writer = stream.writable.getWriter()
    await writer.write(resp)
    writer.releaseLock()

    await Bun.sleep(100)
    expect(ws.messages.length).toBe(1)
    expect(JSON.parse(ws.messages[0])).toEqual(resp)
  })

  test("100 messages in rapid burst", async () => {
    const path = tmpSocket("ws-burst")
    const pending = websocketStream(path)
    await Bun.sleep(10)

    const ws = await connectWS(path)
    await ws.opened
    cleanups.push(() => ws.close())

    const { stream, cleanup } = await pending
    cleanups.push(cleanup)

    const count = 100
    const messages: AnyMessage[] = []
    for (let i = 0; i < count; i++) {
      const msg = request(i, "test/ping", { seq: i })
      messages.push(msg)
      ws.send(JSON.stringify(msg))
    }

    const reader = stream.readable.getReader()
    for (let i = 0; i < count; i++) {
      const { value, done } = await reader.read()
      expect(done).toBe(false)
      expect(value).toEqual(messages[i])
    }
    reader.releaseLock()
  })

  test("client disconnect closes readable stream", async () => {
    const path = tmpSocket("ws-dc")
    const pending = websocketStream(path)
    await Bun.sleep(10)

    const ws = await connectWS(path)
    await ws.opened
    cleanups.push(() => {
      try {
        ws.close()
      } catch {}
    })

    const { stream, cleanup } = await pending
    cleanups.push(cleanup)

    ws.close()
    await Bun.sleep(100)

    const reader = stream.readable.getReader()
    const { done } = await reader.read()
    expect(done).toBe(true)
    reader.releaseLock()
  })

  test("cleanup removes socket file", async () => {
    const path = tmpSocket("ws-rm")
    const pending = websocketStream(path)
    await Bun.sleep(10)

    const ws = await connectWS(path)
    await ws.opened

    const { cleanup } = await pending

    ws.close()
    await Bun.sleep(20)
    cleanup()

    const exists = await Bun.file(path).exists()
    expect(exists).toBe(false)
  })

  test("non-websocket HTTP request returns 426", async () => {
    const path = tmpSocket("ws-426")
    websocketStream(path)
    await Bun.sleep(10)

    const resp = await fetch("http://localhost/", { unix: path } as any)
    expect(resp.status).toBe(426)
    const text = await resp.text()
    expect(text).toBe("WebSocket upgrade required")

    try {
      require("fs").unlinkSync(path)
    } catch {}
  })
})
