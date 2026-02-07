import { test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

test("agent skills field parsed from JSON config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        my_agent: {
          description: "Agent with preloaded skills",
          skills: ["api-conventions", "error-handling"],
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      const agent = config.agent?.["my_agent"]
      expect(agent?.skills).toEqual(["api-conventions", "error-handling"])
    },
  })
})

test("agent skills field flows through to Agent.Info", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          skills: ["coding-standards"],
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(build?.skills).toEqual(["coding-standards"])
    },
  })
})

test("agent skills field parsed from markdown frontmatter", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const agentDir = path.join(dir, ".opencode", "agent")
      await fs.mkdir(agentDir, { recursive: true })
      await Bun.write(
        path.join(agentDir, "reviewer.md"),
        `---
skills:
  - api-conventions
  - testing-patterns
mode: subagent
description: A code reviewer agent with preloaded skills
---

You are a code reviewer. Follow the preloaded skill guidelines.
`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      const agent = config.agent?.["reviewer"]
      expect(agent).toBeDefined()
      expect(agent?.skills).toEqual(["api-conventions", "testing-patterns"])
      expect(agent?.mode).toBe("subagent")
    },
  })
})

test("agent without skills field has undefined skills", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        plain: {
          description: "Agent without skills",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plain = await Agent.get("plain")
      expect(plain).toBeDefined()
      expect(plain?.skills).toBeUndefined()
    },
  })
})

test("native agents have no skills by default", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      const explore = await Agent.get("explore")
      const general = await Agent.get("general")
      expect(build?.skills).toBeUndefined()
      expect(explore?.skills).toBeUndefined()
      expect(general?.skills).toBeUndefined()
    },
  })
})

test("Skill.preload returns matching skills", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skill1 = path.join(dir, ".opencode", "skill", "api-conventions")
      const skill2 = path.join(dir, ".opencode", "skill", "testing-patterns")
      await Bun.write(
        path.join(skill1, "SKILL.md"),
        `---
name: api-conventions
description: API conventions for the project.
---

# API Conventions

Always use RESTful endpoints with proper HTTP methods.
`,
      )
      await Bun.write(
        path.join(skill2, "SKILL.md"),
        `---
name: testing-patterns
description: Testing patterns for the project.
---

# Testing Patterns

Write unit tests for all public functions.
`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const loaded = await Skill.preload(["api-conventions", "testing-patterns"])
      expect(loaded.length).toBe(2)
      expect(loaded[0].name).toBe("api-conventions")
      expect(loaded[0].content).toContain("API Conventions")
      expect(loaded[1].name).toBe("testing-patterns")
      expect(loaded[1].content).toContain("Testing Patterns")
    },
  })
})

test("Skill.preload skips missing skills", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skill = path.join(dir, ".opencode", "skill", "existing-skill")
      await Bun.write(
        path.join(skill, "SKILL.md"),
        `---
name: existing-skill
description: An existing skill.
---

# Existing Skill Content
`,
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const loaded = await Skill.preload(["existing-skill", "nonexistent-skill"])
      expect(loaded.length).toBe(1)
      expect(loaded[0].name).toBe("existing-skill")
    },
  })
})

test("Skill.preload returns empty array for empty input", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const loaded = await Skill.preload([])
      expect(loaded).toEqual([])
    },
  })
})

test("skills field can be set on custom subagent via JSON config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        docs_writer: {
          mode: "subagent",
          description: "Documentation writer",
          skills: ["markdown-style", "api-docs"],
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("docs_writer")
      expect(agent).toBeDefined()
      expect(agent?.mode).toBe("subagent")
      expect(agent?.skills).toEqual(["markdown-style", "api-docs"])
    },
  })
})

test("skills from config override native agent defaults", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: {
          skills: ["codebase-navigation"],
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(explore?.skills).toEqual(["codebase-navigation"])
      // Other properties should still be intact
      expect(explore?.mode).toBe("subagent")
      expect(explore?.native).toBe(true)
    },
  })
})
