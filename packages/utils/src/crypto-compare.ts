/**
 * Constant-time string compare.
 *
 * Folds length into the diff and iterates to `Math.max(a.length, b.length)`
 * so an attacker can't probe correct key length via timing before content.
 * Returns false iff lengths differ OR any byte differs.
 *
 * Used by internal API key auth, webhook signature verification, and any
 * other hot path that compares a user-supplied secret against a server
 * secret. Runtime-agnostic — works in Node, Bun, and Cloudflare Workers.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
