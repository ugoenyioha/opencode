import { expect, test, describe } from "bun:test"
import { ConfigMarkdown } from "../../src/config/markdown"
import path from "path"
import os from "os"

describe("ConfigMarkdown: duplicate key deduplication", () => {
  test("should keep first occurrence of duplicate top-level keys", () => {
    const content = [
      "---",
      "name: first",
      "mode: subagent",
      "name: second",
      "---",
      "",
      "Body content",
    ].join("\n")

    const sanitized = ConfigMarkdown.fallbackSanitization(content)
    expect(sanitized).toContain("name: first")
    expect(sanitized).not.toContain("name: second")
  })

  test("should deduplicate multiple duplicate keys", () => {
    const content = [
      "---",
      "pwd: allow",
      "mode: subagent",
      "pwd: deny",
      "description: test",
      "mode: all",
      "---",
      "",
      "Body",
    ].join("\n")

    const sanitized = ConfigMarkdown.fallbackSanitization(content)
    expect(sanitized).toContain("pwd: allow")
    expect(sanitized).not.toContain("pwd: deny")
    expect(sanitized).toContain("mode: subagent")
    expect(sanitized).not.toContain("mode: all")
    expect(sanitized).toContain("description: test")
  })

  test("should preserve nested/indented duplicate keys", () => {
    const content = [
      "---",
      "tools:",
      "  write: true",
      "  read: true",
      "  write: false",
      "mode: subagent",
      "---",
      "",
      "Body",
    ].join("\n")

    const sanitized = ConfigMarkdown.fallbackSanitization(content)
    // indented lines are preserved as-is (they're nested keys)
    const indented = sanitized.match(/  write: (true|false)/g)
    expect(indented).toHaveLength(2)
  })

  test("should not affect content without duplicates", () => {
    const content = [
      "---",
      "name: test",
      "mode: subagent",
      "description: a description",
      "---",
      "",
      "Body content",
    ].join("\n")

    const sanitized = ConfigMarkdown.fallbackSanitization(content)
    expect(sanitized).toContain("name: test")
    expect(sanitized).toContain("mode: subagent")
    expect(sanitized).toContain("description: a description")
    expect(sanitized).toContain("Body content")
  })

  test("should return content unchanged when no frontmatter", () => {
    const content = "Just some text without frontmatter"
    const sanitized = ConfigMarkdown.fallbackSanitization(content)
    expect(sanitized).toBe(content)
  })
})

describe("ConfigMarkdown: parse with duplicate keys", () => {
  test("should parse file with duplicate keys keeping first value", async () => {
    const dir = path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2))
    const file = path.join(dir, "duplicate-keys.md")
    await Bun.write(
      file,
      [
        "---",
        "mode: subagent",
        "description: test agent",
        "mode: all",
        "---",
        "",
        "Agent instructions here",
      ].join("\n"),
    )

    const result = await ConfigMarkdown.parse(file)
    expect(result.data.mode).toBe("subagent")
    expect(result.data.description).toBe("test agent")
    expect(result.content).toContain("Agent instructions here")
  })

  test("should parse file with no duplicates normally", async () => {
    const dir = path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2))
    const file = path.join(dir, "normal.md")
    await Bun.write(
      file,
      [
        "---",
        "mode: subagent",
        "description: normal agent",
        "---",
        "",
        "Normal content",
      ].join("\n"),
    )

    const result = await ConfigMarkdown.parse(file)
    expect(result.data.mode).toBe("subagent")
    expect(result.data.description).toBe("normal agent")
    expect(result.content).toContain("Normal content")
  })
})
