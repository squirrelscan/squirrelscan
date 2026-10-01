// Human-readable byte sizes for config values and environment variables.

const UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/**
 * Parse a positive byte size: a whole number of bytes (`2147483648`, `"2147483648"`)
 * or a number with a unit (`"2GB"`, `"512 MiB"`, `"1.5g"`). Units are binary
 * (1 GB = 1024³ bytes), which is how `du`, Finder's "on disk" figure and every
 * other size this CLI prints are counted.
 *
 * Returns null for anything else, including zero, negatives and fractions of a
 * byte, so callers decide whether a bad value is an error (config) or a warning
 * (an environment variable that must not break every command).
 */
export function parseByteSize(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  // Trimmed first and length-capped, so the pattern has no two adjacent
  // optional runs to backtrack between (CodeQL: polynomial regex on input).
  const trimmed = value.trim();
  if (trimmed.length > 64) return null;
  const match = /^(\d+(?:\.\d+)?)[ \t]*([a-z]*)$/i.exec(trimmed);
  if (!match) return null;
  const multiplier = UNITS[(match[2] || "b").toLowerCase()];
  if (multiplier === undefined) return null;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isFinite(bytes) || bytes < 1) return null;
  // A bare number must already be whole; a unit may scale a fraction to one.
  if (multiplier === 1 && !Number.isInteger(bytes)) return null;
  const whole = Math.floor(bytes);
  return Number.isSafeInteger(whole) ? whole : null;
}
