---
title: Zero-trust sandboxing
description: Secure AI agents with defense-in-depth isolation mechanisms.
---

Giving an LLM a bash prompt is terrifying. Command injection and arbitrary code execution become massive risks when agents operate autonomously.

If an agent hallucinates a malicious command or gets compromised via prompt injection, the blast radius is catastrophic.

---

## Understand the risks

We needed a way to run agents safely. Agents are moving from toys to enterprise tools.

Zero-trust is the only way to deploy them into production without risking your infrastructure.

---

## Isolate the backend

We implemented tiered backend isolation to secure the execution environment across multiple platforms. This defense-in-depth approach ensures agents only access what they explicitly need.

### Sandbox with Bubblewrap

On Linux, we use `bwrap` to create unprivileged containers. We restrict namespaces and drop kernel capabilities.

Only essential directories are mounted read-only, while the agent's worktree is mounted read-write.

### Enforce with Seatbelt

For macOS hosts, we utilize Apple's `sandbox-exec` also known as Seatbelt. We compile strict Scheme profiles that deny network access by default.

File I/O is restricted entirely to the assigned workspace paths.

### Intercept with gVisor

For untrusted multitenant cloud environments, we run workloads inside gVisor. The `runsc` application kernel intercepts all system calls.

This protects the underlying host kernel from container escape vulnerabilities.

### Execute with WebAssembly

We execute untrusted plugins and parsing tasks using WebAssembly via Extism. Wasm provides a memory-safe sandbox that strictly controls imports and exports.

It executes at near-native speed without exposing the host environment.

---

## Secure the worktree

Even within a sandbox, an agent shouldn't wander around your filesystem. We built strict agent worktree isolation to keep them contained.

All file operations are jailed to the assigned project folder.

We enforce canonical path resolution to block directory traversal attacks like accessing `../../etc/shadow`.

---

## Prevent network abuse

Agents frequently need to fetch external data. This introduces significant Server-Side Request Forgery (SSRF) risks if left unchecked.

Our HTTP hook network isolation acts as a strict egress proxy. We block requests to internal subnets, loopback addresses, and cloud metadata endpoints like `169.254.169.254`.

Only explicitly allowlisted external domains are reachable by the agent.

---

## Deploy to enterprise

Agents are now interacting with real production systems. You cannot rely on an LLM to "behave" nicely.

Zero-trust architecture ensures that even when the agent goes off the rails, your systems remain completely secure.
