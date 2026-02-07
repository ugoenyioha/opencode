import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill/skill"
import { Global } from "../../src/global"

async function writeSkill(dir: string, name: string) {
  await fs.mkdir(dir, { recursive: true })
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

describe("XDG skill directories", () => {
  const saved: Record<string, string | undefined> = {}
  const envKeys = [
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    "OPENCODE_TEST_HOME",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
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

  test("discovers skills from XDG data directory", async () => {
    await using tmp = await tmpdir({ git: true })

    process.env.OPENCODE_TEST_HOME = tmp.path
    // Disable external dirs to isolate XDG scan
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"

    // Write a skill into the XDG data skills directory
    const xdgSkillDir = path.join(Global.Path.data, "skills", "xdg-data-skill")
    await writeSkill(xdgSkillDir, "xdg-data-skill")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const names = skills.map((s) => s.name)
        expect(names).toContain("xdg-data-skill")
      },
    })
  })

  test("discovers skills from XDG config directory", async () => {
    await using tmp = await tmpdir({ git: true })

    process.env.OPENCODE_TEST_HOME = tmp.path
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"

    const xdgSkillDir = path.join(Global.Path.config, "skills", "xdg-config-skill")
    await writeSkill(xdgSkillDir, "xdg-config-skill")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const names = skills.map((s) => s.name)
        expect(names).toContain("xdg-config-skill")
      },
    })
  })

  test("XDG skills coexist with .agents/skills", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(path.join(dir, ".agents", "skills", "agent-skill"), "agent-skill")
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path
    delete process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS

    const xdgSkillDir = path.join(Global.Path.data, "skills", "xdg-data-skill")
    await writeSkill(xdgSkillDir, "xdg-data-skill")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const names = skills.map((s) => s.name)
        expect(names).toContain("xdg-data-skill")
        expect(names).toContain("agent-skill")
      },
    })
  })

  test("project-level skills override XDG skills with same name", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writeSkill(path.join(dir, ".opencode", "skill", "shared-skill"), "shared-skill")
      },
    })

    process.env.OPENCODE_TEST_HOME = tmp.path
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1"
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"

    const xdgSkillDir = path.join(Global.Path.data, "skills", "shared-skill")
    await writeSkill(xdgSkillDir, "shared-skill")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const matches = skills.filter((s) => s.name === "shared-skill")
        expect(matches.length).toBe(1)
        // The .opencode/skill version should win (loaded later, overwrites XDG)
        expect(matches[0].location).toContain(".opencode/skill/shared-skill")
      },
    })
  })
})
