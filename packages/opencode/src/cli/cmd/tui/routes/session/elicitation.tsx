import { useKeyboard } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { useTheme } from "../../context/theme"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { useDialog } from "../../ui/dialog"

type ElicitationRequest = {
  sessionID: string
  requestID: string
  prompt: unknown
}

export function ElicitationPrompt(props: { request: ElicitationRequest }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const bindings = useTextareaKeybindings()
  const dialog = useDialog()
  let input: TextareaRenderable

  const payload = () => {
    const text = input.plainText
    if (typeof props.request.prompt === "object" && props.request.prompt) {
      try {
        return JSON.stringify({ data: JSON.parse(text) })
      } catch {}
    }
    return JSON.stringify({ text })
  }

  const reply = () =>
    sdk.fetch(`${sdk.url}/session/${props.request.sessionID}/elicitation/${props.request.requestID}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload(),
    })

  const text = () => {
    if (typeof props.request.prompt === "string") return props.request.prompt
    if (!props.request.prompt || typeof props.request.prompt !== "object") return String(props.request.prompt ?? "")
    const item = props.request.prompt as {
      message?: string
      url?: string
      fields?: { name?: string; label?: string; type?: string; required?: boolean }[]
    }
    return [
      item.message,
      item.url ? `URL: ${item.url}` : undefined,
      ...(item.fields ?? []).map((field) => {
        const head = field.label || field.name || "field"
        const meta = [field.type, field.required ? "required" : undefined].filter(Boolean).join(", ")
        return meta ? `- ${head} (${meta})` : `- ${head}`
      }),
    ]
      .filter(Boolean)
      .join("\n")
  }

  const reject = () =>
    sdk.fetch(`${sdk.url}/session/${props.request.sessionID}/elicitation/${props.request.requestID}/reject`, {
      method: "POST",
    })

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (evt.name === "return") {
      evt.preventDefault()
      void reply()
      return
    }

    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      void reject()
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.accent}>{"◈"}</text>
          <text fg={theme.text}>MCP input required</text>
        </box>
        <box paddingLeft={1} border={["left"]} borderColor={theme.borderActive}>
          <text fg={theme.textMuted}>{text()}</text>
        </box>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent="space-between"
        alignItems="center"
        gap={1}
      >
        <textarea
          ref={(val: TextareaRenderable) => (input = val)}
          focused
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          keyBindings={bindings()}
        />
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>submit</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>reject</span>
          </text>
        </box>
      </box>
    </box>
  )
}
