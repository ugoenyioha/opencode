const fs = require('fs');
const file = 'docs/devto/part2_sandbox_architecture.md';
let content = fs.readFileSync(file, 'utf8');

const oldStr = `1. **The WASM-Only Mandate:** Force all MCP servers to compile to WebAssembly and run them inside a WASI runtime (like Extism) with strict capability-based constraints.
   - _The Tension:_ While you _can_ compile Python or JavaScript to WASM (typically by bundling the entire interpreter into the \`.wasm\` binary), it creates massive file sizes, breaks C-extensions (like \`numpy\`), and lacks threading. It would break compatibility with 99% of existing servers.
2. **The "Bring Your Own Docker" Sidecar:** Run long-lived background Docker containers specifically for executing untrusted MCPs, passing stdio over the container boundary.
   - _The Tension:_ High security, but high developer friction. The sidecar doesn't share the host filesystem. If an MCP is designed to read your local Git state, the developer has to manually orchestrate complex volume mounts. (Note: Power users can do this in OpenCode _today_ by simply setting their MCP command to \`docker run -i --rm\`).
3. **The Restrictiveness Lattice Extension:** MCP servers declare their required capabilities in their manifest. The runtime routes their execution through our OS sandbox dispatcher (\`bwrap\`/\`Seatbelt\`), enforcing the global config lattice.
   - _The Tension:_ If a workspace MCP requests unsafe capabilities, it requires interrupting the developer with an interactive prompt: _"This workspace MCP requests Network access. Allow?"_`;

const newStr = `1. **The WASM-Only Mandate:** Force all MCP servers to compile to WebAssembly and run them inside a WASI runtime with strict capability-based constraints. 
   - *In the wild:* Projects like \`mcp.run\` are actively using **Extism** (the same WASM framework we use in OpenCode) to power WASM-based MCP servers. Tools like \`Wasmcp\` compile MCP servers into WebAssembly components.
   - *The Tension:* While you *can* compile Python or JavaScript to WASM (typically by bundling the entire CPython interpreter into the \`.wasm\` binary), it creates massive file sizes, breaks C-extensions (like \`numpy\`), and lacks threading. Mandating WASM would break compatibility with 99% of existing servers.
2. **The "Bring Your Own Docker" Sidecar:** Run long-lived background Docker containers specifically for executing untrusted MCPs, passing stdio over the container boundary.
   - *In the wild:* Docker recently released an "MCP Toolkit" advocating for exactly this. Dedicated CLI tools like \`mcpmanager.ai\` and the open-source \`sandbox-mcp\` exist solely to wrap MCP servers in Docker sidecars. 
   - *The Tension:* High security, but high developer friction. The sidecar doesn't share the host filesystem. If an MCP is designed to read your local Git state, the developer has to manually orchestrate complex volume mounts. *(Note: Power users can do this in OpenCode today by simply setting their MCP command to \`docker run -i --rm\`)*.
3. **The Restrictiveness Lattice Extension:** MCP servers declare their required capabilities in their manifest. The runtime routes their execution through an OS sandbox dispatcher (\`bwrap\`/\`Seatbelt\`), enforcing a global config lattice. 
   - *In the wild:* This is the path OpenCode is charting, and variations of it are seen in **Claude Code**, which uses a strict read-only permission model requiring explicit user approval for network or file modifications.
   - *The Tension:* If a workspace MCP requests unsafe capabilities, it requires interrupting the developer with an interactive prompt (e.g., *"This workspace MCP requests Network access. Allow?"*), which can lead to permission fatigue.`;

if (content.includes(oldStr)) {
    content = content.replace(oldStr, newStr);
    fs.writeFileSync(file, content);
    console.log("Successfully patched MCP examples.");
} else {
    console.log("Error: oldStr not found.");
}
