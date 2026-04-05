/**
 * Permission routing correctness eval.
 *
 * Runs all 5 scenarios via the runner script and asserts expected outputs.
 * Equivalent to the promptfoo YAML eval but uses bun directly — no
 * promptfoo runtime required (avoids better-sqlite3 native binding issues).
 *
 * Usage: bun run test/promptfoo/run-permission-routing-eval.ts
 */

import { exec } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"

const execAsync = promisify(exec)
const cwd = path.join(import.meta.dir, "../..")

const RUNNER = "test/promptfoo/permission-routing-runner.ts"

const CASES = [
  {
    id: "PR-01",
    description: "Non-team session passthrough — no routing attempted",
    scenario: "non-team-passthrough",
    assert: (output: string) => output.includes("RESULT:passthrough:no-routing"),
  },
  {
    id: "PR-02",
    description: "Teammate routes permission_request to lead inbox",
    scenario: "teammate-routes-to-lead",
    assert: (output: string) => output.includes("RESULT:routed:tool=bash:rid=present"),
  },
  {
    id: "PR-03",
    description: "Lead allow=true resolves permission routing",
    scenario: "lead-allow",
    assert: (output: string) => output.includes("RESULT:resolved:allow=true"),
  },
  {
    id: "PR-04",
    description: "Lead allow=false resolves permission routing with denial",
    scenario: "lead-deny",
    assert: (output: string) => output.includes("RESULT:resolved:allow=false"),
  },
  {
    id: "PR-05",
    description: "Wrong request_id ignored, correct request_id resolves",
    scenario: "wrong-request-id-ignored",
    assert: (output: string) => output.includes("RESULT:correct-rid-resolved:allow=true"),
  },
]

async function runCase(scenario: string): Promise<string> {
  const { stdout, stderr } = await execAsync(
    `bun run ${RUNNER} ${scenario}`,
    { cwd, timeout: 20000 },
  ).catch((err: any) => ({
    stdout: err.stdout || "",
    stderr: err.stderr || String(err),
  }))
  return stdout + stderr
}

let passed = 0
let failed = 0

console.log("\nPermission Routing Eval\n" + "=".repeat(50))

// Run all cases (sequentially to avoid port conflicts)
for (const c of CASES) {
  const output = await runCase(c.scenario)
  const ok = c.assert(output)
  const icon = ok ? "✓" : "✗"
  console.log(`${icon} [${c.id}] ${c.description}`)
  if (!ok) {
    console.log(`  Expected pattern not found in output:`)
    console.log(`  ${output.trim().slice(0, 200)}`)
    failed++
  } else {
    passed++
  }
}

console.log("\n" + "=".repeat(50))
console.log(`${passed} passed, ${failed} failed`)

if (failed > 0) process.exit(1)
