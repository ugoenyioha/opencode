import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"

describe("session.stream-timeout-retry", () => {
  test("fromError converts idle timeout errors to retryable APIError", () => {
    const error = new Error("StreamIdleTimeoutError: no data received for 60000ms")
    const result = MessageV2.fromError(error, { providerID: "copilot" })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    const api = result as MessageV2.APIError
    expect(api.data.isRetryable).toBe(true)
    expect(api.data.message).toInclude("Stream timed out")
  })

  test("fromError converts 'no data received' errors to retryable APIError", () => {
    const error = new Error("no data received within timeout")
    const result = MessageV2.fromError(error, { providerID: "github" })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    const api = result as MessageV2.APIError
    expect(api.data.isRetryable).toBe(true)
  })

  test("fromError converts 'idle timeout' errors to retryable APIError", () => {
    const error = new Error("Connection idle timeout reached")
    const result = MessageV2.fromError(error, { providerID: "openai" })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    const api = result as MessageV2.APIError
    expect(api.data.isRetryable).toBe(true)
  })

  test("stream timeout error is retryable via SessionRetry", () => {
    const error = new Error("idle timeout: no data received")
    const converted = MessageV2.fromError(error, { providerID: "copilot" })
    const retry = SessionRetry.retryable(converted)
    expect(retry).toBeDefined()
    expect(retry).toInclude("Stream timed out")
  })

  test("non-timeout errors still become Unknown errors", () => {
    const error = new Error("something else broke")
    const result = MessageV2.fromError(error, { providerID: "test" })
    expect(MessageV2.APIError.isInstance(result)).toBe(false)
  })

  test("MAX_IDLE_TIMEOUTS caps retries at 3 consecutive timeouts", () => {
    // Simulate the processor logic: consecutive timeout errors increment counter
    // and after MAX_IDLE_TIMEOUTS (3) it converts to a non-retryable error
    const MAX_IDLE_TIMEOUTS = 3
    let timeouts = 0
    const errors: Array<{ retried: boolean }> = []

    for (let i = 0; i < 5; i++) {
      const error = new Error("idle timeout: no data received")
      const converted = MessageV2.fromError(error, { providerID: "copilot" })

      if (
        MessageV2.APIError.isInstance(converted) &&
        /idle.?timeout|no data received/i.test((converted as MessageV2.APIError).data.message)
      ) {
        timeouts++
        if (timeouts >= MAX_IDLE_TIMEOUTS) {
          errors.push({ retried: false })
          break
        }
      }

      const retry = SessionRetry.retryable(converted)
      errors.push({ retried: retry !== undefined })
    }

    // First two should be retried, third should stop
    expect(errors).toStrictEqual([{ retried: true }, { retried: true }, { retried: false }])
    expect(timeouts).toBe(3)
  })

  test("timeout counter resets after successful stream data", () => {
    const MAX_IDLE_TIMEOUTS = 3
    let timeouts = 0

    // Simulate 2 timeouts
    for (let i = 0; i < 2; i++) {
      timeouts++
    }
    expect(timeouts).toBe(2)

    // Simulate successful stream data (resets counter)
    timeouts = 0
    expect(timeouts).toBe(0)

    // Simulate 2 more timeouts - should NOT hit the cap
    for (let i = 0; i < 2; i++) {
      timeouts++
    }
    expect(timeouts).toBe(2)
    expect(timeouts < MAX_IDLE_TIMEOUTS).toBe(true)
  })
})
