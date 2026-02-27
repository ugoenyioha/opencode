import z from "zod"
import { NamedError } from "@opencode-ai/util/error"

export const ConcurrencyLimitError = NamedError.create(
  "ConcurrencyLimitError",
  z.object({
    scope: z.enum(["session", "llm_stream"]),
    limit: z.number(),
    message: z.string(),
  }),
)
