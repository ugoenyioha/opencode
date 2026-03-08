const fs = require('fs');
const file = 'docs/devto/part2_sandbox_architecture.md';
let content = fs.readFileSync(file, 'utf8');

const oldStr = `To close this gap, we built a pre-flight DNS resolver (Gate 8). It intercepts the URL, resolves the DNS, checks the resulting IPs against a strict denylist, and **pins the exact IP** for the actual fetch to prevent Time-of-Check to Time-of-Use (TOCTOU) DNS rebinding attacks:`;

const newStr = `To close this gap, we built a pre-flight DNS resolver (Gate 8). It intercepts the URL, resolves the DNS, checks the resulting IPs against a strict denylist, and **pins the exact IP** for the actual fetch to prevent Time-of-Check to Time-of-Use (TOCTOU) DNS rebinding attacks:

*(Note: We use an IP denylist rather than an allowlist because the \`webfetch\` tool must be able to browse the public internet for documentation. The denylist surgically blocks all private subnets—like \`10.x\`, \`127.x\`, and AWS metadata \`169.254.169.254\`—while leaving the public web open).*`;

if (content.includes(oldStr)) {
    content = content.replace(oldStr, newStr);
    fs.writeFileSync(file, content);
    console.log("Successfully patched SSRF Denylist explanation.");
} else {
    console.log("Error: oldStr not found.");
}
