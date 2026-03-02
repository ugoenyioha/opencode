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
    // Because SDK instantiation is synchronous but Web Crypto requires an async key import,
    // we use a factory pattern to intercept calls lazily, or we expect the context to pre-initialize the key.
    // For now, we will throw a clear error. A robust implementation would either return a proxy 
    // or we can refactor the calling code to pass the pre-imported key.
    // Given the constraints, let's export a specific async factory for remote servers.
    throw new Error("createSdkForServer should not be used synchronously for 'remote' servers. Use createRemoteSdkForServer instead.")
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

export async function createRemoteSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createRemoteClient>[0]>, "baseUrl" | "relayUrl" | "sessionId" | "token" | "encryptionKey"> & {
  server: ServerConnection.Remote
}): Promise<OpencodeClient> {
  const encryptionKey = await importRemoteKey(server.encryptionKeyBase64)

  return createRemoteClient({
    ...config,
    relayUrl: server.relayUrl,
    sessionId: server.sessionId,
    token: server.token,
    encryptionKey,
  })
}
