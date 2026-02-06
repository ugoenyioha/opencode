import { describe, expect, test } from "bun:test"
import path from "path"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("InstructionPrompt rules: unconditional", () => {
  test("loads .opencode/rules/*.md without frontmatter as system instructions", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "rules", "style.md"), "Always use 2-space indentation.")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const instructions = await InstructionPrompt.system()
        const rule = instructions.find((s) => s.includes("style.md"))
        expect(rule).toBeDefined()
        expect(rule).toContain("Always use 2-space indentation.")
      },
    })
  })

  test("loads .claude/rules/*.md for compatibility", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".claude", "rules", "compat.md"), "Use TypeScript strict mode.")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const instructions = await InstructionPrompt.system()
        const rule = instructions.find((s) => s.includes("compat.md"))
        expect(rule).toBeDefined()
        expect(rule).toContain("Use TypeScript strict mode.")
      },
    })
  })

  test("strips YAML frontmatter from unconditional rules", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "rules", "testing.md"),
          `---
description: Testing guidelines
---

Always write tests for new features.`,
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const instructions = await InstructionPrompt.system()
        const rule = instructions.find((s) => s.includes("testing.md"))
        expect(rule).toBeDefined()
        expect(rule).toContain("Always write tests for new features.")
        expect(rule).not.toContain("description: Testing guidelines")
      },
    })
  })

  test("loads nested rules from subdirectories", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "rules", "general.md"), "General rule")
        await Bun.write(path.join(dir, ".opencode", "rules", "backend", "api.md"), "API rule")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const instructions = await InstructionPrompt.system()
        const general = instructions.find((s) => s.includes("general.md"))
        const api = instructions.find((s) => s.includes("api.md"))
        expect(general).toBeDefined()
        expect(api).toBeDefined()
      },
    })
  })

  test("skips empty rule files", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".opencode", "rules", "empty.md"), "")
        await Bun.write(path.join(dir, ".opencode", "rules", "whitespace.md"), "   \n\n  ")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const instructions = await InstructionPrompt.system()
        const empty = instructions.find((s) => s.includes("empty.md"))
        const whitespace = instructions.find((s) => s.includes("whitespace.md"))
        expect(empty).toBeUndefined()
        expect(whitespace).toBeUndefined()
      },
    })
  })
})

describe("InstructionPrompt rules: path-scoped", () => {
  test("rule with paths frontmatter is NOT in system instructions", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "rules", "ts-only.md"),
          `---
paths:
  - "src/**/*.ts"
---

Use strict TypeScript.`,
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const instructions = await InstructionPrompt.system()
        const rule = instructions.find((s) => s.includes("ts-only.md"))
        expect(rule).toBeUndefined()
      },
    })
  })

  test("path-scoped rule loads when reading a matching file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "rules", "ts-only.md"),
          `---
paths:
  - "src/**/*.ts"
---

Use strict TypeScript.`,
        )
        await Bun.write(path.join(dir, "src", "main.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const results = await InstructionPrompt.resolve([], path.join(tmp.path, "src", "main.ts"), "msg-1")
        const rule = results.find((r) => r.filepath.includes("ts-only.md"))
        expect(rule).toBeDefined()
        expect(rule!.content).toContain("Use strict TypeScript.")
        expect(rule!.content).not.toContain("paths:")
      },
    })
  })

  test("path-scoped rule does NOT load for non-matching file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "rules", "ts-only.md"),
          `---
paths:
  - "src/**/*.ts"
---

Use strict TypeScript.`,
        )
        await Bun.write(path.join(dir, "docs", "readme.md"), "# Docs")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const results = await InstructionPrompt.resolve([], path.join(tmp.path, "docs", "readme.md"), "msg-2")
        const rule = results.find((r) => r.filepath.includes("ts-only.md"))
        expect(rule).toBeUndefined()
      },
    })
  })

  test("path-scoped rule with multiple patterns matches any", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "rules", "frontend.md"),
          `---
paths:
  - "src/**/*.tsx"
  - "src/**/*.css"
---

Use CSS modules.`,
        )
        await Bun.write(path.join(dir, "src", "App.tsx"), "export default function App() {}")
        await Bun.write(path.join(dir, "src", "style.css"), "body {}")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tsx = await InstructionPrompt.resolve([], path.join(tmp.path, "src", "App.tsx"), "msg-3")
        expect(tsx.find((r) => r.filepath.includes("frontend.md"))).toBeDefined()

        const css = await InstructionPrompt.resolve([], path.join(tmp.path, "src", "style.css"), "msg-4")
        expect(css.find((r) => r.filepath.includes("frontend.md"))).toBeDefined()
      },
    })
  })

  test("path-scoped rule with single string path (not array)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "rules", "config-rule.md"),
          `---
paths: "*.json"
---

Use 2-space indent in JSON.`,
        )
        await Bun.write(path.join(dir, "package.json"), "{}")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const results = await InstructionPrompt.resolve([], path.join(tmp.path, "package.json"), "msg-5")
        expect(results.find((r) => r.filepath.includes("config-rule.md"))).toBeDefined()
      },
    })
  })

  test("path-scoped rule is only loaded once per message (claimed)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "rules", "ts-rule.md"),
          `---
paths:
  - "**/*.ts"
---

TypeScript rule.`,
        )
        await Bun.write(path.join(dir, "a.ts"), "const a = 1")
        await Bun.write(path.join(dir, "b.ts"), "const b = 2")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await InstructionPrompt.resolve([], path.join(tmp.path, "a.ts"), "msg-6")
        expect(first.find((r) => r.filepath.includes("ts-rule.md"))).toBeDefined()

        // Same messageID — should be claimed and not returned again
        const second = await InstructionPrompt.resolve([], path.join(tmp.path, "b.ts"), "msg-6")
        expect(second.find((r) => r.filepath.includes("ts-rule.md"))).toBeUndefined()

        // Different messageID — should load again
        const third = await InstructionPrompt.resolve([], path.join(tmp.path, "b.ts"), "msg-7")
        expect(third.find((r) => r.filepath.includes("ts-rule.md"))).toBeDefined()
      },
    })
  })
})
