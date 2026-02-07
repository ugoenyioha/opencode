import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill/skill"

// Helper to write a minimal SKILL.md into a dir
async function writeSkill(dir: string, name: string) {
  await Bun.write(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`,
  )
}

describe("skill disable flags", () => {
  const saved: Record<string, string | undefined> = {}
  const envKeys = [
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    "OPENCODE_TEST_HOME",
  ]

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  test("both .claude and .agents skills load by default", async () => {
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS
    delete process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(path.join(dir, ".claude", "skills", "claude-skill"), "claude-skill")
        await writeSkill(path.join(dir, ".agents", "skills", "agents-skill"), "agents-skill")
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const names = skills.map((s) => s.name)
        expect(names).toContain("claude-skill")
        expect(names).toContain("agents-skill")
      },
    })
  })

  test("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 blocks .claude but not .agents", async () => {
    // Note: We need to reload the flag module to pick up env changes.
    // Since Flag values are computed at import time for the chained ones,
    // we test via the skill.ts logic which reads the flags.
    // The fix decoupled EXTERNAL_SKILLS from CLAUDE_CODE_SKILLS, so we
    // test the skill scanning code directly.
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
    delete process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(path.join(dir, ".claude", "skills", "claude-skill"), "claude-skill")
        await writeSkill(path.join(dir, ".agents", "skills", "agents-skill"), "agents-skill")
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const names = skills.map((s) => s.name)
        // .claude skills blocked
        expect(names).not.toContain("claude-skill")
        // .agents skills still load
        expect(names).toContain("agents-skill")
      },
    })
  })

  test("OPENCODE_DISABLE_EXTERNAL_SKILLS=1 blocks .agents but not .claude", async () => {
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(path.join(dir, ".claude", "skills", "claude-skill"), "claude-skill")
        await writeSkill(path.join(dir, ".agents", "skills", "agents-skill"), "agents-skill")
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const names = skills.map((s) => s.name)
        // .claude skills still load
        expect(names).toContain("claude-skill")
        // .agents skills blocked
        expect(names).not.toContain("agents-skill")
      },
    })
  })

  test("both flags set blocks both directories", async () => {
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(path.join(dir, ".claude", "skills", "claude-skill"), "claude-skill")
        await writeSkill(path.join(dir, ".agents", "skills", "agents-skill"), "agents-skill")
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const names = skills.map((s) => s.name)
        expect(names).not.toContain("claude-skill")
        expect(names).not.toContain("agents-skill")
      },
    })
  })

  test(".opencode skills always load regardless of disable flags", async () => {
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(path.join(dir, ".opencode", "skill", "opencode-skill"), "opencode-skill")
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const names = skills.map((s) => s.name)
        // .opencode skills are never blocked by these flags
        expect(names).toContain("opencode-skill")
      },
    })
  })
})
