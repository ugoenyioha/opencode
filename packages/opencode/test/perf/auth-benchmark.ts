import path from "path"
import { performance } from "perf_hooks"
import { createPublicKey, createSign, generateKeyPairSync } from "crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { mkdir } from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import {
  AUTH_PERF_CONCURRENCY_LEVELS,
  AUTH_PERF_DEFAULTS,
  AUTH_PERF_SCENARIOS,
  AUTH_PERF_THRESHOLDS,
  type AuthPerfScenarioID,
} from "./auth-benchmark-thresholds"

Log.init({ print: false })

type LatencyStats = {
  p50: number
  p95: number
  p99: number
}

type ScenarioMetrics = {
  scenario: AuthPerfScenarioID
  scenarioLabel: string
  concurrency: number
  requests_total: number
  duration_ms: number
  throughput_rps: number
  error_rate: number
  latency_ms: LatencyStats
  status_counts: Record<string, number>
}

type ThresholdCheck = {
  name: string
  pass: boolean
  detail: string
}

type ScenarioRuntime = {
  id: AuthPerfScenarioID
  label: string
  expectedStatus: number
  setup: () => Promise<void>
  headersForRequest: () => Record<string, string>
  teardown: () => Promise<void>
}

function encodeBase64url(input: string | Buffer) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function signRS256(payload: Record<string, unknown>, privateKey: string, kid: string) {
  const header = { alg: "RS256", typ: "JWT", kid }
  const encodedHeader = encodeBase64url(JSON.stringify(header))
  const encodedPayload = encodeBase64url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(privateKey)
  return `${signingInput}.${encodeBase64url(signature)}`
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key])
    process.env[key] = value
    Env.set(key, value)
  }
  try {
    await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
        Env.remove(key)
      } else {
        process.env[key] = value
        Env.set(key, value)
      }
    }
  }
}

async function readBody(req: IncomingMessage) {
  let body = ""
  for await (const chunk of req) {
    body += chunk.toString("utf8")
  }
  return body
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

async function runLoad(params: {
  durationMs: number
  concurrency: number
  expectedStatus: number
  send: () => Promise<number>
}) {
  const latencies: number[] = []
  const statusCounts = new Map<number, number>()
  let total = 0
  let errors = 0
  const startedAt = performance.now()
  const deadline = startedAt + params.durationMs

  async function worker() {
    while (performance.now() < deadline) {
      const requestStart = performance.now()
      const status = await params.send()
      const elapsed = performance.now() - requestStart
      latencies.push(elapsed)
      total += 1
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
      if (status !== params.expectedStatus) errors += 1
    }
  }

  await Promise.all(Array.from({ length: params.concurrency }, () => worker()))
  const endedAt = performance.now()
  const durationMs = Math.max(1, endedAt - startedAt)

  return {
    requests_total: total,
    duration_ms: durationMs,
    throughput_rps: total / (durationMs / 1000),
    error_rate: total === 0 ? 1 : errors / total,
    latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
    status_counts: Object.fromEntries(Array.from(statusCounts.entries()).map(([k, v]) => [String(k), v])),
  }
}

async function createSession(app: ReturnType<typeof Server.App>, directory: string) {
  const maybeApiKey = process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
  const response = await app.request("/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": directory,
      ...(maybeApiKey ? { "x-api-key": maybeApiKey } : {}),
    },
    body: "{}",
  })
  if (response.status !== 200) {
    throw new Error(`failed to create session: ${response.status}`)
  }
  const body = (await response.json()) as { id: string }
  return body.id
}

async function invokeTool(
  app: ReturnType<typeof Server.App>,
  directory: string,
  sessionID: string,
  headers: Record<string, string>,
) {
  const maybeApiKey = process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
  return app.request("/tool/missing_tool", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": directory,
      ...(maybeApiKey ? { "x-api-key": maybeApiKey } : {}),
      ...headers,
    },
    body: JSON.stringify({ sessionID, args: {} }),
  })
}

async function invokeToolStatus(
  app: ReturnType<typeof Server.App>,
  directory: string,
  sessionID: string,
  headers: Record<string, string>,
) {
  const response = await invokeTool(app, directory, sessionID, headers)
  return response.status
}

async function writeOpencodeConfig(dir: string, auth: "api-key" | "jwt" | "oidc" | "oauth2") {
  await Bun.write(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      server: {
        toolEndpoint: {
          enabled: true,
          auth,
          allowedTools: ["missing_tool"],
        },
      },
    }),
  )
}

function parseNumberEnv(name: string, fallback: number) {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

async function main() {
  const durationMs = parseNumberEnv("OPENCODE_AUTH_BENCH_DURATION_MS", AUTH_PERF_DEFAULTS.durationMs)
  const warmupMs = parseNumberEnv("OPENCODE_AUTH_BENCH_WARMUP_MS", AUTH_PERF_DEFAULTS.warmupMs)
  const c1RelativeDurationMs = parseNumberEnv("OPENCODE_AUTH_BENCH_C1_REL_DURATION_MS", 6_000)
  const enforce = process.env.OPENCODE_AUTH_BENCH_ENFORCE === "1"
  const previousGlobalToolKey = process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
  process.env.OPENCODE_TOOL_ENDPOINT_API_KEY = "perf-api-key"

  const outEqArg = Bun.argv.find((arg) => arg.startsWith("--out="))
  const outFlagIndex = Bun.argv.findIndex((arg) => arg === "--out")
  const outPath = outEqArg
    ? outEqArg.slice("--out=".length)
    : outFlagIndex >= 0 && Bun.argv[outFlagIndex + 1]
      ? Bun.argv[outFlagIndex + 1]
      : "test/perf/results/auth-benchmark.json"
  const markdownPath = outPath.endsWith(".json") ? outPath.replace(/\.json$/, ".md") : `${outPath}.md`

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  })
  const kid = "auth-bench-kid"
  const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Record<string, unknown>

  const jwksServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/.well-known/jwks.json") {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ keys: [{ ...jwk, use: "sig", alg: "RS256", kid }] }))
  })
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve))
  const jwksAddress = jwksServer.address()
  if (!jwksAddress || typeof jwksAddress === "string") throw new Error("failed to start jwks server")
  const jwksURL = `http://127.0.0.1:${jwksAddress.port}/.well-known/jwks.json`

  let oidcIssuer = ""
  const oidcServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ issuer: oidcIssuer, jwks_uri: jwksURL }))
      return
    }
    if (req.url === "/jwks") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ keys: [{ ...jwk, use: "sig", alg: "RS256", kid }] }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => oidcServer.listen(0, "127.0.0.1", resolve))
  const oidcAddress = oidcServer.address()
  if (!oidcAddress || typeof oidcAddress === "string") throw new Error("failed to start oidc server")
  const oidcURL = `http://127.0.0.1:${oidcAddress.port}`
  oidcIssuer = oidcURL

  const introspectionState = {
    mode: "active" as "active" | "outage",
    currentScenario: "oauth2_cold" as AuthPerfScenarioID,
  }
  const introspectionServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/introspect" || req.method !== "POST") {
      res.statusCode = 404
      res.end()
      return
    }
    if (introspectionState.mode === "outage") {
      res.statusCode = 500
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: "upstream_unavailable" }))
      return
    }

    const body = await readBody(req)
    const token = new URLSearchParams(body).get("token") ?? ""
    const exp = Math.floor(Date.now() / 1000) + (introspectionState.currentScenario === "oauth2_stale" ? 1 : 120)
    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify({
        active: true,
        iss: "https://issuer.oauth2.bench",
        aud: ["aud-oauth2-bench"],
        scope: "tool.invoke",
        exp,
        sub: token,
      }),
    )
  })
  await new Promise<void>((resolve) => introspectionServer.listen(0, "127.0.0.1", resolve))
  const introspectionAddress = introspectionServer.address()
  if (!introspectionAddress || typeof introspectionAddress === "string") {
    throw new Error("failed to start introspection server")
  }
  const introspectionURL = `http://127.0.0.1:${introspectionAddress.port}/introspect`

  const allMetrics: ScenarioMetrics[] = []
  try {
    for (const scenarioMeta of AUTH_PERF_SCENARIOS) {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const auth =
            scenarioMeta.id === "api_key"
              ? "api-key"
              : scenarioMeta.id === "jwt_jwks"
                ? "jwt"
                : scenarioMeta.id === "oidc"
                  ? "oidc"
                  : "oauth2"
          await writeOpencodeConfig(dir, auth)
        },
      })

      await Instance.disposeAll()

      const now = Math.floor(Date.now() / 1000)
      const tokenForJWT = signRS256(
        {
          exp: now + 600,
          iss: scenarioMeta.id === "oidc" ? oidcURL : "https://issuer.jwt.bench",
          aud: scenarioMeta.id === "oidc" ? "aud-oidc-bench" : "aud-jwt-bench",
        },
        privateKey,
        kid,
      )

      const runtime: ScenarioRuntime = {
        id: scenarioMeta.id,
        label: scenarioMeta.label,
        expectedStatus: 404,
        setup: async () => {},
        headersForRequest: () => {
          const headers: Record<string, string> = {}
          if (scenarioMeta.id === "api_key") {
            headers["x-api-key"] = "perf-api-key"
            return headers
          }
          if (scenarioMeta.id === "jwt_jwks") {
            headers.authorization = `Bearer ${tokenForJWT}`
            return headers
          }
          if (scenarioMeta.id === "oidc") {
            headers.authorization = `Bearer ${tokenForJWT}`
            return headers
          }
          if (scenarioMeta.id === "oauth2_cold") {
            headers.authorization = `Bearer cold-token-${crypto.randomUUID()}`
            return headers
          }
          if (scenarioMeta.id === "oauth2_warm") {
            headers.authorization = "Bearer warm-shared-token"
            return headers
          }
          headers.authorization = "Bearer stale-shared-token"
          return headers
        },
        teardown: async () => {},
      }

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const baseEnv: Record<string, string> = {
            OPENCODE_TOOL_ENDPOINT_API_KEY: "perf-api-key",
          }
          if (scenarioMeta.id === "jwt_jwks") {
            baseEnv.OPENCODE_COMPAT_JWT_JWKS_URL = jwksURL
            baseEnv.OPENCODE_COMPAT_JWT_ISSUER = "https://issuer.jwt.bench"
            baseEnv.OPENCODE_COMPAT_JWT_AUDIENCE = "aud-jwt-bench"
          } else if (scenarioMeta.id === "oidc") {
            baseEnv.OPENCODE_COMPAT_OIDC_ISSUER = oidcURL
            baseEnv.OPENCODE_COMPAT_OIDC_AUDIENCE = "aud-oidc-bench"
          } else {
            baseEnv.OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL = introspectionURL
            baseEnv.OPENCODE_COMPAT_OAUTH_CLIENT_ID = "perf-client"
            baseEnv.OPENCODE_COMPAT_OAUTH_CLIENT_SECRET = "perf-secret"
            baseEnv.OPENCODE_COMPAT_OAUTH_ISSUER = "https://issuer.oauth2.bench"
            baseEnv.OPENCODE_COMPAT_OAUTH_AUDIENCE = "aud-oauth2-bench"
            baseEnv.OPENCODE_COMPAT_OAUTH_REQUIRED_SCOPE = "tool.invoke"
            if (scenarioMeta.id === "oauth2_stale") {
              baseEnv.OPENCODE_COMPAT_OAUTH_INTROSPECTION_STALE_WHILE_ERROR_MS = "30000"
              baseEnv.OPENCODE_COMPAT_OAUTH_INTROSPECTION_STALE_MAX_ABS_AGE_MS = "30000"
            }
          }

          await withEnv(baseEnv, async () => {
            introspectionState.currentScenario = scenarioMeta.id
            introspectionState.mode = "active"

            const app = Server.App()
            const sessionID = await createSession(app, tmp.path)

            if (scenarioMeta.id === "oauth2_warm") {
              const prewarmStatus = await invokeToolStatus(app, tmp.path, sessionID, {
                authorization: "Bearer warm-shared-token",
              })
              if (prewarmStatus !== 404) {
                throw new Error(`prewarm failed for ${scenarioMeta.id}: status=${prewarmStatus}`)
              }
            }
            if (scenarioMeta.id === "oauth2_stale") {
              const staleWarmStatus = await invokeToolStatus(app, tmp.path, sessionID, {
                authorization: "Bearer stale-shared-token",
              })
              if (staleWarmStatus !== 404) {
                throw new Error(`stale prewarm failed: status=${staleWarmStatus}`)
              }
              await Bun.sleep(1_200)
              introspectionState.mode = "outage"
            }

            const preflight = await invokeTool(app, tmp.path, sessionID, runtime.headersForRequest())
            if (preflight.status !== runtime.expectedStatus) {
              throw new Error(
                `preflight failed for ${runtime.id}: status=${preflight.status} body=${await preflight.text()}`,
              )
            }

            for (const concurrency of AUTH_PERF_CONCURRENCY_LEVELS) {
              const measuredDurationMs =
                concurrency === 1 && (runtime.id === "oauth2_warm" || runtime.id === "oauth2_stale")
                  ? Math.max(durationMs, c1RelativeDurationMs)
                  : durationMs

              await runLoad({
                durationMs: warmupMs,
                concurrency,
                expectedStatus: runtime.expectedStatus,
                send: () => invokeToolStatus(app, tmp.path, sessionID, runtime.headersForRequest()),
              })

              const measured = await runLoad({
                durationMs: measuredDurationMs,
                concurrency,
                expectedStatus: runtime.expectedStatus,
                send: () => invokeToolStatus(app, tmp.path, sessionID, runtime.headersForRequest()),
              })

              allMetrics.push({
                scenario: runtime.id,
                scenarioLabel: runtime.label,
                concurrency,
                ...measured,
              })
            }
            await runtime.teardown()
          })
        },
      })
    }
  } finally {
    await new Promise<void>((resolve, reject) => jwksServer.close((error) => (error ? reject(error) : resolve())))
    await new Promise<void>((resolve, reject) => oidcServer.close((error) => (error ? reject(error) : resolve())))
    await new Promise<void>((resolve, reject) =>
      introspectionServer.close((error) => (error ? reject(error) : resolve())),
    )
    if (previousGlobalToolKey === undefined) {
      delete process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
    } else {
      process.env.OPENCODE_TOOL_ENDPOINT_API_KEY = previousGlobalToolKey
    }
  }

  const checks: ThresholdCheck[] = []

  const byScenarioAndConcurrency = new Map<string, ScenarioMetrics>()
  for (const metric of allMetrics) {
    byScenarioAndConcurrency.set(`${metric.scenario}:${metric.concurrency}`, metric)
  }

  for (const metric of allMetrics) {
    const maxErrorRate = AUTH_PERF_THRESHOLDS.errorRate[metric.scenario]
    checks.push({
      name: `error_rate_${metric.scenario}_c${metric.concurrency}`,
      pass: metric.error_rate <= maxErrorRate,
      detail: `actual=${metric.error_rate.toFixed(5)} max=${maxErrorRate.toFixed(5)}`,
    })

    if (metric.scenario === "jwt_jwks" || metric.scenario === "oidc" || metric.scenario === "oauth2_warm") {
      const baseline = byScenarioAndConcurrency.get(`api_key:${metric.concurrency}`)
      if (baseline) {
        const cap = baseline.latency_ms.p95 * AUTH_PERF_THRESHOLDS.relativeP95VsApiKey[metric.scenario]
        checks.push({
          name: `p95_relative_${metric.scenario}_c${metric.concurrency}`,
          pass: metric.latency_ms.p95 <= cap,
          detail: `actual=${metric.latency_ms.p95.toFixed(3)} cap=${cap.toFixed(3)}`,
        })
      }
    }

    if (metric.scenario === "oauth2_stale") {
      const warm = byScenarioAndConcurrency.get(`oauth2_warm:${metric.concurrency}`)
      if (warm) {
        const cap = warm.latency_ms.p95 * AUTH_PERF_THRESHOLDS.relativeP95StaleVsWarm
        checks.push({
          name: `p95_relative_oauth2_stale_vs_warm_c${metric.concurrency}`,
          pass: metric.latency_ms.p95 <= cap,
          detail: `actual=${metric.latency_ms.p95.toFixed(3)} cap=${cap.toFixed(3)}`,
        })
      }
    }

    if (metric.scenario === "oauth2_cold") {
      checks.push({
        name: `oauth2_cold_abs_p95_c${metric.concurrency}`,
        pass: metric.latency_ms.p95 <= AUTH_PERF_THRESHOLDS.oauth2ColdAbsoluteMs.p95,
        detail: `actual=${metric.latency_ms.p95.toFixed(3)} cap=${AUTH_PERF_THRESHOLDS.oauth2ColdAbsoluteMs.p95}`,
      })
      checks.push({
        name: `oauth2_cold_abs_p99_c${metric.concurrency}`,
        pass: metric.latency_ms.p99 <= AUTH_PERF_THRESHOLDS.oauth2ColdAbsoluteMs.p99,
        detail: `actual=${metric.latency_ms.p99.toFixed(3)} cap=${AUTH_PERF_THRESHOLDS.oauth2ColdAbsoluteMs.p99}`,
      })
    }
  }

  const baseline32 = byScenarioAndConcurrency.get("api_key:32")
  if (!baseline32) {
    throw new Error("missing api_key baseline at concurrency 32")
  }
  for (const [scenario, floor] of Object.entries(AUTH_PERF_THRESHOLDS.throughputFloorAt32VsApiKey)) {
    const metric = byScenarioAndConcurrency.get(`${scenario}:32`)
    if (!metric) continue
    const minRps = baseline32.throughput_rps * floor
    checks.push({
      name: `throughput_floor_${scenario}_c32`,
      pass: metric.throughput_rps >= minRps,
      detail: `actual=${metric.throughput_rps.toFixed(3)} min=${minRps.toFixed(3)}`,
    })
  }

  const passed = checks.every((check) => check.pass)

  const payload = {
    generated_at: new Date().toISOString(),
    config: {
      warmup_ms: warmupMs,
      duration_ms: durationMs,
      c1_relative_duration_ms: c1RelativeDurationMs,
      concurrency_levels: [...AUTH_PERF_CONCURRENCY_LEVELS],
      enforce,
    },
    scenarios: AUTH_PERF_SCENARIOS,
    results: allMetrics,
    checks,
    pass: passed,
  }

  const markdown = [
    "# Auth Benchmark",
    "",
    `- Generated: ${payload.generated_at}`,
    `- Warmup: ${warmupMs} ms`,
    `- Measure: ${durationMs} ms`,
    `- C1 warm/stale measure override: ${c1RelativeDurationMs} ms`,
    `- Enforce mode: ${enforce ? "on" : "off"}`,
    "",
    "| Scenario | Concurrency | p50 (ms) | p95 (ms) | p99 (ms) | Throughput (rps) | Error rate |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...allMetrics.map(
      (metric) =>
        `| ${metric.scenarioLabel} | ${metric.concurrency} | ${metric.latency_ms.p50.toFixed(3)} | ${metric.latency_ms.p95.toFixed(3)} | ${metric.latency_ms.p99.toFixed(3)} | ${metric.throughput_rps.toFixed(2)} | ${(metric.error_rate * 100).toFixed(3)}% |`,
    ),
    "",
    "## Threshold Checks",
    "",
    ...checks.map((check) => `- [${check.pass ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`),
    "",
    `Overall: ${passed ? "PASS" : "FAIL"}`,
  ].join("\n")

  const outputDir = path.dirname(outPath)
  await mkdir(outputDir, { recursive: true })
  await Bun.write(outPath, `${JSON.stringify(payload, null, 2)}\n`)
  await Bun.write(markdownPath, `${markdown}\n`)

  process.stdout.write(`${markdown}\n`)
  if (enforce && !passed) process.exit(1)
}

await main()
