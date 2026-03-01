import { Sandbox } from "../sandbox"

/**
 * Checks if network requests are currently restricted by sandbox configuration.
 *
 * Network is restricted if:
 * 1. A sandbox mode is active (not "none")
 * 2. And the sandbox configuration explicitly disables networking (`network: false`)
 */
export async function isNetworkRestricted(agentName?: string): Promise<boolean> {
  try {
    const config = await Sandbox.getEffectiveConfig(agentName)
    const mode = config.bash ?? "none"
    const available = Sandbox.available()

    if ((mode === "auto" ? available : mode) === "none") {
      return false
    }

    return config.network === false
  } catch {
    // Default fail-open for network if we can't read config
    return false
  }
}
