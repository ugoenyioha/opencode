export function scrubEnv(
  env: Record<string, string | undefined>,
  envPassthrough: string[] = [],
): Record<string, string> {
  const passSet = new Set(envPassthrough.map((k) => k.toUpperCase()))
  const scrubbed: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue

    const upper = key.toUpperCase()

    // Allow explicitly passthroughed keys
    if (passSet.has(upper)) {
      scrubbed[key] = value
      continue
    }

    // Scrub core OpenCode runtime credentials
    if (upper === "OPENCODE_API_KEY") continue
    if (upper === "OPENCODE_AUTH") continue
    if (upper === "OPENCODE_RELAY_PASSWORD") continue
    if (upper.startsWith("OPENCODE_WORKLOAD_JWT")) continue
    if (upper.startsWith("OPENCODE_COMPAT_OAUTH")) continue

    // Scrub common provider API keys
    if (upper.includes("API_KEY") || upper.includes("SECRET_KEY")) continue
    if (upper === "GITHUB_TOKEN" || upper === "GITLAB_TOKEN" || upper === "NPM_TOKEN") continue

    // Scrub specific platform variables that shouldn't leak to untrusted sandboxes
    if (upper.includes("PASSWORD") || upper.includes("CREDENTIAL") || upper.includes("SECRET")) {
      // Don't block generic things like "SECRETS_DIR", but block specific auth variables
      // Actually it's safer to block broadly and let the shell-env plugin restore them if needed
      continue
    }

    scrubbed[key] = value
  }

  return scrubbed
}
