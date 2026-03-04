# Building Multi-Hop On-Behalf-Of (OBO) Auth for Autonomous AI Agents

When you build a single AI agent that calls an API, authentication is simple: you give it an API key. But after months of building multi-agent systems—where a primary "orchestrator" agent spawns a "researcher" sub-agent, which then triggers a "deployer" plugin—I realized that static API keys are a massive security liability in autonomous swarms.

When an agent deep in a delegation chain makes a destructive request, the downstream service has to answer two critical questions:

1. Which agent is making this request right now?
2. **On whose behalf** is this agent acting?

If you can't answer the second question, you have a privilege escalation nightmare. Any compromised sub-agent can execute commands as if it were the root user.

This guide details how we solved the multi-hop On-Behalf-Of (OBO) authentication problem in OpenCode using SPIFFE IDs, JWT Workload Headers, and a strict fail-closed trust model.

## Why API Keys Fail in Agent Swarms

The traditional way to authenticate a script is to inject a long-lived secret into its environment.

```bash
# Bad: Giving a sub-agent blanket access
$ OPENCODE_API_KEY=sk_live_12345 opencode run my-sub-agent
```

In a multi-agent swarm, this breaks down immediately:

- **No auditability:** The downstream service sees `sk_live_12345` and thinks the primary user made the request, masking the fact that it was actually a deeply nested, autonomous sub-agent.
- **Over-permissioning:** If a specialized "docs-reader" sub-agent shares the primary agent's token, a hallucination or prompt injection can cause it to delete production databases.
- **Dynamic Routing:** Agents generate their own execution graphs at runtime. You cannot predict exactly which plugins or downstream services an agent will decide to invoke, so you cannot pre-provision scoped static keys.

The rule of thumb: **If an agent is acting autonomously on behalf of a user, its identity must be cryptographically bound to that user's original intent.**

## The Solution: SPIFFE and JWT Workload Identities

To fix this, we implemented a multi-hop OBO architecture using [SPIFFE](https://spiffe.io/) (Secure Production Identity Framework for Everyone) and JWT Workload Headers.

Instead of API keys, every component in the OpenCode runtime gets a cryptographic identity formatted as a SPIFFE ID (e.g., `spiffe://opencode.local/workload/explore-agent`).

When Agent A calls Agent B, it doesn't pass a static secret. It mints a short-lived JWT-SVID (SPIFFE Verifiable Identity Document) that encodes the chain of custody.

### 1. The Workload Header

We pass this identity via a custom `x-opencode-workload` header:

```http
# The downstream service receives cryptographically verified context
GET /a2a/neo-sidecar/tasks HTTP/1.1
Host: api.opencode.local
x-opencode-directory: /Users/dev/project
x-opencode-workload: Bearer eyJhbGciOiJSUzI1NiIs...
```

The JWT payload looks like this:

```json
{
  "sub": "spiffe://opencode.local/workload/translator-agent",
  "aud": ["spiffe://opencode.local/plugin/a2a"],
  "iss": "opencode-runtime",
  "obo": "user_abc123",
  "exp": 1718290000
}
```

Now, the downstream service knows exactly _who_ the immediate caller is (`translator-agent`) and _who_ originally initiated the workflow (`user_abc123`).

### 2. The Fail-Closed Trust Model

The hardest part of multi-hop OBO is preventing a malicious agent from forging an "on-behalf-of" claim. If a rogue plugin can generate a JWT claiming to act on behalf of the admin, your architecture is compromised.

We built a strict, fail-closed trust pipeline in `verifyBearerForStrategy`:

```typescript
// Bad: Blindly trusting the workload header
function handleRequest(req) {
  const token = req.headers["x-opencode-workload"]
  const payload = verifyJWT(token) // Vulnerable to impersonation!
  executeTask(payload.obo)
}

// Good: Explicit allowlisting for OBO delegation
async function verifyWorkload(token) {
  const payload = await verifyBearerForStrategy(token, {
    audience: process.env.OPENCODE_WORKLOAD_JWT_AUDIENCE.split(","),
    issuer: process.env.OPENCODE_WORKLOAD_JWT_ISSUER,
  })

  const isTrusted = process.env.OPENCODE_A2A_TRUST_WORKLOAD_HEADER === "true"
  const allowedSubs = process.env.OPENCODE_WORKLOAD_JWT_ALLOWED_SUBS?.split(",")

  if (!isTrusted || !allowedSubs.includes(payload.sub)) {
    throw new Error("Workload not authorized for OBO delegation")
  }

  return payload
}
```

By default, OpenCode rejects all forwarded workload headers. An agent must be explicitly allowlisted in `OPENCODE_WORKLOAD_JWT_ALLOWED_SUBS` to be trusted to pass an OBO identity down the chain.

### 3. Defending Against Path Injection

Because autonomous agents dynamically construct the URLs and route identifiers they interact with, they are highly susceptible to injection attacks. An agent might try to manipulate a route parameter to escape its scope or spoof a SPIFFE ID.

Before a delegation token is ever minted or verified, the target route identifier must pass strict format validation.

```typescript
// Inside OpenCode's ID schema validation
const identifierSchema = z.string().superRefine((val, ctx) => {
  // Must match prefix_alphanumeric format
  if (!/^[a-zA-Z0-9]+_[a-zA-Z0-9_]+$/.test(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid format" })
  }
  // Must never contain control characters or path traversal bytes
  if (/[\x00-\x1F\x7F]/.test(val)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Control chars blocked" })
  }
})
```

This ensures that when the runtime constructs `spiffe://opencode.local/session/${session_id}`, the `session_id` is cryptographically safe and cannot contain embedded payloads designed to trick the JWT audience parser.

## Why This Architecture Matters

Delegating identity is notoriously difficult even in static, human-engineered microservice architectures. Doing it dynamically for autonomous AI agents that build their own execution graphs at runtime is bleeding-edge.

By abandoning static API keys in favor of SPIFFE-based multi-hop OBO tokens, you get:

1. **Perfect Auditability:** Every action in the swarm traces back to a specific sub-agent _and_ the original human initiator.
2. **Least Privilege:** Downstream tools can reject requests based on the specific sub-agent's identity, even if the primary user is an admin.
3. **Stateless Security:** No central session database is needed to track which agent is doing what; the cryptographic chain of custody travels with the request.

If you are building multi-agent swarms, stop passing API keys in environment variables. Treat your agents like zero-trust microservices.

---

_This guide is based on patterns we implemented in the OpenCode core runtime to secure Agent-to-Agent (A2A) communications. The techniques ensure that as AI swarms become more complex, their security boundaries remain mathematically provable._
