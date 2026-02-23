/**
 * A2A authorization status mapping policy.
 *
 * - 401: authentication failed or credentials missing/invalid.
 * - 403: authenticated caller is not authorized (including fail-closed paths).
 */
export function mapA2AAuthzStatus(statusCode: number | undefined, authenticated: boolean) {
  if (!authenticated) return 401
  if (statusCode === 401) return 403
  return 403
}
