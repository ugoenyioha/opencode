import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createRemoteClient, importRemoteKey } from "@opencode-ai/sdk/v2/remote"
import type { ServerConnection } from "@/context/server"

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.Any
}): OpencodeClient {
  if (server.type === "remote") {
    // The remote connection object now holds the pre-imported Web Crypto key
    return createRemoteClient({
      ...config,
      relayUrl: server.relayUrl,
      sessionId: server.sessionId,
      token: server.token,
      encryptionKey: server.encryptionKey,
    })
  }

  const auth = (() => {
    if (!server.http.password) return
    return {
      Authorization: `Basic ${btoa(`${server.http.username ?? "opencode"}:${server.http.password}`)}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: { ...config.headers, ...auth },
    baseUrl: server.http.url,
  })
}
