Three days ago I posted about the 37 vulnerabilities Mindgard's AI Red Team found across 15 AI coding tools. The question I kept getting: what do you actually do about it?

I wrote up the answer.

The short version: permission dialogs don't work. OS-level sandboxing does. We built 9 security gates into OpenCode, tested them against real LLM jailbreaks, and published everything — the architecture, the test results, and the code.

Here is the architecture deep-dive:

Part 2A covers the OS layer — restrictiveness lattices, Bubblewrap, gVisor, Seatbelt, and why Docker was off the table:
https://dev.to/uenyioha/os-level-sandboxing-kernel-isolation-for-ai-agents-3fdg

Part 2B covers what happens inside the sandbox — input sanitization, SSRF defense with DNS-pinned IP denylists, phantom credential proxying, and WASM capability isolation:
https://dev.to/uenyioha/application-layer-defense-stopping-exfiltration-inside-the-sandbox-4l6c

(Part 3 is dropping later this week: how we wired Promptfoo into our CI pipeline to run automated multi-model jailbreaks against the sandbox on every PR.)

Full disclosure: OpenCode was on the affected list too. We're not pointing fingers — we're showing the fix.

#AISecurity #CyberSecurity #DevSecOps #AIAgents #LLM #Sandboxing #OpenSource
