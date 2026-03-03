import { cmd } from "./cmd"
import { Log } from "../../util/log"
import { Server } from "../../server/server"
import { resolveNetworkOptions } from "../network"
import { UI } from "../ui"
import { RemoteHost } from "../../remote/host"

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
    UI.println(UI.Style.TEXT_INFO + "Starting OpenCode Remote Control host..." + UI.Style.TEXT_NORMAL)

    // Start local OpenCode server (this binds the necessary routes and local API)
    // We bind it locally so that we can process SDK commands via the standard HTTP layer
    const networkOpts = await resolveNetworkOptions({
      port: args.port,
      hostname: "127.0.0.1",
      unix: undefined,
      mdns: false,
      "mdns-domain": "opencode.local",
      cors: [],
    })
    const server = await Server.listen(networkOpts)

    UI.println(UI.Style.TEXT_DIM + `Connecting to relay at ${args.relay}...` + UI.Style.TEXT_NORMAL)

    let stopping = false
    const host = new RemoteHost({
      relay: args.relay,
      viewer: args.viewer,
      onDisconnect: () => {
        if (!stopping) {
          UI.println(UI.Style.TEXT_WARNING + "Connection to Relay lost. Exiting." + UI.Style.TEXT_NORMAL)
          server.stop()
          process.exit(1)
        }
      },
    })

    try {
      const viewerUrl = await host.start()
      UI.println(UI.Style.TEXT_SUCCESS + "Connected to Relay securely." + UI.Style.TEXT_NORMAL)

      console.log("\n" + "=".repeat(70))
      console.log("🚀 REMOTE CONTROL SESSION ACTIVE")
      console.log("=".repeat(70))
      console.log("Share this URL to securely access your OpenCode workspace:")
      console.log(`\n\x1b[36m${viewerUrl}\x1b[0m\n`)
      console.log("⚠️  WARNING: Anyone with this link can execute commands on your machine.")
      console.log("   The link contains the E2E encryption key. Do not share it publicly.")
      console.log("=".repeat(70) + "\n")
    } catch (e: any) {
      UI.error(`Failed to register with relay: ${e.message}`)
      await server.stop()
      process.exit(1)
    }

    const shutdown = async (signal?: string) => {
      if (stopping) return
      stopping = true
      UI.println(
        UI.Style.TEXT_DIM + `Shutting down remote control session... (signal: ${signal})` + UI.Style.TEXT_NORMAL,
      )
      await host.stop()
      await server.stop()
      process.exit(0)
    }

    process.on("SIGINT", () => shutdown("SIGINT"))
    process.on("SIGTERM", () => shutdown("SIGTERM"))

    await new Promise(() => {})
  },
})
