import { OpencodeClient } from "./gen/sdk.gen.js"
import { createClient } from "./gen/client/client.gen.js"
import { createRemoteClient as createRemoteClientV1, importRemoteKey } from "../remote.js"
import type { RemoteClientConfig } from "../remote.js"

export { importRemoteKey, type RemoteClientConfig }

export function createRemoteClient(config: RemoteClientConfig) {
  // We can reuse the same fetch-intercepting logic by calling the V1 factory
  // and extracting the patched fetch function it created.
  const v1Client = createRemoteClientV1(config) as any

  // Create a new V2 client using the exact same configuration (including the WebSocket-patched fetch)
  const client = createClient(v1Client._client.getConfig() as any)
  return new OpencodeClient({ client })
}
