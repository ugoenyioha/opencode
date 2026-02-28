import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Instance } from "../../project/instance"
import { Log } from "../../util/log"
import { Database } from "../../storage/db"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    if (!opts.unix && !Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = await Server.listen(opts)
    if (opts.unix) {
      console.log(`opencode server listening on unix://${opts.unix}`)
    } else {
      console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    }

    let workspaceSync: Array<ReturnType<typeof Workspace.startSyncing>> = []
    if (Installation.isLocal()) {
      workspaceSync = Project.list().map((project) => Workspace.startSyncing(project))
    }

    let stopping = false
    const shutdown = async (signal: string) => {
      if (stopping) return
      stopping = true
      Log.Default.info("shutdown", { signal })
      console.log(`\nReceived ${signal}, shutting down...`)
      try {
        await Promise.race([
          Instance.disposeAll(),
          new Promise((resolve) => {
            setTimeout(resolve, 5000)
          }),
        ])
        await Promise.all(workspaceSync.map((item) => item.stop()))
        await server.stop(false)
      } catch (error) {
        Log.Default.warn("shutdown encountered error", {
          signal,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      Database.close()
      process.exit(0)
    }
    process.on("SIGTERM", () => {
      shutdown("SIGTERM")
    })
    process.on("SIGINT", () => {
      shutdown("SIGINT")
    })

    await new Promise(() => {})
  },
})
