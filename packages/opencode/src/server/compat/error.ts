import type { CompatErrorKind } from "./types"

function status(kind: CompatErrorKind) {
  if (kind === "unauthorized") return 401
  if (kind === "unknown_model") return 404
  if (kind === "bad_request") return 400
  if (kind === "rate_limit") return 429
  if (kind === "upstream_timeout") return 504
  return 500
}

function openAIType(kind: CompatErrorKind) {
  if (kind === "unauthorized") return "authentication_error"
  if (kind === "rate_limit") return "rate_limit_error"
  if (kind === "upstream_timeout" || kind === "api_error") return "api_error"
  return "invalid_request_error"
}

function anthropicType(kind: CompatErrorKind) {
  if (kind === "unauthorized") return "authentication_error"
  if (kind === "unknown_model") return "not_found_error"
  if (kind === "rate_limit") return "rate_limit_error"
  if (kind === "upstream_timeout" || kind === "api_error") return "api_error"
  return "invalid_request_error"
}

export function openAIError(kind: CompatErrorKind, message: string) {
  const code =
    kind === "unauthorized"
      ? "invalid_api_key"
      : kind === "unknown_model"
        ? "model_not_found"
        : kind === "bad_request"
          ? "invalid_request"
          : kind === "rate_limit"
            ? "rate_limit_exceeded"
            : kind === "upstream_timeout"
              ? "upstream_timeout"
              : "api_error"
  return new Response(
    JSON.stringify({
      error: {
        type: openAIType(kind),
        message,
        code,
      },
    }),
    {
      status: status(kind),
      headers: {
        "content-type": "application/json",
      },
    },
  )
}

export function anthropicError(kind: CompatErrorKind, message: string) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: anthropicType(kind),
        message,
      },
    }),
    {
      status: status(kind),
      headers: {
        "content-type": "application/json",
      },
    },
  )
}
