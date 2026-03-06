import { Config } from "./config"

export async function hardenedMode(): Promise<boolean> {
  if (process.env.OPENCODE_HARDENED_MODE === "true") return true
  try {
    const config = await Config.get()
    return config?.hardened ?? false
  } catch {
    return false
  }
}
