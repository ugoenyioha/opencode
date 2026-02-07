import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Session } from "./index"
import { SessionStatus } from "./status"
import z from "zod"

const log = Log.create({ service: "suggest" })

export namespace SessionSuggestion {
  export const Event = {
    Suggestion: BusEvent.define(
      "session.suggestion",
      z.object({
        sessionID: z.string(),
        text: z.string(),
      }),
    ),
  }

  // Track in-flight suggestion requests to avoid duplicates
  const pending = Instance.state(() => new Set<string>())

  /**
   * Generate a prompt suggestion after the agent finishes responding.
   * Uses a lightweight LLM call with the conversation history.
   */
  export async function generate(input: {
    sessionID: string
    providerID: string
    modelID: string
  }) {
    const cfg = await Config.get()

    // Check if suggestions are disabled
    if ((cfg.experimental as Record<string, unknown>)?.suggestions === false) return

    // Avoid duplicate requests
    if (pending().has(input.sessionID)) return
    pending().add(input.sessionID)

    try {
      const msgs = await Session.messages({ sessionID: input.sessionID })

      // Skip if no messages or only one turn (not enough context)
      const userMessages = msgs.filter((m) => m.info.role === "user")
      if (userMessages.length < 1) return

      // Skip if session is busy again (user already sent another message)
      const status = SessionStatus.get(input.sessionID)
      if (status.type !== "idle") return

      // Use a small/fast model for suggestions (same approach as title generation)
      const model =
        (await Provider.getSmallModel(input.providerID)) ??
        (await Provider.getModel(input.providerID, input.modelID))
      const language = await Provider.getLanguage(model)

      // Build a minimal prompt asking for a suggestion
      const conversationSummary = msgs
        .slice(-6) // Last 3 exchanges
        .map((m) => {
          const textParts = m.parts
            .filter((p) => p.type === "text")
            .map((p) => ("text" in p ? (p as { text: string }).text : ""))
            .join("\n")
          return `${m.info.role}: ${textParts.slice(0, 500)}`
        })
        .join("\n\n")

      // Skip if conversation summary is empty (e.g., all tool-only messages)
      if (!conversationSummary.trim()) return

      log.info("calling LLM for suggestion", { sessionID: input.sessionID, model: model.id })

      const { generateText } = await import("ai")
      const result = await generateText({
        model: language,
        maxOutputTokens: 100,
        system:
          "You are a coding assistant. Based on the conversation below, suggest ONE short follow-up prompt the user might want to send next. " +
          "Return ONLY the suggested prompt text, nothing else. No quotes, no explanation. Keep it under 80 characters. " +
          "Focus on natural next steps: fixing issues found, running tests, reviewing changes, etc.",
        messages: [
          {
            role: "user",
            content: `Recent conversation:\n\n${conversationSummary}\n\nSuggest a natural follow-up prompt:`,
          },
        ],
        abortSignal: AbortSignal.timeout(10000),
      })

      const suggestion = result.text.trim()
      if (!suggestion || suggestion.length > 120) return

      // Check again that session is still idle
      const currentStatus = SessionStatus.get(input.sessionID)
      if (currentStatus.type !== "idle") return

      log.info("generated", { sessionID: input.sessionID, suggestion })

      await Bus.publish(Event.Suggestion, {
        sessionID: input.sessionID,
        text: suggestion,
      })
    } catch (e) {
      // Suggestions are best-effort - don't fail loudly
      log.info("suggestion generation failed", { error: e instanceof Error ? e.message : String(e) })
    } finally {
      pending().delete(input.sessionID)
    }
  }
}
