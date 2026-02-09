import { Plugin } from "../plugin"
import { Share } from "../share/share"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { Flag } from "@/flag/flag"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  Share.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })

  // Team features: recover interrupted teammates, then enable auto-cleanup.
  // Recovery runs first so stale teams are restored before cleanup subscribes.
  // Fire-and-forget: don't block bootstrap completion.
  if (Flag.OPENCODE_EXPERIMENTAL_AGENT_TEAMS) {
    import("../team").then(({ Team }) => {
      Team.recover()
        .catch((err) => {
          Log.Default.warn("team recovery failed", { error: err instanceof Error ? err.message : err })
        })
        .finally(() => {
          Team.autoCleanup()
        })
    })
  }
}
