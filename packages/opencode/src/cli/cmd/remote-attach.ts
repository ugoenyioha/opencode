import { cmd } from "./cmd"
import { Log } from "../../util/log"
import { UI } from "../ui"
import { URL } from "url"
import { createRemoteFetch, importRemoteKey } from "@opencode-ai/sdk/v2/remote"
import { tui } from "./tui/app"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./tui/win32"
import { TuiConfig } from "../../config/tui"
import { Instance } from "../../project/instance"

export const RemoteAttachCommand = cmd({
  command: "remote-attach <url>",
  describe: "Attach a local TUI session to a remote OpenCode workspace via a Remote Control URL",
  builder: (yargs) =>
    yargs.positional("url", {
      type: "string",
      demandOption: true,
      describe: "The Remote Control URL (e.g. https://viewer.opencode.dev/remote?relay=...#key=...)",
    }),
  handler: async (args) => {
    const log = Log.create({ service: "remote-attach" })
    const unguard = win32InstallCtrlCGuard()

    try {
      win32DisableProcessedInput()

      UI.println(UI.Style.TEXT_INFO + "Connecting to Remote OpenCode Session..." + UI.Style.TEXT_NORMAL)

      // 1. Parse the URL and extract connection parameters
      const parsedUrl = new URL(args.url)

      const hashMatch = args.url.match(/#key=(.+)/)
      const keyBase64 = hashMatch ? hashMatch[1] : null

      if (!keyBase64) {
        throw new Error("Missing encryption key in URL hash (#key=...)")
      }

      const relayUrl = parsedUrl.searchParams.get("relay")
      const sessionId = parsedUrl.searchParams.get("session")

      if (!relayUrl || !sessionId) {
        throw new Error("URL is missing 'relay' or 'session' query parameters.")
      }

      log.info("connecting", { relay: relayUrl, session: sessionId })

      // 2. Exchange anonymous request for a Viewer JWT
      const joinRes = await fetch(`${relayUrl}/api/session/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })

      if (!joinRes.ok) {
        throw new Error(`Failed to join session. Relay returned HTTP ${joinRes.status}`)
      }

      const { token } = await (joinRes.json() as Promise<{ token: string }>)

      // 3. Create E2E encrypted remote fetch
      const encryptionKey = await importRemoteKey(keyBase64)
      const remoteFetch = createRemoteFetch({
        relayUrl,
        sessionId,
        token,
        encryptionKey,
        fetch: globalThis.fetch,
      })

      log.info("connected", { session: sessionId })

      // 4. Resolve local TUI config
      const config = await Instance.provide({
        directory: process.cwd(),
        fn: () => TuiConfig.get(),
      })

      // 5. Launch TUI with remote fetch — all API calls and SSE events
      //    are transparently proxied over the encrypted WebSocket tunnel
      await tui({
        url: "http://remote.opencode.internal",
        fetch: remoteFetch,
        config,
        args: {
          continue: true,
        },
      })
    } catch (e) {
      UI.error((e as Error).message)
      process.exit(1)
    } finally {
      unguard?.()
    }
  },
})
