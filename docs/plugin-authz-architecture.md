# Plugin-Authz Architecture

> **Status**: Implemented and deployed.
> **Scope**: A2A request authorization via the `a2a.authz` plugin hook in `@opencode-ai/plugin`.
> **Supersedes**: ext_authz gRPC adapter as the primary authorization path.

---

## Overview

Plugin-authz is the canonical authorization architecture for A2A requests in OpenCode. It replaces the Envoy-compatible ext_authz gRPC adapter as the primary authz path.

Authorization is implemented as a **plugin hook** (`a2a.authz`) that runs after authentication on every A2A request. This gives plugins direct, type-safe access to the caller's identity and request context without requiring a separate gRPC sidecar process.

```
Incoming A2A request
  │
  ▼
Authentication (authn)
  │  evaluates configured strategies: api-key, jwt, spiffe, oidc, oauth2
  │  first-match-wins; returns AuthnResult { strategy, principal }
  │
  │  401 Unauthorized if no strategy succeeds
  ▼
a2a.authz hook chain
  │  runtime iterates registered a2a.authz hooks
  │  each hook receives: agent, action, principal, workload_principal, plugin config
  │  hook must return explicit decision; no decision = deny (fail-closed)
  │
  │  403 Forbidden if any hook denies
  │  plugin.statusOnError if hook throws (default 403, fail-closed)
  ▼
Agent handler (task processing)
```

---

## Config Schema

### `server.a2a.authz`

```json
{
  "server": {
    "a2a": {
      "authz": {
        "provider": "plugin",
        "plugin": {
          "id": "runtime-authz",
          "statusOnError": 403,
          "policy": {
            "mode": "machine_only"
          }
        }
      }
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `"plugin"` \| `"ext_authz"` | No | Selects authz backend. Default: no authz. |
| `plugin.id` | string | Yes (if `provider: "plugin"`) | ID of the plugin that implements `a2a.authz`. Must match a loaded plugin's ID. |
| `plugin.statusOnError` | number (400-599) | No | Status returned when hook errors/timeouts occur. Default: `403` (Envoy-aligned). |
| `plugin.policy` | object | Yes (if `provider: "plugin"`) | Opaque policy object passed unchanged to the hook as `input.plugin.policy`. |

### Per-Agent Override

Agents can override server-level authz config:

```yaml
---
name: my-agent
mode: a2a
a2a:
  auth: ["spiffe", "oidc"]
  authz:
    provider: plugin
    plugin:
      id: runtime-authz
      policy:
        mode: user_and_workload
---
```

Per-agent authz config **fully replaces** server-level authz — it is not merged. If an agent sets `authz.plugin`, the server-level `authz` config is ignored for that agent.

---

## `a2a.authz` Hook Contract

Defined in `@opencode-ai/plugin` (packages/plugin/src/index.ts):

```typescript
export type A2AAuthzInput = {
  agent: string                          // A2A agent ID being accessed
  action: "invoke" | "view"              // "invoke" = task/message; "view" = discovery
  method: string                         // HTTP method
  path: string                           // Request path
  headers: Record<string, string>        // Sanitized headers (credentials redacted)
  strategy: AuthStrategy | "none"        // Authn strategy that succeeded
  principal: string                      // Authn identity (alias: user_principal)
  user_principal: string                 // Same as principal
  workload_principal?: string            // SPIFFE workload identity (if SPIRE configured)
  plugin: {
    id: string                           // From authz.plugin.id in config
    policy: Record<string, unknown>      // From authz.plugin.policy in config
  }
}

export type A2AAuthzDecision = {
  allow: boolean
  reason?: string         // Surfaced in error body on deny; audit log on allow
  status_code?: 401 | 403 // Deny status. Runtime maps unauthenticated -> 401, authz denial -> 403
}
```

### Decision Semantics

| `output.decision` | Effect |
|---|---|
| `undefined` (not set) | No decision produced. Runtime denies request (fail-closed). |
| `{ allow: true }` | Request is **allowed**. Hook chain stops. |
| `{ allow: false, reason?, status_code? }` | Request is **denied**. First denying hook wins. |

If the hook **throws** or **times out**, the runtime treats it as deny with `status_code: 403` (fail-closed).

### Actions

- `"invoke"` — caller is sending a message or managing tasks (protected endpoint)
- `"view"` — caller is accessing discovery (agent card or listing). Return `{ allow: false }` to hide the agent from discovery responses.

---

## Principal Normalization

Authn produces a `principal` identity string that is passed to the authz hook. Normalization by strategy:

| Strategy | `principal` value | Notes |
|----------|------------------|-------|
| `spiffe` | Full SPIFFE ID, e.g. `spiffe://trust.domain/ns/prod/sa/caller` | Real workload identity |
| `oidc` | JWT `sub` claim (required) | User identity for delegated tokens |
| `jwt` | JWT `sub` claim (required) | |
| `oauth2` | Introspection/JWT `sub` claim (required) | |
| `api-key` | `"api-key"` | Proves key possession only, no identity |

**Dual-identity (delegated auth):**

When both OIDC authn and SPIFFE workload identity are in use, the hook receives:
- `input.user_principal` — the OIDC token's `sub` claim (the human or service account)
- `input.workload_principal` — the SPIFFE ID from a verified workload JWT-SVID in `X-Opencode-Workload`
  (only when `OPENCODE_A2A_TRUST_WORKLOAD_HEADER=true` **and** an explicit SPIFFE allowlist is configured)

This enables "user AND workload" authorization policies — e.g., only requests where the user has an
invoker relationship AND the workload has an invoker relationship are permitted.

### Trusted workload header mode (operational requirements)

When `OPENCODE_A2A_TRUST_WORKLOAD_HEADER=true`, runtime only accepts workload identity if all are true:

1. `X-Opencode-Workload` contains a valid SPIFFE JWT-SVID.
2. Token verifies for configured audience (`OPENCODE_SPIFFE_AUDIENCE` or per-agent override).
3. `allowedIds` is configured (per-agent `a2a.spiffe.allowedIds` or `OPENCODE_SPIFFE_ALLOWED_IDS`) and the SPIFFE ID matches.

If allowlist is missing, runtime ignores the header and leaves `workload_principal` unset (fail-closed).

Because identity comes from a header token, deployment must still enforce provenance at ingress/proxy boundaries
(strip/overwrite policy, trusted hops, and replay-resistant handling) for this mode.

---

## Status Code Behavior

The runtime applies this mapping after receiving an authz decision:

| Condition | HTTP Status |
|-----------|------------|
| Authn fails (no strategy succeeded) | 401 Unauthorized |
| Authz hook denies with `status_code: 401` | 401 Unauthorized |
| Authz hook denies with `status_code: 403` | 403 Forbidden |
| Authz hook denies with no `status_code` | 403 Forbidden (default) |
| Authz hook throws or times out | `plugin.statusOnError` (default: 403) |
| SpiceDB unreachable (inside hook) | hook throws → `plugin.statusOnError` (default: 403) |

---

## Fail-Closed Semantics

Plugin-authz is fail-closed by default:

- **Hook throws** → request denied (`plugin.statusOnError`, default 403)
- **Hook times out** → request denied (`plugin.statusOnError`, default 403)
- **Plugin not loaded / not registered** → startup validation fails; server refuses to start
- **SpiceDB connection error** → hook throws → request denied (`plugin.statusOnError`, default 403)

To implement fail-open behavior, the plugin author must explicitly catch errors inside the hook:

```typescript
"a2a.authz": async (input, output) => {
  try {
    const allowed = await spicedb.check(input.principal, input.agent)
    output.decision = { allow: allowed }
  } catch (err) {
    // Explicit fail-open: allow on SpiceDB error
    log.warn("SpiceDB check failed, failing open", { err })
    output.decision = { allow: true, reason: "authz unavailable" }
  }
}
```

---

## Startup Validation

At startup (when `server.toolEndpoint.enabled` is true), the runtime validates:

1. If `authz.provider = "plugin"` is set, `plugin.id` must be non-empty.
2. If `authz.provider = "plugin"` is set, `plugin.policy` must be a valid object.
3. The named plugin must be registered before the server starts (checked at A2A plugin init time).

Startup validation errors prevent the server from starting, surfacing misconfiguration early.

---

## Discovery Filtering

When authz is configured, discovery endpoints (`/.well-known/agents.json`, `/.well-known/agents/:id/card.json`)
filter agent visibility using the `view` action:

| Authz configured? | Credentials provided? | Result |
|--|--|--|
| No | N/A | All agents visible |
| Yes | No | Empty listing / 404 on all cards (fail-closed) |
| Yes | Yes, valid authn | Only agents where hook returns `allow: true` for `action: "view"` |
| Yes | Yes, invalid authn | Empty listing / 404 (authn fails) |

This prevents unauthorized callers from discovering agent capabilities.

---

## Example: SpiceDB Plugin Implementation

A minimal SpiceDB-backed authz plugin:

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import * as grpc from "@grpc/grpc-js"

export const SpiceDBAuthzPlugin: Plugin = async () => ({
  "a2a.authz": async (input, output) => {
    const { mode } = input.plugin.policy as { mode: "machine_only" | "user_only" | "user_and_workload" }

    const workload = normalizeSpiffeId(input.workload_principal ?? "")
    const user = input.user_principal

    if (mode === "machine_only") {
      const allowed = await checkSpiceDB("workload", workload, input.agent, "invoke")
      output.decision = { allow: allowed, reason: allowed ? undefined : "workload not authorized" }
      return
    }

    if (mode === "user_only") {
      const allowed = await checkSpiceDB("user", user, input.agent, "invoke")
      output.decision = { allow: allowed, reason: allowed ? undefined : "user not authorized" }
      return
    }

    // user_and_workload: both must be authorized
    const [workloadOk, userOk] = await Promise.all([
      checkSpiceDB("workload", workload, input.agent, "invoke"),
      checkSpiceDB("user", user, input.agent, "invoke"),
    ])
    output.decision = {
      allow: workloadOk && userOk,
      reason: !workloadOk ? "workload not authorized" : !userOk ? "user not authorized" : undefined,
    }
  },
})

function normalizeSpiffeId(spiffeId: string): string {
  // spiffe://trust.domain/path → spiffe/trust_domain/path
  return spiffeId.replace("spiffe://", "spiffe/").replace(/\./g, "_").replace("//", "/")
}
```

---

## Relationship to ext_authz

| Feature | plugin-authz | ext_authz (gRPC) |
|---------|-------------|-----------------|
| Deployment complexity | None — hook runs in-process | Requires separate adapter deployment |
| Protocol | TypeScript function call | Envoy gRPC `Authorization/Check` |
| Type safety | Full TypeScript types | Protobuf-serialized |
| Principal access | `A2AAuthzInput` struct | `CheckRequest.context_extensions` |
| Dual-identity | Native (`user_principal` + `workload_principal`) | Via `context_extensions` (manual) |
| Fail-closed | Yes (throws = deny) | Yes (`failOpen: false` default) |
| Performance | Sub-millisecond hook call | gRPC round-trip to adapter |
| Custom policy | `plugin.policy` object | `contextExtensions` key-value pairs |

**ext_authz is still supported** for deployments that need Envoy-compatible authz servers (OPA, Cedar, or
custom gRPC services). Set `authz.provider = "ext_authz"` instead of `"plugin"`. Both providers can be
configured simultaneously on different agents.

---

## Files

| File | Purpose |
|------|---------|
| `packages/plugin/src/index.ts` | `A2AAuthzInput`, `A2AAuthzDecision`, hook type definition |
| `packages/opencode/src/config/config.ts` | `AuthzConfig`, `PluginAuthzConfig` schema definitions |
| `packages/opencode/src/plugin/a2a.ts` | Hook invocation, principal propagation, fail-closed handling |
| `packages/opencode/src/server/auth-startup-validation.ts` | Startup validation for plugin authz config |
| `packages/opencode/src/server/authz-status.ts` | HTTP status code mapping for authz decisions |
| `packages/opencode/test/server/plugin-authz-startup.test.ts` | Startup validation tests |
| `packages/opencode/test/server/a2a-authz-context.test.ts` | Hook context propagation tests |
| `packages/opencode/test/server/authz-status.test.ts` | Status code mapping tests |
