---
title: Multi-hop OBO auth
description: Secure agent delegation without hardcoded API keys.
---

## Understand the problem

Agents often spawn sub-agents or invoke plugins to complete tasks. Downstream services must identify the original requester to enforce permissions and audit logs.

Hardcoding API keys for every possible path is impossible. This approach breaks down completely when agents generate their own tooling paths dynamically.

We need a secure mechanism to pass identity through multiple autonomous layers. The solution must handle unpredictable delegation chains without compromising security.

---

## Implement workload identities

We solve this in OpenCode using SPIFFE IDs and JWT Workload Headers. Every agent is assigned a cryptographic identity formatted as a SPIFFE ID.

This identity is embedded into a short-lived JWT. When an agent invokes a sub-agent, it passes this token in the header.

The downstream service extracts the SPIFFE ID to verify the immediate caller. It also inspects the on-behalf-of claims to identify the original initiator.

---

## Secure the trust model

We parse caller-supplied JWT audiences and issuers with extreme caution. The `OPENCODE_A2A_TRUST_WORKLOAD_HEADER` configuration enforces a strict fail-closed trust model.

If a workload attempts to pass a workload header, it must be explicitly authorized to do so. Unauthorized delegation attempts are immediately rejected by the runtime.

This fail-closed approach ensures compromised agents cannot arbitrarily impersonate others. Only trusted middleware or specific orchestrator agents can forward identities.

---

## Prevent injection attacks

Delegation paths are constructed dynamically, making them vulnerable to path injection. We regex-validate all route identifiers during the delegation process.

```ts
const isValidRoute = /^[a-zA-Z0-9_-]+$/.test(routeId)
if (!isValidRoute) throw new Error("Invalid route identifier")
```

This strict validation strips out malicious characters before they reach the token issuer. It prevents attackers from crafting deceptive SPIFFE IDs or escaping their granted scope.

---

## Appreciate the dynamic scale

Delegating identity is notoriously difficult even in static microservice architectures. Doing it for autonomous AI agents is entirely cutting-edge.

Agents build their own execution graphs and decide which tools to call at runtime. Securing these ephemeral chains enables true, safe autonomy for AI systems.
