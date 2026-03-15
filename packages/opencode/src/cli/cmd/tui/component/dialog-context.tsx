import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createMemo, createResource } from "solid-js"
import { useSync } from "../context/sync"
import { useLocal } from "../context/local"
import { Provider } from "@/provider/provider"
import { SystemPrompt } from "@/session/system"
import { InstructionPrompt } from "@/session/instruction"
import { ToolRegistry } from "@/tool/registry"
import { Token } from "@/util/token"

export function DialogContext(props: { sessionID: string }) {
  const sync = useSync()
  const local = useLocal()

  const [usage] = createResource(async () => {
    const current = local.model.current()
    const parsed = current ?? (await Provider.defaultModel())
    const model = await Provider.getModel(parsed.providerID, parsed.modelID)
    const prompt = (await SystemPrompt.provider(model)).join("\n")
    const memory = (await InstructionPrompt.system()).join("\n")
    const tools = await ToolRegistry.tools({ providerID: model.providerID, modelID: model.id }, local.agent.current())
    const toolText = tools.map((item) => `${item.id}\n${item.description}`).join("\n")
    return {
      limit: model.limit.context || model.limit.input || 0,
      prompt: Token.estimate(prompt),
      memory: Token.estimate(memory),
      tools: Token.estimate(toolText),
    }
  })

  const percent = (tokens: number, limit: number) =>
    limit ? `${Math.max(0, Math.round((tokens / limit) * 100))}%` : "-"

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const parts = messages.flatMap((message) => sync.data.part[message.id] ?? [])
    const tool = parts.filter((part) => part.type === "tool")
    const compactions = parts.filter((part) => part.type === "compaction")
    const attachments = parts.flatMap((part) =>
      "attachments" in part && Array.isArray(part.attachments) ? part.attachments : [],
    )
    const truncated = tool.filter((part) => {
      const meta = (part.state as any)?.metadata
      return meta?.truncated || meta?.outputPath
    })
    const heavy = tool.filter((part) => {
      const out = (part.state as any)?.output
      return typeof out === "string" && out.length > 5000
    })
    const messageText = messages
      .flatMap((message) => sync.data.part[message.id] ?? [])
      .map((part) => {
        if (part.type === "text") return part.text
        if (part.type === "tool") return part.state.status === "completed" ? ((part.state as any).output ?? "") : ""
        return ""
      })
      .join("\n")
    const messageTokens = Token.estimate(messageText)
    const promptTokens = usage()?.prompt ?? 0
    const memoryTokens = usage()?.memory ?? 0
    const toolTokens = usage()?.tools ?? 0
    const limit = usage()?.limit ?? 0
    const used = promptTokens + memoryTokens + toolTokens + messageTokens
    const free = Math.max(0, limit - used)
    const suggestions: string[] = []

    if (limit && used / limit > 0.8)
      suggestions.push("Run /compact to summarize older turns and recover context budget.")
    if (truncated.length > 0)
      suggestions.push(
        "Use Read or Grep on saved tool output files instead of asking the model to replay long terminal output.",
      )
    if (attachments.length > 4)
      suggestions.push("Reduce attachment count or size if the session starts compacting aggressively.")
    if (compactions.length > 0)
      suggestions.push("Use /btw for side questions or start a new session when the topic shifts significantly.")
    if (heavy.length > 5)
      suggestions.push("Prefer focused searches and smaller tool requests when many large tool results accumulate.")
    if (suggestions.length === 0) suggestions.push("Context looks healthy. No immediate cleanup action is recommended.")

    return [
      {
        title: `Estimated usage ${used.toLocaleString()} / ${limit.toLocaleString()} tokens`,
        description: limit ? `${percent(used, limit)} used, ${free.toLocaleString()} free` : undefined,
        value: "usage",
        category: "Estimated Usage",
      },
      {
        title: `System prompt ~${promptTokens.toLocaleString()} tokens`,
        description: percent(promptTokens, limit),
        value: "prompt_tokens",
        category: "Estimated Usage",
      },
      {
        title: `Memory files ~${memoryTokens.toLocaleString()} tokens`,
        description: percent(memoryTokens, limit),
        value: "memory_tokens",
        category: "Estimated Usage",
      },
      {
        title: `Tools ~${toolTokens.toLocaleString()} tokens`,
        description: percent(toolTokens, limit),
        value: "tool_tokens",
        category: "Estimated Usage",
      },
      {
        title: `Messages ~${messageTokens.toLocaleString()} tokens`,
        description: percent(messageTokens, limit),
        value: "message_tokens",
        category: "Estimated Usage",
      },
      {
        title: `${messages.length} messages in this session`,
        value: "messages",
        category: "Current State",
      },
      {
        title: `${tool.length} tool results`,
        value: "tools",
        category: "Current State",
      },
      {
        title: `${compactions.length} compactions`,
        value: "compactions",
        category: "Current State",
      },
      {
        title: `${attachments.length} attachments`,
        value: "attachments",
        category: "Current State",
      },
      {
        title: `${truncated.length} truncated or spilled tool outputs`,
        value: "truncated",
        category: "Current State",
      },
      ...suggestions.map((item, index) => ({
        title: item,
        value: `suggestion:${index}`,
        category: "Suggestions",
      })),
    ]
  })

  return <DialogSelect title="Context Diagnostics" options={options()} onSelect={() => {}} />
}
