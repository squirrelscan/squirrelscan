/**
 * Validation utilities
 */

/**
 * Check if string matches UUID v4 format
 */
export function isUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str
  );
}

/**
 * Check if string is a short ID (8-char hex prefix)
 */
export function isShortId(str: string): boolean {
  return /^[0-9a-f]{8}$/i.test(str);
}
