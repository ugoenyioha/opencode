import { Hono } from "hono"
import { OpenAICompatRoutes } from "./openai"
import { AnthropicCompatRoutes } from "./anthropic"

export function CompatRoutes() {
  return new Hono().route("/", OpenAICompatRoutes()).route("/", AnthropicCompatRoutes())
}
