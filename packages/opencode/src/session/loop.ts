export namespace SessionLoop {
  export const MIN_INTERVAL_MS = 60_000
  export const MAX_CRON_PER_SESSION = 10

  type Client = {
    url: string
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  }

  export type Parsed =
    | { type: "stop" }
    | { type: "invalid"; message: string }
    | { type: "create"; minutes: number; interval_ms: number; prompt: string }

  export function parse(input: string): Parsed | undefined {
    const text = input.trim()
    if (!text.startsWith("/loop ")) return
    if (text === "/loop stop") return { type: "stop" }
    const match = text.match(/^\/loop\s+([^\s]+)\s+([\s\S]+)$/)
    if (!match) return { type: "invalid", message: "Usage: /loop <minutes> <prompt> or /loop stop" }
    const minutes = Number(match[1])
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { type: "invalid", message: "Minutes must be a positive number" }
    }
    const interval_ms = Math.round(minutes * 60 * 1000)
    if (interval_ms < MIN_INTERVAL_MS) {
      return { type: "invalid", message: "Minutes must be at least 1" }
    }
    const prompt = match[2].trim()
    if (!prompt) return { type: "invalid", message: "Prompt is required" }
    return {
      type: "create",
      minutes,
      interval_ms,
      prompt,
    }
  }

  export async function create(client: Client, sessionID: string, input: { interval_ms: number; prompt: string }) {
    const res = await client.fetch(`${client.url}/session/${sessionID}/loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false as const, error: body || `HTTP ${res.status}` }
    }
    return { ok: true as const, data: await res.json() }
  }

  export async function stop(client: Client, sessionID: string) {
    const res = await client.fetch(`${client.url}/session/${sessionID}/loop`, { method: "DELETE" })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false as const, error: body || `HTTP ${res.status}` }
    }
    return { ok: true as const, data: await res.json() }
  }
}
