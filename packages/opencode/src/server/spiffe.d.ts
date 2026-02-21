declare module "spiffe" {
  export interface ValidateJWTSVIDResponse {
    spiffeId?: string
    claims?: Record<string, unknown>
  }

  export interface ValidateJWTSVIDRequest {
    audience: string
    svid: string
  }

  export interface SpiffeClient {
    validateJWTSVID(request: ValidateJWTSVIDRequest): Promise<ValidateJWTSVIDResponse>
    fetchJWTBundles(request: {}): AsyncIterable<any>
    fetchJWTSVID(request: { audience: string; spiffeId?: string }): Promise<any>
  }

  export function createClient(endpoint?: string): SpiffeClient
}
