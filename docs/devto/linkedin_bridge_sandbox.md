# Your AI Coding Agent Has Root Access. Now What?

Three days ago I shared research from Mindgard's AI Red Team: 37 vulnerabilities across 15 major AI coding tools. Google Gemini CLI, OpenAI Codex, Amazon Kiro, Anthropic's Claude Code, Cursor — all affected. Every vulnerability led to remote code execution, data exfiltration, or sandbox bypass.

The response from the community was clear: _okay, so what do we actually do about it?_

This is that answer.

## The Problem in Plain English

When your developers use an AI coding agent, they're giving an LLM a shell on their machine. The LLM reads files, writes code, runs commands. That's the feature. The problem is that the LLM can be tricked.

A malicious repository. A compromised dependency. A cleverly named directory. Any of these can hijack the agent's context and turn it into an attacker's puppet — reading your `.env` files, exfiltrating API keys, or modifying configurations. The developer never sees it happen.

Permission dialogs don't fix this. We learned that lesson with browser pop-ups 15 years ago. Developers click "Allow" because the alternative is stopping work. At 2 AM during a production incident, nobody is carefully reading what the agent is asking to do.

## The Four Attack Categories Your Team Should Know

Mindgard's research distills into four categories. If your security team evaluates AI coding tools, these are the questions to ask vendors:

**1. Zero-Click Config Attacks** — Clone a repo, open it, code executes before you type anything. No prompt, no approval. The agent's configuration file triggers it automatically.

_Ask: Does the tool verify workspace configuration files before executing them?_

**2. Prompt Injection via Context** — An attacker plants invisible instructions in file names, README files, or directory structures. The agent reads them, follows them, and exfiltrates whatever it finds.

_Ask: Does the tool sanitize inputs for hidden Unicode and adversarial content before the LLM processes them?_

**3. Data Exfiltration** — Once the agent reads a secret, it needs a way out. Built-in web browsing features, DNS queries, or even markdown image rendering can be the exit channel.

_Ask: Does the tool enforce network isolation at the OS level, not just the application level?_

**4. Trust Persistence (TOCTOU)** — You approve a configuration on Monday. Someone pushes a malicious change on Tuesday. The tool still trusts it because the approval was bound to the file path, not the file content.

_Ask: Is trust based on content hashes or file paths?_

## What a Real Fix Looks Like

The answer isn't one thing. It's layers. After working through all 37 vulnerabilities, we identified 9 security gates — chokepoints where you can break entire categories of attacks at once. Here's what matters at the architecture level:

**OS-level sandboxing, not application-level filtering.** When the agent runs `curl attacker.com`, the network namespace shouldn't exist. Not blocked by a regex. Not caught by a filter. The network interface itself is removed. The command fails at the kernel.

**Defense in depth that assumes every layer fails.** The LLM will occasionally comply with a jailbreak. The input sanitizer will miss an edge case. The command parser will have a bug. Each layer must function independently. If the model follows a malicious instruction, the sandbox blocks the command. If the sandbox misses it, network isolation blocks the exfiltration. No single point of failure.

**Credential isolation.** API keys should never enter the agent's environment. A proxy pattern — where the agent gets a temporary session token and the real credential is injected outside the sandbox — means that even a fully compromised agent has nothing worth stealing.

**Content-addressed trust.** Every configuration file should be verified by its SHA-256 hash, not its file path. If the content changes, trust is automatically revoked. No silent upgrades, no TOCTOU window.

## What We Built

We implemented all 9 security gates in OpenCode and tested them with automated red-team evaluations — both deterministic tests (does the sandbox block `cat /etc/shadow`?) and LLM-in-the-loop jailbreak tests (can Claude be tricked into bypassing the sandbox through encoding tricks and roleplay?).

The deterministic tests: 10/10 blocked. The jailbreak tests: the model refused 8 out of 10 at the reasoning layer. For the 2 it complied with, the sandbox caught the payload. 20/20 total, zero secrets leaked.

Full disclosure: OpenCode was on Mindgard's affected list too. We're not claiming perfection — we're showing the work.

## The Technical Details

For the implementation-level details — Linux namespace configuration, macOS Seatbelt profiles, WASM capability models, the AST shell parser, SSRF defenses, Promptfoo red-team integration — I've published three deep-dive articles:

- **[Part 2A: OS-Level Sandboxing — Kernel Isolation for AI Agents](https://dev.to/uenyioha/os-level-sandboxing-kernel-isolation-for-ai-agents-3fdg)** — Restrictiveness lattices, Bubblewrap, gVisor, Seatbelt, and the MCP server gap
- **[Part 2B: Application-Layer Defense — Stopping Exfiltration Inside the Sandbox](https://dev.to/uenyioha/application-layer-defense-stopping-exfiltration-inside-the-sandbox-4l6c)** — Input sanitization, SSRF defense, phantom credential proxying, content-addressed trust, and WASM capability isolation
- **Part 3: Testing the Sandbox** — How we used multi-model red teams and Promptfoo to run automated jailbreak evaluations against real LLMs _(coming soon)_

These are dense, code-level documents written for the engineers on your team who will evaluate and implement these defenses.

The threat landscape article that started this series (Part 1) is here: [37 Vulnerabilities Exposed Across 15 AI IDEs](https://dev.to/uenyioha/37-vulnerabilities-exposed-across-15-ai-ides-the-threat-model-every-agent-builder-must-understand-3f5)

---

The AI coding tools your team uses today were not designed with adversarial inputs in mind. The vendors are catching up — but until sandboxing becomes table stakes, the risk sits with you.

#AISecurity #CyberSecurity #DevSecOps #AIAgents #LLM #Sandboxing #OpenSource
