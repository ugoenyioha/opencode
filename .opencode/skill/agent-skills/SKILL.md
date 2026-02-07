---
name: agent-skills
description: Use this when configuring agents with preloaded skills. Covers the skills field in agent config (JSON and markdown frontmatter), how skills are injected into agent context, and how team/task subagents inherit preloaded skills.
---

## Use this when

- Adding a `skills` field to an agent definition (JSON config or markdown frontmatter)
- Debugging why an agent doesn't have expected skill content in its context
- Understanding how team teammates and task subagents receive preloaded skills

## How agent skill preloading works

Agents can declare a `skills` field listing skill names to preload into their context at startup. Unlike the `skill` tool (which loads skills on-demand), preloaded skills are injected into the system prompt on every LLM call for that agent.

### Configuration

**JSON config (`opencode.json`):**
```json
{
  "agent": {
    "my_agent": {
      "description": "Agent with preloaded skills",
      "skills": ["api-conventions", "error-handling"]
    }
  }
}
```

**Markdown frontmatter (`.opencode/agent/reviewer.md`):**
```markdown
---
skills:
  - api-conventions
  - testing-patterns
mode: subagent
description: Code reviewer with preloaded guidelines
---

You are a code reviewer. Follow the preloaded skill guidelines.
```

### Skill names

The `skills` array contains skill names (the `name` field from each skill's `SKILL.md` frontmatter). These must match exactly. Missing skills are skipped with a warning log.

### Injection point

Preloaded skills are injected into the system prompt array in `packages/opencode/src/session/prompt.ts`, between `InstructionPrompt.system()` and `Todo.systemContext()`. Each skill is wrapped in `<skill_content name="...">` XML tags.

### Subagent and team integration

- **Task tool** (`task.ts`): When a task subagent runs, the prompt loop resolves its agent config including `skills`. Preloaded skills are automatically injected via the system prompt.
- **Team spawn** (`team.ts`): When a teammate is spawned, the resolved agent's `skills` are preloaded via the same system prompt injection. The teammate's context message also mentions which skills are preloaded.
- Subagents do NOT inherit skills from the parent agent — skills must be listed explicitly on each agent.

### Key files

| File | Role |
|------|------|
| `src/agent/agent.ts` | `Agent.Info` schema with `skills` field, config-to-state wiring |
| `src/config/config.ts` | `Config.Agent` schema with `skills` field, `knownKeys` set |
| `src/skill/skill.ts` | `Skill.preload()` bulk-loads skills by name |
| `src/session/prompt.ts` | System prompt injection of preloaded skills |
| `src/tool/team.ts` | Skill context mention in teammate instructions |

### Quick checklist

- Skill names in `skills` array must match the `name` field in SKILL.md frontmatter
- Skills are injected as system prompt content, not as tool invocations
- Use `Skill.preload(names)` to bulk-load skills programmatically
- Missing skills are skipped (warn logged), not errors
