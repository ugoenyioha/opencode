import { createSignal, onMount, onCleanup, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "./dialog"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { Process } from "../../../../util/process"
import { Clipboard } from "../util/clipboard"
import type { ChildProcess } from "child_process"
import { useToast } from "./toast"

// Global state for the TUI session so it persists if the dialog is closed and reopened
let activeRemoteProcess: ReturnType<typeof Process.spawn> | null = null
let activeViewerUrl: string | null = null

export function DialogRemoteControl(props: { overrideRelayUrl?: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const toast = useToast()

  const [url, setUrl] = createSignal<string | null>(activeViewerUrl)
  const [loading, setLoading] = createSignal(!activeViewerUrl && !activeRemoteProcess)

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      dialog.clear()
    }
    if (evt.name === "return") {
      if (url()) handleCopy()
      else dialog.clear()
    }
  })

  onMount(() => {
    if (activeViewerUrl || activeRemoteProcess) return

    setLoading(true)

    // Run the command using current opencode binary
    // Using process.argv to reconstruct the current execution context
    const isLocal = process.env.OPENCODE_BIN === "true" || process.argv[1]?.endsWith("src/index.ts")
    const baseArgs = isLocal ? ["run", process.argv[1], "remote-control"] : ["remote-control"]
    const args = props.overrideRelayUrl ? [...baseArgs, "--relay", props.overrideRelayUrl] : baseArgs
    const bin = isLocal ? "bun" : process.argv[0]

    const proc = Process.spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })

    activeRemoteProcess = proc

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString()
      // Extract URL from output: http://.../remote?relay=...#key=...
      const match = text.match(/(https?:\/\/[^\s]+remote\?relay=[^\s]+#key=[^\s]+)/)
      if (match) {
        activeViewerUrl = match[1]
        setUrl(match[1])
        setLoading(false)
      }
    })

    proc.exited.finally(() => {
      activeRemoteProcess = null
      activeViewerUrl = null
      setUrl(null)
      setLoading(false)
    })
  })

  onCleanup(() => {
    // If the dialog closes but process is still starting up without a URL, kill it
    if (activeRemoteProcess && !activeViewerUrl) {
      activeRemoteProcess.kill("SIGINT")
      activeRemoteProcess = null
    }
  })

  const handleCopy = () => {
    if (url()) {
      Clipboard.copy(url()!)
        .then(() => toast.show({ message: "Remote URL copied!", variant: "success" }))
        .catch(() => toast.show({ message: "Failed to copy URL", variant: "error" }))
      dialog.clear()
    }
  }

  const handleStop = () => {
    if (activeRemoteProcess) {
      activeRemoteProcess.kill("SIGINT")
      activeRemoteProcess = null
      activeViewerUrl = null
      setUrl(null)
    }
    toast.show({ message: "Remote session stopped", variant: "info" })
    dialog.clear()
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Remote Control Session
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <box paddingBottom={1} flexDirection="column" gap={1}>
        <Show when={loading()}>
          <text fg={theme.textMuted}>Starting secure remote proxy tunnel...</text>
        </Show>
        <Show when={!loading() && url()}>
          <text fg={theme.textMuted}>Share this URL to allow remote access to your workspace.</text>
          <text fg={theme.primary}>{url() ?? ""}</text>
          <text fg={theme.error}>⚠️ WARNING: Anyone with this link can execute commands on your machine.</text>
        </Show>
        <Show when={!loading() && !url()}>
          <text fg={theme.error}>Failed to start remote control session.</text>
        </Show>
      </box>

      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={2}>
        <Show when={url() != null}>
          <box paddingLeft={2} paddingRight={2} backgroundColor={theme.error} onMouseUp={handleStop}>
            <text fg={theme.text}>stop</text>
          </box>
          <box paddingLeft={2} paddingRight={2} backgroundColor={theme.primary} onMouseUp={handleCopy}>
            <text fg={theme.selectedListItemText}>copy & close (enter)</text>
          </box>
        </Show>
        <Show when={!url()}>
          <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
            <text fg={theme.selectedListItemText}>close (enter)</text>
          </box>
        </Show>
      </box>
    </box>
  )
}
