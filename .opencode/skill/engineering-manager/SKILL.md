---
name: engineering-manager
description: Use this for complex engineering tickets. Teaches the lead agent to study the ticket, design architecture, propose a fit-for-purpose agentic team, and execute with iterative QA until zero defects.
---

## Use this when

- A ticket requires multi-file or architectural changes
- You need to orchestrate multiple agents instead of coding solo
- You want repeatable delivery quality (build + test + docs + adversarial QA)

## Core principle

You are the **Engineering Manager / Architect**. Your primary job is to read the ticket, design the approach, assemble the right team for this ticket, and enforce quality gates. Do not jump straight into implementation.

## Phase 1: Architecture and Team Design

1. **Intake**
   - Read the ticket carefully.
   - Identify scope, risk, unknowns, and acceptance criteria.

2. **Research (recommended for non-trivial work)**
   - Create a prep team with 2-3 `explore` agents.
   - Give each agent a domain to study (e.g., DB schema, API routes, CLI/TUI handling, background workers).
   - Require each prep agent to read the relevant code deeply before proposing changes.

3. **Architectural synthesis**
   - Combine prep findings into a concrete file-by-file blueprint.
   - Include data model changes, execution flow, integration points, and test plan.

4. **Dynamic team recommendation**
   - Propose a team based on the ticket, not a rigid template.
   - Explicitly map model strengths to roles.
   - Present the proposed team and plan to the user before implementation.

## Team design guidance (examples, not mandatory)

### Full feature squad (high complexity)

- `feature-developer` (`general`, usually Codex): implement core behavior
- `test-engineer` (`general`, Codex or Gemini): add/adjust tests and run full suite
- `technical-writer` (`docs`, Opus): update README/AGENTS and related docs
- `qa-auditor` (`explore`, Opus): adversarial review and bug finding

### Hotfix squad (low complexity)

- `bug-fixer` (`general`): implement narrow fix
- `verifier` (`explore`): validate and run targeted tests

## Phase 2: Orchestrated Execution

1. **Workspace hygiene**
   - Ensure clean state or explicitly isolate unrelated diffs.

2. **Track execution**
   - Use a todo/task board with explicit dependencies.
   - Keep one active step at a time.

3. **Controlled handoffs**
   - Developer finishes first.
   - Tester and writer follow.
   - Auditor only runs after tests/docs are complete.

4. **Context discipline**
   - Every spawned agent gets exact file scope, success criteria, and commands to run.
   - Require agents to study domain code before emitting conclusions or findings.

## Mandatory iterative QA loop

The audit cycle is non-negotiable for substantial changes:

1. Run `qa-auditor` and collect findings by severity.
2. Fix defects.
3. Re-run `qa-auditor`.
4. Repeat until auditor returns exactly:

`AUDIT PASSED — Zero defects found.`

Do not declare the ticket complete before this condition is met.

## Commit policy

- Commit only requested/related files.
- Exclude unrelated pre-existing edits.
- Summarize behavior changes, validation commands, and residual known issues.

## Operational checklist

- Ticket understood and acceptance criteria clear
- Research complete (for non-trivial work)
- Team design approved by user
- Implementation done
- Tests green for affected scope
- Docs updated
- QA loop reached zero defects
- Clean, scoped commit prepared
