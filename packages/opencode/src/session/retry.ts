import type { NamedError } from "@opencode-ai/util/error"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3
  export const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000

  const circuits = new Map<string, { failures: number; opened_until: number }>()

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return parsedMs
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return Math.ceil(parsedSeconds * 1000)
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed)
          }
        }

        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  export function cooldown(providerID: string) {
    const state = circuits.get(providerID)
    if (!state) return 0
    if (state.opened_until <= Date.now()) return 0
    return state.opened_until - Date.now()
  }

  export function success(providerID: string) {
    circuits.delete(providerID)
  }

  export function reset() {
    circuits.clear()
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>, providerID?: string) {
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    if (providerID) {
      const left = cooldown(providerID)
      if (left > 0) {
        return `Provider circuit open. Retry in ${Math.ceil(left / 1000)}s`
      }
    }
    let result: string | undefined
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      if (error.data.responseBody?.includes("FreeUsageLimitError"))
        return `Free usage exceeded, add credits https://opencode.ai/zen`
      result = error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    if (!result) {
      const json = iife(() => {
        try {
          if (typeof error.data?.message === "string") {
            const parsed = JSON.parse(error.data.message)
            return parsed
          }

          return JSON.parse(error.data.message)
        } catch {
          return undefined
        }
      })
      try {
        if (!json || typeof json !== "object") return undefined
        const code = typeof json.code === "string" ? json.code : ""

        if (json.type === "error" && json.error?.type === "too_many_requests") {
          result = "Too Many Requests"
        }
        if (!result && (code.includes("exhausted") || code.includes("unavailable"))) {
          result = "Provider is overloaded"
        }
        if (!result && json.type === "error" && json.error?.code?.includes("rate_limit")) {
          result = "Rate Limited"
        }
        if (!result) {
          result = JSON.stringify(json)
        }
      } catch {
        return undefined
      }
    }

    if (!providerID) return result
    const state = circuits.get(providerID) ?? { failures: 0, opened_until: 0 }
    const failures = state.failures + 1
    if (failures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      circuits.set(providerID, { failures: 0, opened_until: Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS })
      return `Provider circuit opened for ${Math.ceil(CIRCUIT_BREAKER_COOLDOWN_MS / 1000)}s after repeated failures`
    }
    circuits.set(providerID, { failures, opened_until: 0 })
    return result
  }
}
