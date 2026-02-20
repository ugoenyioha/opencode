import type { Plugin } from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"

export const HttpAuthPlugin: Plugin = async () => ({
  "http.request": async (input, output) => {
    if (!input.path.startsWith("/tool/")) return
    const config = await Config.get()
    const endpoint = config.server?.toolEndpoint
    if (!endpoint?.enabled) return
    const auth = endpoint.auth ?? "api-key"
    if (auth !== "api-key") return
    const key = Flag.OPENCODE_TOOL_ENDPOINT_API_KEY
    if (!key) {
      output.response = {
        status: 503,
        body: JSON.stringify({ error: "Missing OPENCODE_TOOL_ENDPOINT_API_KEY" }),
        headers: {
          "content-type": "application/json",
        },
      }
      return
    }
    const header = input.headers["x-api-key"] ?? input.headers["X-API-Key"] ?? ""
    if (header === key) return
    output.response = {
      status: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
      headers: {
        "content-type": "application/json",
      },
    }
  },
})
