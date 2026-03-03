import { createSignal, onMount, onCleanup, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "./dialog"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { Clipboard } from "../util/clipboard"
import { useToast } from "./toast"
import { useSDK } from "../context/sdk"

// Global state for the TUI session so it persists if the dialog is closed and reopened
let activeViewerUrl: string | null = null
let isRemoteActive = false

export function DialogRemoteControl(props: { overrideRelayUrl?: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const toast = useToast()
  const sdk = useSDK()

  const [url, setUrl] = createSignal<string | null>(activeViewerUrl)
  const [loading, setLoading] = createSignal(!activeViewerUrl && !isRemoteActive)

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
    if (activeViewerUrl || isRemoteActive) return

    setLoading(true)
    isRemoteActive = true

    const relay = props.overrideRelayUrl || process.env.OPENCODE_RELAY_URL || "http://127.0.0.1:8787"
    const viewer = process.env.OPENCODE_VIEWER_URL || "http://localhost:5173"

    sdk.client.instance.remote
      .start({ relay, viewer })
      .then((generatedUrl: any) => {
        if (!generatedUrl.data) throw new Error("No URL returned")
        activeViewerUrl = generatedUrl.data.url
        setUrl(generatedUrl.data.url)
        setLoading(false)
      })
      .catch((err: any) => {
        toast.show({ message: "Failed to start remote session", variant: "error" })
        isRemoteActive = false
        activeViewerUrl = null
        setUrl(null)
        setLoading(false)
      })
  })

  onCleanup(() => {
    // If the dialog closes but process is still starting up without a URL, kill it
    if (isRemoteActive && !activeViewerUrl) {
      sdk.client.instance.remote.stop().catch(() => {})
      isRemoteActive = false
      activeViewerUrl = null
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
    if (isRemoteActive) {
      sdk.client.instance.remote.stop().catch(() => {})
      isRemoteActive = false
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
