declare module "spiffe" {
  /** @protobuf-ts message type for ValidateJWTSVIDRequest */
  export const ValidateJWTSVIDRequest: {
    create(values: { audience: string; svid: string }): { audience: string; svid: string }
    toBinary(message: { audience: string; svid: string }): Uint8Array
    fromBinary(data: Uint8Array): { audience: string; svid: string }
  }

  /** @protobuf-ts message type for ValidateJWTSVIDResponse */
  export const ValidateJWTSVIDResponse: {
    fromBinary(data: Uint8Array): {
      spiffeId?: string
      claims?: unknown
    }
    toBinary(message: unknown): Uint8Array
  }

  /** google.protobuf.Struct helpers from @protobuf-ts/runtime */
  export const Struct: {
    toJson(value: unknown): Record<string, unknown>
    fromJson(value: Record<string, unknown>): unknown
  }

  /** SpiffeWorkloadAPIClient (not used directly — kept for reference) */
  export interface SpiffeClient {
    validateJWTSVID(request: { audience: string; svid: string }): Promise<{
      spiffeId?: string
      claims?: Record<string, unknown>
    }>
    fetchJWTBundles(request: {}): AsyncIterable<unknown>
    fetchJWTSVID(request: { audience: string; spiffeId?: string }): Promise<unknown>
  }

  export function createClient(endpoint?: string): SpiffeClient
}
