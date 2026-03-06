/**
 * Input sanitization utilities for security hardening.
 *
 * Addresses:
 * - G7 (Input Sanitization): Strip invisible Unicode, sanitize file paths
 * - G4 (File Write Restrictions): Validate content for memory_save
 *
 * See: /tmp/audit-input-v2.md, /tmp/master-remediation-plan.md
 */

/**
 * Remove invisible Unicode characters that could be used for prompt injection.
 *
 * Strips:
 * - Zero-width characters (U+200B-U+200F, U+2028-U+202F, U+FEFF)
 * - Bidirectional override characters (U+202A-U+202E, U+2066-U+2069)
 * - Zero-width joiners and non-joiners (U+2060-U+206F)
 * - Unicode Tags (U+E0000-U+E007F)
 */
export function stripInvisibleUnicode(text: string): string {
  return (
    text
      // Zero-width characters and spaces
      .replace(/[\u2000-\u200F]/g, "")
      // Line/paragraph separators and narrow spaces
      .replace(/[\u2028-\u202F]/g, "")
      // Byte order mark
      .replace(/\uFEFF/g, "")
      // Soft hyphen, CGJ, ALM
      .replace(/[\u00AD\u034F\u061C]/g, "")
      // Variation selectors
      .replace(/[\uFE00-\uFE0F]/g, "")
      // Bidirectional override characters
      .replace(/[\u202A-\u202E]/g, "")
      .replace(/[\u2066-\u2069]/g, "")
      // Zero-width joiners, word joiners, invisible operators
      .replace(/[\u2060-\u206F]/g, "")
      // Unicode Tags (used for invisible watermarking)
      .replace(/[\u{E0000}-\u{E007F}]/gu, "")
  )
}

/**
 * Sanitize a file path to prevent path traversal and injection attacks.
 *
 * Strips:
 * - Newlines and carriage returns
 * - Null bytes
 * - Path traversal sequences (../ and ..\)
 * - Invisible Unicode characters
 */
export function sanitizeFilePath(filepath: string): string {
  return (
    stripInvisibleUnicode(filepath)
      // Remove null bytes
      .replace(/\0/g, "")
      // Remove newlines
      .replace(/[\r\n]/g, "")
      // Remove path traversal sequences
      .replace(/\.\.[/\\]/g, "")
      // Also remove standalone .. at start or end
      .replace(/^\.\.$/g, "")
  )
}

/**
 * Result of content validation for storage.
 */
export type SanitizationResult = { valid: true; sanitized: string } | { valid: false; reason: string }

/**
 * Validate and sanitize content for storage (e.g., memory_save).
 *
 * Rejects:
 * - Markdown code fences (```)
 * - HTML tags
 * - Invisible Unicode characters
 *
 * This prevents cross-session persistent infection via prompt injection.
 */
export function sanitizeForStorage(text: string): SanitizationResult {
  // Check for invisible Unicode BEFORE stripping
  const hasInvisibleUnicode =
    /[\u200B-\u200F\u2028-\u202F\uFEFF\u202A-\u202E\u2066-\u2069\u2060-\u206F]/.test(text) ||
    /[\u{E0000}-\u{E007F}]/u.test(text)

  if (hasInvisibleUnicode) {
    return {
      valid: false,
      reason: "Content contains invisible Unicode characters which could be used for prompt injection",
    }
  }

  // Check for markdown code fences (could inject instructions)
  if (/```/.test(text)) {
    return {
      valid: false,
      reason: "Content contains markdown code fences (```) which could be used for prompt injection",
    }
  }

  // Check for HTML tags (could inject instructions)
  if (/<[a-zA-Z][^>]*>/.test(text) || /<!--/.test(text)) {
    return {
      valid: false,
      reason: "Content contains HTML tags which could be used for prompt injection",
    }
  }

  // Check for YAML frontmatter delimiters (could inject metadata)
  if (/^---\s*$/m.test(text)) {
    return {
      valid: false,
      reason: "Content contains YAML frontmatter delimiters (---) which could be used for injection",
    }
  }

  // Strip newlines and collapse to single line for storage
  const sanitized = text.replace(/\r?\n/g, " ").trim()

  return { valid: true, sanitized }
}

/**
 * Check if text contains potentially dangerous content for prompt injection.
 * Does not modify the text, only validates.
 */
export function containsInjectionRisk(text: string): boolean {
  const result = sanitizeForStorage(text)
  return !result.valid
}
