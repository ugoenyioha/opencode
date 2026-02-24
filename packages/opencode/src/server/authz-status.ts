/**
 * A2A authorization status mapping policy.
 *
 * - 401: authentication failed or credentials missing/invalid.
 * - 403: authenticated caller is not authorized.
 * - 4xx/5xx: preserved when explicitly returned by authz providers.
 */
export function mapA2AAuthzStatus(statusCode: number | undefined, authenticated: boolean) {
  if (!authenticated) return 401
  if (statusCode === 401) return 403
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599) return statusCode
  return 403
}
