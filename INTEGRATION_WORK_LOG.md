# Integration Work Log

Working branch: `integration/from-tui-mcp-freeze`

Purpose: track active issues, what has been fixed, what is under investigation, and any decisions that would require user input.

## Active Goal

Finish the current phase with:

- all tests passing
- upstream parity improved for runtime/auth/provider internals
- only explicitly deferred items left

## Active Remaining Work

1. Upstream-alignment refactors
   - `1cb7df715` provider branded-ID refactor
   - `dd68b85f5` effectify `ProviderAuthService`
   - `0a281c739` effectify `AuthService`

2. Remaining bounded correctness fixes
   - `e718db624` context-length-exceeded handling
   - `18fb19da3` run --attach auth headers
   - `b94e110a4` sessions lost after git init
   - `4c4aed5a8` local workspace project ID / worktree correctness
   - any other tiny provider/runtime correctness slices that remain after refactors

3. Candidate hardening
   - `/btw` real behavior
   - reasoning-stream rendering duplication during live thinking output

4. Final validation
   - broad auth/compat/A2A/plugin suites
   - full `test/team`
   - full `tui-smoke`
   - focused `tui-live`
   - isolated production-backed Anthropic and Google round-trips

## Current Candidate Baseline

- active branch binary currently usable in real environment
- live `opencode` currently points at this branch build
- known deferred items remain out of scope for now

## Deferred Items (not active work)

- relay / remote-control feature set
- Mattermost-late / broader OpenAI-late feature pass
- account / multi-account workspace auth subsystem
- multi-instance DB locking investigation
- broad upstream app/frontend churn
- broad upstream session churn unless needed as a dependency

## Notes

- If a larger design choice arises, pause and ask the user before proceeding.
- For all new code changes, add or adjust tests as needed.
- Keep using isolated runtimes for automated real-provider validation.
