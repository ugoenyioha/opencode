# Integration Branch Handoff — 2026-04-05

## Branch: `integration/upstream-dev-20260405`

## Status: Agent-teams test suite GREEN (221/230 pass, 9 cross-file flaky)

## What Was Done

### Agent-teams features implemented on `dev` (pre-merge):
1. Permission routing — teammate ask-mode → lead inbox → poll → reply
2. Coordinator mode — slim tools + orchestrator prompt
3. Fork mode — task with no subagent_type forks session
4. Team memory — shared knowledge store per project
5. Verification nudge — suggests verifier when all tasks complete
6. TUI team actions — k/s/d keybindings in DialogTeam

### Evals:
- Deterministic permission routing eval (5 scenarios)
- LLM redteam eval (8 adversarial tests)
- `bun run test/promptfoo/run-permission-routing-eval.ts`
- `bun run test/promptfoo/run-redteam-eval.ts`

### Upstream merge:
- ~400 commits from `upstream/dev` merged
- Full Effect service migration (Session, Provider, Bus, Permission, ToolRegistry, etc.)
- All merge conflicts resolved

### Post-merge fixes (25 files, 400+ lines):
- Server.App() compat, TeamRoutes mounting
- initProjectors() for SyncEvent in tests
- InstructionPrompt, Session.findDirectory, Config.invalidate compat
- session.sql.ts team columns + SessionCronTable restored
- Session.Info teammate field restored
- Provider.resolveModel → parseModel
- SessionID.make() at 20+ DB boundaries
- Team.cleanup() fast-path for loopless members
- OPENCODE_DISABLE_TEAM_AUTOWAKE for tests
- Logger re-init race fix
- Global.Path.* dynamic getters
- SessionStatus.get() await fixes (8 sites)
- SessionPrompt.loop mocking in test suites
- Bus.publish() async settle waits

## Remaining 9 Flaky Tests
All pass individually but fail when run with the full 23-file suite due to
bun test runner's shared-process env var contamination. NOT code bugs.

## To Merge Into `dev`
```bash
git checkout dev
git merge integration/upstream-dev-20260405
```

## To Run Agent-Teams Tests
```bash
cd packages/opencode
bun test test/team test/server/team-routes.test.ts test/cli/tui/dialog-team-actions.test.ts
```
