import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Identifier } from "@/id/id"

export function DialogBtw(props: { sessionID: string; question: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const local = useLocal()
  const sdk = useSDK()
  const [text, setText] = createSignal<string>()
  const [err, setErr] = createSignal<string>()
  const [tick, setTick] = createSignal(0)

  useKeyboard((event) => {
    if (event.defaultPrevented) return
    if (event.name === "return" || event.name === "space") {
      event.preventDefault()
      event.stopPropagation()
      dialog.clear()
    }
  })

  createEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), 80)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const ctrl = new AbortController()
    void (async () => {
      try {
        const session = await sdk.client.session.get({ sessionID: props.sessionID }).then((x) => x.data)
        if (!session) throw new Error("Session not found")
        const history = await Session.messages({ sessionID: props.sessionID })
        const model = await (async () => {
          const current = local.model.current()
          if (current) return Provider.getModel(current.providerID, current.modelID)
          const parsed = await Provider.defaultModel()
          return Provider.getModel(parsed.providerID, parsed.modelID)
        })()
        const agent = await Agent.get(local.agent.current().name)
        if (!agent) throw new Error("Agent not found")
        const user = {
          id: Identifier.ascending("message"),
          sessionID: props.sessionID,
          role: "user",
          agent: agent.name,
          model: { providerID: model.providerID, modelID: model.id },
          time: { created: Date.now() },
        } as MessageV2.User
        const prompt = [
          "Answer this side question briefly without changing the main session history.",
          props.question,
        ].join("\n\n")
        const messages = [
          ...MessageV2.toModelMessages(history, model),
          {
            role: "user" as const,
            content: prompt,
          },
        ]
        const result = await LLM.stream({
          sessionID: props.sessionID,
          user,
          model,
          agent,
          system: [],
          abort: ctrl.signal,
          messages,
          tools: {},
          toolChoice: "none",
          retries: 1,
        })
        const out = await result.text
        if (!ctrl.signal.aborted) setText(out)
      } catch (error) {
        if (!ctrl.signal.aborted) setErr(error instanceof Error ? error.message : String(error))
      }
    })()
    onCleanup(() => ctrl.abort())
  })

  return (
    <box flexDirection="column" paddingLeft={2} marginTop={1} gap={1}>
      <text fg={theme.warning}>{"/btw " + props.question}</text>
      <Show
        when={err() || text()}
        fallback={
          <box paddingLeft={1}>
            <text fg={theme.warning}>{"Answering" + ".".repeat((tick() % 3) + 1)}</text>
          </box>
        }
      >
        <box paddingLeft={1}>
          <text fg={err() ? theme.error : theme.text}>{err() ?? text()}</text>
        </box>
      </Show>
      <box marginTop={1}>
        <text fg={theme.textMuted}>Press Escape, Enter, or Space to dismiss</text>
      </box>
    </box>
  )
}
