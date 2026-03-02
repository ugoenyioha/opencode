import { cmd } from "./cmd"
import { Log } from "../../util/log"
import { UI } from "../ui"
import { URL } from "url"
import { createRemoteClient, importRemoteKey } from "@opencode-ai/sdk/v2/remote"

export const RemoteAttachCommand = cmd({
  command: "remote-attach <url>",
  describe: "Attach a local TUI session to a remote OpenCode workspace via a Remote Control URL",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        demandOption: true,
        describe: "The Remote Control URL (e.g. https://viewer.opencode.dev/remote?relay=...)",
      }),
  handler: async (args) => {
    const log = Log.create({ service: "remote-attach" })
    UI.println(UI.Style.TEXT_INFO + "Connecting to Remote OpenCode Session..." + UI.Style.TEXT_NORMAL)

    try {
      // 1. Parse the URL and extract the connection parameters
      const parsedUrl = new URL(args.url)
      
      // Hash isn't normally passed to server, but it might be in the CLI argument string
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

      UI.println(UI.Style.TEXT_DIM + `Relay: ${relayUrl}` + UI.Style.TEXT_NORMAL)
      UI.println(UI.Style.TEXT_DIM + `Session: ${sessionId}` + UI.Style.TEXT_NORMAL)

      // 2. Exchange the anonymous request for a Viewer JWT
      const joinRes = await fetch(`${relayUrl}/api/session/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId })
      })

      if (!joinRes.ok) {
        throw new Error(`Failed to join session. Relay returned HTTP ${joinRes.status}`)
      }

      const { token } = await (joinRes.json() as Promise<{ token: string }>)

      // 3. Initialize the Remote SDK client
      const encryptionKey = await importRemoteKey(keyBase64)
      const sdk = createRemoteClient({
        relayUrl,
        sessionId,
        token,
        encryptionKey,
        fetch: globalThis.fetch
      })
      
      UI.println(UI.Style.TEXT_SUCCESS + "Successfully authenticated and established E2E bridge." + UI.Style.TEXT_NORMAL)
      UI.println(UI.Style.TEXT_INFO + "Waiting for state sync... (TUI integration pending)" + UI.Style.TEXT_NORMAL)

      // 4. Hook up the TUI
      // In a real implementation, we would now initialize the standard OpenCode Ink TUI 
      // and pipe the SSE events and `sdk.session.prompt()` calls over the SDK client,
      // exactly like how the local `opencode session` command works.
      
      // For now, we will just keep the connection alive
      await new Promise(() => {})
      
    } catch (e) {
      UI.error((e as Error).message)
      process.exit(1)
    }
  },
})
