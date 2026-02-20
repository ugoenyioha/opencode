export type CompatProvider = "openai" | "anthropic"

export type CompatErrorKind =
  | "unauthorized"
  | "unknown_model"
  | "bad_request"
  | "rate_limit"
  | "upstream_timeout"
  | "api_error"

export type CompatEventType = "message_start" | "delta" | "tool_call" | "message_stop" | "error"

export type CompatEvent = {
  type: CompatEventType
  data: Record<string, unknown>
}

export type CompatRequest = {
  provider: CompatProvider
  model: string
  resolvedModel: string
  stream: boolean
  maxOutputTokens?: number
  input: Array<{
    role: string
    content: string | Array<Record<string, unknown>>
  }>
  metadata?: Record<string, string>
}

export type CompatResponse = {
  id: string
  model: string
  output: Array<
    { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >
  usage: {
    inputTokens: number
    outputTokens: number
  }
  stopReason: "stop" | "max_tokens" | "tool_use" | "error"
}
