import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Snapshot } from "../snapshot"
import { Project } from "./project"
import { Vcs } from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Flag } from "@/flag/flag"
import { SessionRecovery } from "@/session/recovery"
import { SessionCron } from "@/session/cron"
import { initProjectors } from "@/server/projectors"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  initProjectors()
  await Plugin.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  File.init()
  FileWatcher.init()
  Vcs.init()
  Snapshot.init()
  SessionCron.start()

  try {
    await Promise.resolve(SessionRecovery.recover())
  } catch (error) {
    Log.Default.warn("session recovery failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })

  // Team features — order matters:
  // 1. onCleanedRestorePermissions() registers synchronously so it's ready
  //    before recover(), which could trigger cleanup if all members are shutdown.
  // 2. recover() marks stale busy executions as cancelled, transitions members to ready, and notifies leads.
  // 3. autoCleanup() subscribes AFTER recover finishes (.finally()) to avoid
  //    spurious MemberStatusChanged events during recovery triggering premature cleanup.
  // Fire-and-forget: don't block bootstrap completion.
  if (Flag.OPENCODE_EXPERIMENTAL_AGENT_TEAMS) {
    // Dynamic import — only load team module when the feature flag is enabled
    import("../team").then(({ Team }) => {
      Team.onCleanedRestorePermissions()
      import("../team/permission-routing").then(({ setupPermissionRouting }) => {
        setupPermissionRouting()
      })
      Team.recover()
        .catch((err) => {
          Log.Default.warn("team recovery failed", { error: err instanceof Error ? err.message : err })
        })
        .finally(() => {
          Team.autoCleanup()
          Team.enforceTimeouts()
        })
    })
  }
}
