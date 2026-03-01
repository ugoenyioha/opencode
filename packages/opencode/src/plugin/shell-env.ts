import type { Plugin } from "@opencode-ai/plugin"
import { Shell } from "../shell/shell"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { $ } from "bun"

const log = Log.create({ service: "shell-env-plugin" })

const shellSnapshot = Instance.state(async () => {
  try {
    const shell = Shell.acceptable()
    const script = `console.log(JSON.stringify(process.env))`
    // Build command string with proper quoting for paths with spaces
    // The shell's -lc flag requires the command as a single string argument
    const cmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`

    // Use an interactive login shell to ensure all profiles (.bashrc, .zshrc, etc) are sourced
    const text = await $`${shell} -lc ${cmd}`.text()

    // We regex match the JSON to ignore any other stdout chatter from dotfiles
    const match = text.match(/\{.*\}/s)
    if (match) {
      const env = JSON.parse(match[0])
      return { env, valid: true }
    }
  } catch (error) {
    log.error("failed to capture shell snapshot", { error })
  }
  return { env: {}, valid: false }
})

export const ShellEnvPlugin: Plugin = async () => {
  return {
    "shell.env": async (_input, output) => {
      const snapshot = await shellSnapshot()
      if (snapshot.valid) {
        output.env = { ...output.env, ...snapshot.env }
        output.isSnapshotValid = true
      }
    },
  }
}
