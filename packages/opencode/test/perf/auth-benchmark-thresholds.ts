export type AuthPerfScenarioID =
  | "api_key"
  | "jwt_jwks"
  | "oidc"
  | "oauth2_cold"
  | "oauth2_warm"
  | "oauth2_stale"

export const AUTH_PERF_CONCURRENCY_LEVELS = [1, 8, 32] as const

export const AUTH_PERF_DEFAULTS = {
  warmupMs: 2_000,
  durationMs: 10_000,
} as const

export const AUTH_PERF_SCENARIOS: Array<{ id: AuthPerfScenarioID; label: string }> = [
  { id: "api_key", label: "api-key" },
  { id: "jwt_jwks", label: "jwt+jwks" },
  { id: "oidc", label: "oidc" },
  { id: "oauth2_cold", label: "oauth2 introspection cold" },
  { id: "oauth2_warm", label: "oauth2 introspection warm" },
  { id: "oauth2_stale", label: "oauth2 introspection stale-on-error" },
]

export const AUTH_PERF_THRESHOLDS = {
  errorRate: {
    api_key: 0,
    jwt_jwks: 0,
    oidc: 0,
    oauth2_warm: 0,
    oauth2_stale: 0,
    oauth2_cold: 0.005,
  },
  relativeP95VsApiKey: {
    jwt_jwks: 4.0,
    oidc: 6.0,
    oauth2_warm: 8.0,
  },
  relativeP95StaleVsWarm: 2.5,
  oauth2ColdAbsoluteMs: {
    p95: 250,
    p99: 500,
  },
  throughputFloorAt32VsApiKey: {
    jwt_jwks: 0.4,
    oidc: 0.3,
    oauth2_warm: 0.25,
    oauth2_stale: 0.2,
    oauth2_cold: 0.05,
  },
} as const
