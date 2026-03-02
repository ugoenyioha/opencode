import { OpencodeClient } from "./gen/sdk.gen.js"
import { createClient } from "./gen/client/client.gen.js"
import { createRemoteFetch, importRemoteKey } from "../remote.js"
import type { Config as ConfigV2 } from "./gen/client/types.gen.js"

export { importRemoteKey }

export type RemoteClientConfigV2 = ConfigV2 & {
  relayUrl: string
  sessionId: string
  token: string
  encryptionKey: CryptoKey
}

export function createRemoteClient(config: RemoteClientConfigV2) {
  // We pass the config safely cast to the underlying expected type to avoid strict TS interface mismatches
  // between the generated V1 and V2 HeyAPI configurations, while keeping the external API typed correctly.
  const client = createClient({ ...config, fetch: createRemoteFetch(config as any) })
  return new OpencodeClient({ client })
}
