# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

OpenCode is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### Execution Sandboxing

OpenCode provides an optional, tiered sandboxing system to isolate agents and tool execution:

- **bwrap**: Default on Linux. Uses unprivileged user namespaces.
- **darwin**: Default on macOS. Uses Apple Seatbelt (`sandbox-exec`).
- **gvisor**: Stronger kernel isolation for Linux.
- **firecracker**: MicroVM isolation for full multi-tenant environments.
- **wasm**: Zero-trust execution for WebAssembly tools.

By default, the agent runs with permissions configured in the UI. If you require strict system isolation, you **must** configure a sandbox tier via the CLI flag (e.g., `--sandbox bwrap`) or run OpenCode inside a Docker container.

### Worktree and Network Isolation

To restrict an agent's lateral movement and data exfiltration:

- **Agent Worktree Isolation:** Confines the agent to a specific git worktree directory.
- **HTTP Hook Network Isolation:** Egress traffic from tools can be blocked or routed through specific proxies.

### Agent-to-Agent (A2A) Security

For distributed agent workflows, OpenCode enforces security via:

- **SPIFFE Workload Identity:** A2A communication uses SPIFFE JWT-SVID for rigorous identity verification (`X-Opencode-Workload`).
- **Delegated Plugin Authz:** Authorization decisions for A2A endpoints can be delegated to external plugins with strict fail-closed timeouts.
- **Separated API Keys:** The `OPENCODE_A2A_API_KEY` is explicitly separate from external LLM tool keys.

### Server Mode

Server mode is opt-in only. When enabled, set `OPENCODE_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server - any functionality it provides is not a vulnerability.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                      |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

---

# Reporting Security Issues

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/anomalyco/opencode/security/advisories/new) tab.

The team will send a response indicating the next steps in handling your report. After the initial reply to your report, the security team will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

## Escalation

If you do not receive an acknowledgement of your report within 6 business days, you may send an email to security@anoma.ly
