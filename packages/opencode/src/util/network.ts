import { Config } from "../config/config"
import { Sandbox } from "../sandbox"

/**
 * Checks if network requests are currently restricted by sandbox configuration.
 *
 * Network is restricted if:
 * 1. A sandbox mode is active (not "none")
 * 2. And the sandbox configuration explicitly disables networking (`network: false`)
 */
export async function isNetworkRestricted(): Promise<boolean> {
  try {
    const config = await Config.get()
    const mode = config.sandbox?.bash ?? "none"
    const available = Sandbox.available()

    const selectedMode = mode === "auto" ? available : mode

    if (selectedMode === "none") {
      return false
    }

    return config.sandbox?.network === false
  } catch {
    // Default fail-open for network if we can't read config
    return false
  }
}
