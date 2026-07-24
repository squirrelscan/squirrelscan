// Source-fingerprint normalization for render-reuse (#839).
//
// Some origins emit per-request volatility inside the raw HTML on every fetch,
// so the source bytes rotate even when the real content is byte-identical. Two
// known classes, both confined to <script> blocks:
//   1. Cloudflare challenge-platform snippet (#836): a ~919-byte <script>
//      carrying a rotating ray id + timestamp in `window.__CF$cv$params`. We
//      strip the whole block.
//   2. Framework hydration timestamps (#991): SSR frameworks embed epoch-ms
//      state in inline hydration scripts (TanStack Start's `$_TSR` `u:<Date.now()>`
//      observed; every squirrelscan-built site is in this class). We can't strip
//      the block — CSR payloads carry real content — so we neutralize just the
//      13-digit epoch-ms tokens to a fixed placeholder.
// Both yield a stable hash across fetches while keeping the fingerprint
// sensitive to real payload changes.
//
// This normalizes for FINGERPRINTING ONLY. Never feed its output back into
// stored/served content — it deletes/rewrites markup.
//
// SHARED CONTRACT: the CLI (via the conditional-render fetcher) and the api
// server (#840, server-side hash) MUST run this exact function over the raw
// source before hashing, or client and server fingerprints will disagree and no
// render will ever be reused. Keep both callers on this one implementation.

// Any <script>…</script> block, split into three capture groups: opening tag,
// body, closing tag (case-insensitive, spans newlines, non-greedy so adjacent
// scripts don't merge, tolerant of whitespace before the closing tag). The groups
// let the epoch pass rewrite the BODY only, never the opening tag's attributes
// (e.g. a deploy-version cache-buster in `src="…?v=<epoch>"` must stay significant).
const SCRIPT_BLOCK = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;

// Anchors that identify a Cloudflare challenge-platform script: the inline
// snippet sets `window.__CF$cv$params`; both the inline and external forms
// reference `/cdn-cgi/challenge-platform/`.
const CF_CHALLENGE = /__CF\$cv\$params|\/cdn-cgi\/challenge-platform\//i;

// A standalone 13-digit integer: epoch-milliseconds (Sep 2001 – Nov 2286). The
// \b anchors deliberately exclude digits embedded in longer numbers, so 14+-digit
// ids stay fingerprint-significant. Applied ONLY to script BODIES — a 13-digit
// number in visible HTML is real content, and one in a script's opening tag is a
// deploy-version cache-buster; both must stay fingerprint-significant.
const EPOCH_MS_TOKEN = /\b\d{13}\b/g;

/**
 * Neutralize well-anchored per-request script volatility so two fetches of an
 * otherwise-identical page normalize to the same string: strip the Cloudflare
 * challenge-platform block entirely, and replace epoch-ms tokens inside every
 * other <script> with a fixed placeholder. Leaves non-script markup untouched —
 * a page without either form of volatility passes through unchanged.
 */
export function normalizeHtmlForFingerprint(html: string): string {
  // JSON-LD (<script type="application/ld+json">) bodies are deliberately in scope: a
  // payload differing only in a 13-digit numeric field (price-in-cents, numeric id)
  // reuses a stale render — accepted narrowing, bounded by the render cache's 7-day TTL (#991).
  return html.replace(SCRIPT_BLOCK, (block, openTag: string, body: string, closeTag: string) =>
    CF_CHALLENGE.test(block) ? "" : openTag + body.replace(EPOCH_MS_TOKEN, "0") + closeTag,
  );
}
