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
import type { RateLimitStore } from "./rate-limit/store"
import { MemoryRateLimitStore } from "./rate-limit/store"

export const INTERNAL_CLIENT_IP_HEADER = "x-opencode-client-ip"

const defaultStore = new MemoryRateLimitStore()

type RateLimitOptions = {
  store?: RateLimitStore | Promise<RateLimitStore>
  now?: () => number
}

/** Return the current 60-second window index (seconds-since-epoch / 60). */
function currentWindow(now: number) {
  return Math.floor(now / 60_000)
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

/** Seconds until the next window resets. */
function retryAfter(now: number): number {
  return 60 - (Math.floor(now / 1_000) % 60)
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
export function rateLimitMiddleware(
  getRpm: () => Promise<number>,
  trustProxy = false,
  options: RateLimitOptions = {},
): MiddlewareHandler {
  const clock = options.now ?? Date.now
  const storePromise = Promise.resolve(options.store ?? defaultStore)
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

    const now = clock()
    const win = currentWindow(now)
    const store = await storePromise

    if (await store.increment(key, win, rpm)) return next()

    const after = retryAfter(now)
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
  defaultStore.reset()
}
