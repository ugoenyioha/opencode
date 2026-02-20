# Auth Performance Benchmark

This benchmark measures auth decision performance at the HTTP boundary for protected tool routes.

## Scope

Scenarios:

- `api-key`
- `jwt+jwks` (RS256 + local JWKS)
- `oidc` (local discovery + local JWKS)
- `oauth2 introspection cold` (cache miss)
- `oauth2 introspection warm` (cache hit)
- `oauth2 introspection stale-on-error` (prewarmed allow + upstream outage)

Route under test:

- `POST /tool/missing_tool` with `server.toolEndpoint.auth` set per scenario.
- Expected status is `404` (auth passes, tool missing).

## Load Profile

- Warmup: `2000ms` (default)
- Measure: `10000ms` (default)
- Concurrency: `1`, `8`, `32`

Override duration/warmup for local quick checks:

- `OPENCODE_AUTH_BENCH_DURATION_MS`
- `OPENCODE_AUTH_BENCH_WARMUP_MS`
- `OPENCODE_AUTH_BENCH_C1_REL_DURATION_MS` (default `6000`): minimum measure window for `oauth2 warm/stale` at concurrency 1 to reduce local jitter in relative p95 gate.

## Commands

From `packages/opencode`:

- Local run: `bun run perf:auth`
- Strict gate: `bun run perf:auth:ci`
- Quick smoke: `OPENCODE_AUTH_BENCH_DURATION_MS=3000 bun run perf:auth`

## Artifacts

- JSON: `test/perf/results/auth-benchmark.json`
- Markdown: `test/perf/results/auth-benchmark.md`

Use `--out=<path>` to override JSON output path (Markdown mirrors the same base name).

## Notes

- The benchmark uses deterministic local loopback fixtures for JWKS, OIDC discovery, and OAuth2 introspection.
- Threshold checks include error-rate gates, relative latency gates, absolute latency caps for introspection cold path, and throughput floors at concurrency 32.
- In enforce mode (`OPENCODE_AUTH_BENCH_ENFORCE=1`), threshold failures return a non-zero exit code.
