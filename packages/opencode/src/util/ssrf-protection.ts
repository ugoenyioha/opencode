/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Addresses G8 (Outbound Controls) from the security remediation plan.
 *
 * Key features:
 * - DNS resolution BEFORE making HTTP request (prevents DNS rebinding)
 * - Blocks private/internal IP ranges
 * - Only enforced when OPENCODE_HARDENED_MODE=true
 *
 * See: /tmp/audit-network-v2.md, /tmp/master-remediation-plan.md
 */

import { Flag } from "../flag/flag"
import dns from "dns/promises"

/**
 * Private/internal IP ranges that should be blocked in hardened mode.
 *
 * IPv4:
 * - 10.0.0.0/8 (Class A private)
 * - 172.16.0.0/12 (Class B private)
 * - 192.168.0.0/16 (Class C private)
 * - 127.0.0.0/8 (Loopback)
 * - 169.254.0.0/16 (Link-local / APIPA / Cloud metadata)
 * - 0.0.0.0/8 (Current network)
 *
 * IPv6:
 * - ::1 (Loopback)
 * - fe80::/10 (Link-local)
 * - fc00::/7 (Unique local addresses)
 * - :: (Unspecified)
 */

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false // Invalid IPv4, treat as potentially dangerous
  }

  const [a, b] = parts

  // 10.0.0.0/8
  if (a === 10) return true

  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true

  // 192.168.0.0/16
  if (a === 192 && b === 168) return true

  // 127.0.0.0/8 (loopback)
  if (a === 127) return true

  // 169.254.0.0/16 (link-local, cloud metadata endpoint)
  if (a === 169 && b === 254) return true

  // 0.0.0.0/8
  if (a === 0) return true

  return false
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()

  // Loopback ::1
  if (normalized === "::1") return true

  // Unspecified ::
  if (normalized === "::") return true

  // Link-local fe80::/10
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true
  }

  // Unique local fc00::/7 (fc00:: - fdff::)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true
  }

  // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x or ::ffff:hex:hex)
  if (normalized.startsWith("::ffff:")) {
    // Basic check for dotted decimal
    const ipv4Match = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (ipv4Match) {
      return isPrivateIPv4(ipv4Match[1])
    }
    // Block all other IPv4-mapped forms (e.g. hex ::ffff:7f00:1) to be safe
    return true
  }

  return false
}

function isPrivateIP(ip: string): boolean {
  // Check if it's IPv6
  if (ip.includes(":")) {
    return isPrivateIPv6(ip)
  }
  return isPrivateIPv4(ip)
}

export type SSRFValidationResult = { allowed: true; resolvedIP?: string } | { allowed: false; reason: string }

/**
 * Validate a URL for SSRF attacks.
 *
 * This function:
 * 1. Parses the URL to extract the hostname
 * 2. Resolves DNS to get all IP addresses
 * 3. Checks ALL resolved IPs against private ranges
 * 4. Blocks if ANY IP is private (prevents DNS rebinding)
 *
 * IMPORTANT: Only enforced when OPENCODE_HARDENED_MODE=true
 *
 * @param url The URL to validate
 * @returns Validation result indicating if the URL is allowed
 */
export async function validateURLForSSRF(url: string): Promise<SSRFValidationResult> {
  // Only enforce in hardened mode
  if (!Flag.OPENCODE_HARDENED_MODE) {
    return { allowed: true }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: "Invalid URL" }
  }

  const hostname = parsed.hostname

  // Check if hostname is already an IP address
  if (isPrivateIP(hostname)) {
    return {
      allowed: false,
      reason: `Blocked: ${hostname} is a private/internal IP address`,
    }
  }

  // Check for localhost variations
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return {
      allowed: false,
      reason: "Blocked: localhost is not allowed in hardened mode",
    }
  }

  // Resolve DNS and check ALL returned IPs
  try {
    // Resolve both IPv4 and IPv6 addresses
    const [ipv4Addresses, ipv6Addresses] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ])

    const allIPs = [...ipv4Addresses, ...ipv6Addresses]

    if (allIPs.length === 0) {
      // Could not resolve - might be using /etc/hosts or other local resolution
      // In hardened mode, we should be cautious
      return {
        allowed: false,
        reason: `Blocked: Could not resolve DNS for ${hostname}`,
      }
    }

    // Check ALL resolved IPs - if ANY is private, block the request
    // This prevents DNS rebinding attacks
    for (const ip of allIPs) {
      if (isPrivateIP(ip)) {
        return {
          allowed: false,
          reason: `Blocked: ${hostname} resolves to private IP ${ip}`,
        }
      }
    }

    // Return the first resolved IP for pinning
    return { allowed: true, resolvedIP: ipv4Addresses[0] || ipv6Addresses[0] }
  } catch (error) {
    // DNS resolution failed
    return {
      allowed: false,
      reason: `Blocked: DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Check if a URL points to a private/internal network.
 * Synchronous check based on hostname only (no DNS resolution).
 * Use validateURLForSSRF for full validation with DNS resolution.
 */
export function isInternalURL(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname

    if (isPrivateIP(hostname)) return true
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return true

    return false
  } catch {
    return false
  }
}
