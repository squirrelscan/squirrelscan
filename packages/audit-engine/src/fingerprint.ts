// Smart-audits change/resolution fingerprint (#110/#195).
//
// A finding's fingerprint detects whether its mutable parts changed between
// audits. It is a CHANGE-DETECTOR, not a security primitive — so it does NOT
// need cryptographic strength, only: deterministic, sync, dependency-free, and
// IDENTICAL on the CLI (Node/Bun) and the API (Cloudflare Workers). node:crypto
// is unavailable on Workers and Web Crypto's digest is async (the merge hashes
// in a tight sync loop), so we use a portable FNV-1a hash here instead.
//
// CHANGING THIS ALGORITHM re-fingerprints every stored finding (they'll all read
// as "changed" once). Harmless for a change-detector, but the cross-impl parity
// test pins a golden value so it can't drift silently.

const FNV_PRIME = 1099511628211n;
const FNV_OFFSET = 14695981039346656037n;
const MASK64 = (1n << 64n) - 1n;

/** One 64-bit FNV-1a lane over `bytes`, seeded so lanes decorrelate. 16 hex. */
function fnv1a64(bytes: Uint8Array, seed: bigint): string {
  let h = (FNV_OFFSET ^ seed) & MASK64;
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i])) & MASK64;
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * 256-bit (64-hex) change fingerprint over the mutable parts of a finding.
 * JSON-encodes the tuple so the join is injective (a field containing a
 * separator can't collide with a different field boundary), then runs four
 * decorrelated FNV-1a lanes. A collision requires all four 64-bit lanes to
 * collide at once — negligible at any realistic per-site finding count.
 */
export function findingFingerprint(
  status: string,
  message: string,
  value: string | null,
  expected: string | null
): string {
  const input = JSON.stringify([status, message, value ?? "", expected ?? ""]);
  const bytes = new TextEncoder().encode(input);
  return (
    fnv1a64(bytes, 0n) +
    fnv1a64(bytes, 0x9e3779b97f4a7c15n) +
    fnv1a64(bytes, 0xff51afd7ed558ccdn) +
    fnv1a64(bytes, 0xc4ceb9fe1a85ec53n)
  );
}
