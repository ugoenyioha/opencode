/**
 * HTTP rate-limiting middleware.
 *
 * Identity key priority (highest → lowest):
 *   1. x-api-key header  (API-key clients)
 *   2. First 16 hex chars of sha-256(Authorization header value)  (bearer/JWT clients)
 *   3. Client IP address  (unauthenticated / no auth header)
 *
 * A sliding-window counter is kept per identity key.  When the counter
 * exceeds `rate_limit_rpm` (default 600) within the current 60-second window
 * the handler immediately returns a deterministic 429 JSON response without
 * queuing or calling next().
 *
 * The window resets on the next full minute boundary (wall-clock aligned),
 * which keeps the implementation allocation-free after startup.
 */

import type { Context, MiddlewareHandler } from "hono"
import { createHash } from "crypto"

export const INTERNAL_CLIENT_IP_HEADER = "x-opencode-client-ip"

// One sliding-window bucket per identity key.
type Bucket = { count: number; window: number }

// Module-level store so the same in-memory state is shared across all requests
// within one server process.  Intentionally not exported – callers interact
// only through the middleware factory.
const store = new Map<string, Bucket>()

/** Return the current 60-second window index (seconds-since-epoch / 60). */
function currentWindow() {
  return Math.floor(Date.now() / 60_000)
}

/**
 * Derive the identity key from the request headers.
 *
 * Priority:
 *   x-api-key  >  sha256(Authorization)[0..16]  >  clientIP
 */
function identityKey(headers: Headers, clientIP: string): string {
  const apiKey = headers.get("x-api-key")
  if (apiKey) return `key:${apiKey}`

  const auth = headers.get("authorization")
  if (auth) {
    const hash = createHash("sha256").update(auth).digest("hex").slice(0, 16)
    return `auth:${hash}`
  }

  return `ip:${clientIP || "unknown"}`
}

/**
 * Increment the counter for `key` and return whether the request is allowed.
 * Returns false when the count has already reached (or exceeded) the limit.
 */
function allow(key: string, rpm: number): boolean {
  const win = currentWindow()
  const bucket = store.get(key)

  if (!bucket || bucket.window !== win) {
    store.set(key, { count: 1, window: win })
    return true
  }

  if (bucket.count >= rpm) return false

  bucket.count++
  return true
}

/** Seconds until the next window resets. */
function retryAfter(): number {
  return 60 - (Math.floor(Date.now() / 1_000) % 60)
}

/**
 * Build the rate-limit middleware.
 *
 * @param getRpm  Async thunk that returns the configured rpm limit.  Called on
 *                every request so hot config reloads are honoured without
 *                restarting the server.
 * @param trustProxy  When true, read client IP from x-forwarded-for / x-real-ip
 *                    / cf-connecting-ip before falling back to the socket address.
 */
export function rateLimitMiddleware(getRpm: () => Promise<number>, trustProxy = false): MiddlewareHandler {
  return async (c: Context, next) => {
    const rpm = await getRpm()
    // rpm <= 0 means "disabled" – skip enforcement
    if (rpm <= 0) return next()

    const headers = c.req.raw.headers

    const socketIP = headers.get(INTERNAL_CLIENT_IP_HEADER) || ""
    const ip = trustProxy
      ? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        headers.get("x-real-ip") ||
        headers.get("cf-connecting-ip") ||
        socketIP
      : socketIP

    const key = identityKey(headers, ip)

    if (allow(key, rpm)) return next()

    const after = retryAfter()
    c.header("Retry-After", String(after))
    c.header("X-RateLimit-Limit", String(rpm))
    c.header("X-RateLimit-Remaining", "0")
    return c.json(
      {
        error: "rate_limit_exceeded",
        message: `Rate limit of ${rpm} requests per minute exceeded. Retry after ${after}s.`,
        retry_after: after,
      },
      429,
    )
  }
}

/** Exported for tests only – resets the in-process store. */
export function _resetStore() {
  store.clear()
}
