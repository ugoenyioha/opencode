# Phase 2-5: Production Hardening Roadmap

This document outlines the remaining phases for turning OpenCode into a production-grade runtime environment. These phases build upon Phase 0 (Crash Safety) and Phase 1 (Sandboxing).

---

## Phase 2: Rate Limiting & Resource Budgets

**Goal**: Prevent resource exhaustion (OOM, excessive API costs) from semi-trusted callers or runaway agents.

| Item    | What                                                               | File(s)                                               | Effort  |
| ------- | ------------------------------------------------------------------ | ----------------------------------------------------- | ------- |
| **2.1** | HTTP rate limiting middleware (per-IP or per-API-key)              | `server/server.ts` — add Hono middleware              | Small   |
| **2.2** | Max concurrent sessions (configurable cap, 429 when full)          | `session/prompt.ts` — global semaphore                | Small   |
| **2.3** | Max team members (hard cap in spawn)                               | `tool/team.ts` — add constant check                   | Trivial |
| **2.4** | Max subagent depth (thread depth counter through task context)     | `tool/task.ts` — add depth param                      | Small   |
| **2.5** | LLM API concurrency semaphore (gate `streamText()`)                | `session/llm.ts` — configurable semaphore             | Medium  |
| **2.6** | Circuit breaker for LLM providers (N failures → cooldown)          | `session/retry.ts` — add state machine                | Medium  |
| **2.7** | Hard step limit per session (abort, not just soft prompt)          | `session/processor.ts` — enforce max                  | Small   |
| **2.8** | Pluggable rate-limit store for single or multi-process deployments | `server/rate-limit.ts` + `server/rate-limit/store.ts` | Medium  |

Saturation policy for all limits in this phase is **immediate reject** (no queueing).

**Config Additions** (`server.limits`):

```ts
limits: z.object({
  max_concurrent_sessions: z.number().optional(), // default: 200
  max_team_members: z.number().optional(), // default: 20
  max_subagent_depth: z.number().optional(), // default: 5
  max_llm_streams: z.number().optional(), // default: 100
  max_steps: z.number().optional(), // default: 100
  rate_limit_rpm: z.number().optional(), // default: 600
  rate_limit_backend: z
    .object({
      driver: z.enum(["sqlite", "memory"]), // default: "sqlite"
      sqlite: z
        .object({
          path: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
}).optional()
```

Implementation status: rate limiting already supports pluggable backends with `sqlite` as the default driver and `memory` as an in-process option. Enforcement remains immediate reject on limit breach.

---

## Phase 3: Auth Hardening

**Goal**: Close remaining gaps in the authentication and authorization model. The core auth system is already strong (SPIFFE, JWT, OIDC), but defaults need tightening.

| Item    | What                                                   | File(s)                                                   | Effort  |
| ------- | ------------------------------------------------------ | --------------------------------------------------------- | ------- |
| **3.1** | Require auth when binding non-localhost                | `server/server.ts` — startup check                        | Small   |
| **3.2** | Session ownership (user_id column, enforce per-client) | `session/session.sql.ts`, new migration, route middleware | Medium  |
| **3.3** | Strip sensitive headers on catch-all proxy             | `server/server.ts` — strip before fetch                   | Small   |
| **3.4** | Sanitize 500 error responses (no stack traces in prod) | `server/server.ts` — error handler                        | Trivial |
| **3.5** | Timing-safe fix for Anthropic compat auth              | `server/compat/auth.ts` — fix plain equality check        | Small   |

**Schema Change for 3.2**:

```sql
ALTER TABLE session ADD COLUMN owner_id TEXT;
CREATE INDEX session_owner_idx ON session(owner_id);
```

Auth middleware will extract `owner_id` from the authenticated identity (JWT `sub`, API key hash, SPIFFE ID) and filter all session queries by it.

---

## Phase 4: Observability

**Goal**: Make the runtime operable. You can't run a production system if you can't trace a request or monitor error rates.

| Item    | What                                                         | File(s)                                                                                              | Effort |
| ------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------ |
| **4.1** | Structured JSON logging                                      | `util/log.ts` — rewrite output format                                                                | Medium |
| **4.2** | Request correlation ID (HTTP ingress → LLM → Tool)           | `server/server.ts`, `session/prompt.ts`, `session/llm.ts`, `tool/tool.ts`                            | Medium |
| **4.3** | OTel spans for key operations (HTTP, LLM, tool exec)         | New `telemetry/` module, wire into server + session                                                  | Medium |
| **4.4** | Health check with dependency checks (DB, provider, MCP)      | `server/routes/global.ts` — expand health endpoint                                                   | Small  |
| **4.5** | Prometheus metrics endpoint (`/metrics`)                     | New `server/routes/metrics.ts` — request rate, error rate, LLM latency, token usage, active sessions | Medium |
| **4.6** | Tool execution audit log (structured log line per tool call) | `session/processor.ts` — emit after tool complete                                                    | Small  |

**Config Additions** (`observability`):

```ts
observability: z.object({
  log_format: z.enum(["text", "json"]).optional(), // default: "text"
  metrics_enabled: z.boolean().optional(), // default: false
  otel_enabled: z.boolean().optional(), // default: false
  otel_endpoint: z.string().url().optional(), // OTLP collector URL
  audit_log: z.boolean().optional(), // default: false
}).optional()
```

---

## Phase 5: Data Durability

**Goal**: Belt and suspenders for the SQLite data store.

| Item    | What                                                                     | File(s)                                                     | Effort  |
| ------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ------- |
| **5.1** | Use `Database.transaction()` for multi-step operations (fork, bulk copy) | `session/index.ts` — wrap fork/copy in transactions         | Medium  |
| **5.2** | Periodic WAL checkpoint (every N minutes)                                | `storage/db.ts` — setInterval for PASSIVE checkpoint        | Trivial |
| **5.3** | Database backup utility (`/admin/backup` endpoint or CLI command)        | New `server/routes/admin.ts` — `VACUUM INTO` for hot backup | Small   |
| **5.4** | Explicit connection close on shutdown                                    | _Completed in Phase 0_                                      | Done    |

---

## Full Roadmap Timeline

| Phase  | Theme                              | Depends On | Est. Effort | Priority      |
| ------ | ---------------------------------- | ---------- | ----------- | ------------- |
| **0**  | Lifecycle & Crash Safety           | —          | 1-2 days    | **Immediate** |
| **1A** | Container Isolation (configs/docs) | Phase 0    | 2-3 days    | **High**      |
| **1C** | WASM Tool Sandboxing               | Phase 0    | 3-5 days    | **High**      |
| **1B** | OS Namespace Sandboxing            | Phase 0    | 5-7 days    | **High**      |
| **2**  | Rate Limiting & Resource Budgets   | Phase 0    | 2-3 days    | **High**      |
| **3**  | Auth Hardening                     | Phase 0    | 2-3 days    | **Medium**    |
| **4**  | Observability                      | Phase 0    | 5-7 days    | **Medium**    |
| **5**  | Data Durability                    | Phase 0    | 2-3 days    | **Medium**    |

**Total: ~4-5 weeks** for the complete production hardening of the OpenCode fork.

_Note: Phases 1A, 1C, 2, and 3 can be parallelized as they touch different files and have no merge conflicts. Phase 1B should be serialized after 1A/1C since it touches the core bash tool spawn logic._
