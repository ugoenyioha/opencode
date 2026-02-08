import { Log } from "@/util/log"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "@/acp/agent"
import { Server } from "@/server/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { socketStream, websocketStream } from "@/acp/stream"

const log = Log.create({ service: "acp-command" })

export const AcpCommand = cmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs)
      .option("cwd", {
        describe: "working directory",
        type: "string",
        default: process.cwd(),
      })
      .option("transport", {
        describe: "ACP transport: stdio (default), socket (NDJSON over unix socket), websocket (WS over unix socket)",
        type: "string",
        choices: ["stdio", "socket", "websocket"] as const,
        default: "stdio",
      })
      .option("acp-socket", {
        describe: "unix socket path for ACP protocol (used with --transport socket or websocket)",
        type: "string",
      })
  },
  handler: async (args) => {
    process.env.OPENCODE_CLIENT = "acp"
    await bootstrap(process.cwd(), async () => {
      const opts = await resolveNetworkOptions(args)
      const server = Server.listen(opts)

      const sdk = opts.unix
        ? createOpencodeClient({
            baseUrl: "http://opencode.internal",
            fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
              fetch(input, { ...init, unix: opts.unix } as any)) as typeof fetch,
          })
        : createOpencodeClient({
            baseUrl: `http://${server.hostname}:${server.port}`,
          })

      const agent = await ACP.init({ sdk })
      const transport = args.transport as "stdio" | "socket" | "websocket"

      if (transport === "socket" || transport === "websocket") {
        const path = args["acp-socket"]
        if (!path) {
          console.error("--acp-socket is required when using --transport socket or websocket")
          process.exit(1)
        }

        const result = transport === "socket" ? await socketStream(path) : await websocketStream(path)

        log.info("acp transport ready", { transport, path })

        new AgentSideConnection((conn) => {
          return agent.create(conn, { sdk })
        }, result.stream)

        log.info("acp connection established", { transport })
        await new Promise(() => {}) // keep alive
        result.cleanup()
        return
      }

      // Default: stdio transport
      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (err) => {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        },
      })
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          process.stdin.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          process.stdin.on("end", () => controller.close())
          process.stdin.on("error", (err) => controller.error(err))
        },
      })

      const stream = ndJsonStream(input, output)

      new AgentSideConnection((conn) => {
        return agent.create(conn, { sdk })
      }, stream)

      log.info("acp connection established", { transport: "stdio" })
      process.stdin.resume()
      await new Promise((resolve, reject) => {
        process.stdin.on("end", resolve)
        process.stdin.on("error", reject)
      })
    })
  },
})
