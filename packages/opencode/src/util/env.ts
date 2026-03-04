export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const scrubbed: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue

    const upper = key.toUpperCase()

    // Scrub core OpenCode runtime credentials to prevent agent privilege escalation
    if (upper === "OPENCODE_API_KEY") continue
    if (upper === "OPENCODE_AUTH") continue
    if (upper === "OPENCODE_RELAY_PASSWORD") continue
    if (upper.startsWith("OPENCODE_WORKLOAD_JWT")) continue
    if (upper.startsWith("OPENCODE_COMPAT_OAUTH")) continue

    // NOTE: We intentionally do NOT scrub general developer keys (like GITHUB_TOKEN,
    // AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY) because OpenCode is a local-first CLI.
    // If a developer has these set in their shell, they expect standard tools
    // (git, aws-cli, npm) executed by the agent to work seamlessly.

    scrubbed[key] = value
  }

  return scrubbed
}
