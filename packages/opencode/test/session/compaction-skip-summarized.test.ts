import { describe, test, expect } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"

/**
 * Tests for the compaction message selection logic (upstream #12479).
 *
 * When compaction runs a second time, it should skip messages that precede
 * a prior completed summary message. The summary already encapsulates
 * everything before it, so re-processing those messages wastes tokens.
 *
 * This test validates the message selection logic extracted from
 * SessionCompaction.process() in compaction.ts lines 167-180.
 */

type MinimalMsg = {
  info: {
    id: string
    role: "user" | "assistant"
    summary?: boolean
    finish?: string
  }
}

/** Replicate the compaction message selection logic from compaction.ts */
function selectCompactionMessages(messages: MinimalMsg[], boundaryMessageID?: string): MinimalMsg[] {
  let compactionMessages = boundaryMessageID
    ? messages.filter((m) => m.info.id < boundaryMessageID)
    : messages

  const lastSummaryIndex = compactionMessages.findLastIndex(
    (m) => m.info.role === "assistant" && m.info.summary && (m.info as any).finish,
  )
  if (lastSummaryIndex > 0) {
    compactionMessages = compactionMessages.slice(lastSummaryIndex)
  }

  return compactionMessages
}

describe("compaction skips already-summarized messages (#12479)", () => {
  test("first compaction includes all messages", () => {
    const messages: MinimalMsg[] = [
      { info: { id: "001", role: "user" } },
      { info: { id: "002", role: "assistant" } },
      { info: { id: "003", role: "user" } },
      { info: { id: "004", role: "assistant" } },
      { info: { id: "005", role: "user" } }, // compaction trigger
    ]

    const result = selectCompactionMessages(messages)
    // No prior summary — all messages should be included
    expect(result.length).toBe(5)
    expect(result[0].info.id).toBe("001")
  })

  test("second compaction skips messages before prior summary", () => {
    const messages: MinimalMsg[] = [
      // These are the messages that filterCompacted returns after first compaction:
      // The compaction trigger user message
      { info: { id: "005", role: "user" } },
      // The completed summary from first compaction
      { info: { id: "006", role: "assistant", summary: true, finish: "stop" } },
      // New messages after the summary
      { info: { id: "007", role: "user" } },
      { info: { id: "008", role: "assistant" } },
      { info: { id: "009", role: "user" } },
      { info: { id: "010", role: "assistant" } },
      { info: { id: "011", role: "user" } }, // second compaction trigger
    ]

    const result = selectCompactionMessages(messages)
    // Should skip the compaction trigger (005) and start from the summary (006)
    expect(result.length).toBe(6)
    expect(result[0].info.id).toBe("006") // starts at the summary
    expect(result[0].info.summary).toBe(true)
    expect(result[result.length - 1].info.id).toBe("011")
  })

  test("does not skip if summary is the first message", () => {
    const messages: MinimalMsg[] = [
      // Summary is at index 0 — nothing to skip
      { info: { id: "006", role: "assistant", summary: true, finish: "stop" } },
      { info: { id: "007", role: "user" } },
      { info: { id: "008", role: "assistant" } },
    ]

    const result = selectCompactionMessages(messages)
    // lastSummaryIndex is 0, condition is > 0, so no slicing
    expect(result.length).toBe(3)
    expect(result[0].info.id).toBe("006")
  })

  test("ignores incomplete summaries (no finish flag)", () => {
    const messages: MinimalMsg[] = [
      { info: { id: "001", role: "user" } },
      { info: { id: "002", role: "assistant" } },
      // A summary that errored out (no finish flag)
      { info: { id: "003", role: "assistant", summary: true } },
      { info: { id: "004", role: "user" } },
      { info: { id: "005", role: "assistant" } },
    ]

    const result = selectCompactionMessages(messages)
    // Incomplete summary should be ignored — all messages included
    expect(result.length).toBe(5)
    expect(result[0].info.id).toBe("001")
  })

  test("uses most recent summary when multiple exist", () => {
    const messages: MinimalMsg[] = [
      // First compaction trigger
      { info: { id: "001", role: "user" } },
      // First completed summary
      { info: { id: "002", role: "assistant", summary: true, finish: "stop" } },
      // Messages between first and second compaction
      { info: { id: "003", role: "user" } },
      { info: { id: "004", role: "assistant" } },
      // Second compaction trigger
      { info: { id: "005", role: "user" } },
      // Second completed summary
      { info: { id: "006", role: "assistant", summary: true, finish: "stop" } },
      // Messages after second summary
      { info: { id: "007", role: "user" } },
      { info: { id: "008", role: "assistant" } },
      // Third compaction trigger
      { info: { id: "009", role: "user" } },
    ]

    const result = selectCompactionMessages(messages)
    // Should start from the LAST completed summary (006)
    expect(result.length).toBe(4)
    expect(result[0].info.id).toBe("006")
    expect(result[0].info.summary).toBe(true)
  })

  test("works correctly with boundaryMessageID", () => {
    const messages: MinimalMsg[] = [
      { info: { id: "001", role: "user" } },
      { info: { id: "002", role: "assistant", summary: true, finish: "stop" } },
      { info: { id: "003", role: "user" } },
      { info: { id: "004", role: "assistant" } },
      { info: { id: "005", role: "user" } },
      { info: { id: "006", role: "assistant" } },
      { info: { id: "007", role: "user" } }, // boundary — preserve from here
    ]

    // boundary filter: only messages before "007"
    const result = selectCompactionMessages(messages, "007")
    // After boundary filter: 001-006
    // After summary skip: 002-006 (skip 001 which is before the summary)
    expect(result.length).toBe(5)
    expect(result[0].info.id).toBe("002")
    expect(result[0].info.summary).toBe(true)
  })

  test("no messages are lost — summary text carries prior context", () => {
    // The key invariant: when we skip pre-summary messages, the summary
    // message itself contains a text condensation of everything before it.
    // This test verifies the summary message IS included in the output.
    const messages: MinimalMsg[] = [
      { info: { id: "001", role: "user" } },
      { info: { id: "002", role: "assistant" } },
      { info: { id: "003", role: "user" } }, // compaction trigger
      { info: { id: "004", role: "assistant", summary: true, finish: "stop" } },
      { info: { id: "005", role: "user" } },
      { info: { id: "006", role: "assistant" } },
    ]

    const result = selectCompactionMessages(messages)
    // The summary (004) must be the first message — it carries context
    expect(result[0].info.id).toBe("004")
    expect(result[0].info.summary).toBe(true)
    // New messages after the summary are preserved
    expect(result.map((m) => m.info.id)).toEqual(["004", "005", "006"])
  })
})
