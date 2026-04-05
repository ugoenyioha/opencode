export function online() {
  const nav = globalThis.navigator
  if (!nav || typeof nav.onLine !== "boolean") return true
  return nav.onLine
}

export function proxied() {
  return !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy)
}

/**
 * Checks if network requests are currently restricted by sandbox configuration.
 * Network is restricted if a sandbox mode is active AND network: false is set.
 */
export async function isNetworkRestricted(agentName?: string): Promise<boolean> {
  try {
    const { Sandbox } = await import("../sandbox")
    const config = await Sandbox.getEffectiveConfig(agentName)
    const mode = config.bash ?? "none"
    const available = Sandbox.available()
    if ((mode === "auto" ? available : mode) === "none") return false
    return config.network === false
  } catch {
    return false
  }
}
