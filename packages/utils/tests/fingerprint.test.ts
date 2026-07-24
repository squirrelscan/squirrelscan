// Unit tests for the source-fingerprint normalizer (#839).

import { describe, expect, test } from "bun:test";

import { normalizeHtmlForFingerprint } from "../src/fingerprint";

// The real Cloudflare challenge-platform injection: an inline <script> whose
// only per-request bits are the ray id (r) and the base64 timestamp (t) inside
// window.__CF$cv$params. Everything else is identical between fetches.
function cfInjected(rayId: string, timestamp: string): string {
  return `<!doctype html><html><head><title>Dr Madnani</title></head><body>
<h1>Welcome</h1>
<p>Same content every time.</p>
<script>(function(){function c(){var b=a.getElementById("cf-content");}window.__CF$cv$params={r:'${rayId}',t:'${timestamp}'};var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(s);})();</script>
</body></html>`;
}

// A TanStack Start SSR page (#991): the inline $_TSR hydration script embeds a
// per-request `u:<Date.now()>` epoch-ms timestamp. Only that token rotates
// between fetches — the rest of the payload is byte-identical.
function tsrHydrated(updatedMs: number): string {
  return `<!doctype html><html><head><title>ovasbuild</title></head><body>
<div id="app"><h1>Same content every time.</h1></div>
<script>window.$_TSR={matches:[{i:"__root__",u:${updatedMs},s:"success",d:{loaderData:{title:"Home"}}}]}</script>
</body></html>`;
}

describe("normalizeHtmlForFingerprint", () => {
  test("two fetches differing only in ray id / timestamp normalize identically", () => {
    const a = cfInjected("a18ce978482b62aa", "MTc4MzY1ODY1Mw==");
    const b = cfInjected("7f2b1c9d0e4a5b6c", "MTc4MzY1OTIwMA==");

    // Sanity: the raw bytes really do differ (the injection rotated).
    expect(a).not.toBe(b);

    // But the fingerprint-normalized form is byte-identical.
    expect(normalizeHtmlForFingerprint(a)).toBe(normalizeHtmlForFingerprint(b));
  });

  test("strips the CF block entirely, leaving the rest of the markup intact", () => {
    const normalized = normalizeHtmlForFingerprint(cfInjected("abc", "def"));
    expect(normalized).not.toContain("__CF$cv$params");
    expect(normalized).not.toContain("challenge-platform");
    expect(normalized).toContain("<h1>Welcome</h1>");
    expect(normalized).toContain("<title>Dr Madnani</title>");
  });

  test("a page WITHOUT the injection passes through unchanged", () => {
    const clean = `<!doctype html><html><head><title>t</title></head><body>
<script>console.log("app boot");</script>
<script src="https://cdn.example.com/analytics.js"></script>
<p>hi</p>
</body></html>`;
    expect(normalizeHtmlForFingerprint(clean)).toBe(clean);
  });

  test("strips the external challenge-platform <script src> form too", () => {
    const html =
      `<html><head></head><body><p>x</p>` +
      `<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"></script>` +
      `</body></html>`;
    const normalized = normalizeHtmlForFingerprint(html);
    expect(normalized).not.toContain("challenge-platform");
    expect(normalized).toContain("<p>x</p>");
  });

  test("removes multiple CF blocks but keeps unrelated scripts", () => {
    const html =
      `<html><body>` +
      `<script>window.__CF$cv$params={r:'1',t:'2'};</script>` +
      `<script>real();</script>` +
      `<script src="/cdn-cgi/challenge-platform/x/main.js"></script>` +
      `</body></html>`;
    const normalized = normalizeHtmlForFingerprint(html);
    expect(normalized).toContain("<script>real();</script>");
    expect(normalized).not.toContain("__CF$cv$params");
    expect(normalized).not.toContain("challenge-platform");
  });

  test("is case-tolerant on the SCRIPT tag", () => {
    const html = `<body><SCRIPT>window.__CF$cv$params={r:'1',t:'2'};</SCRIPT></body>`;
    expect(normalizeHtmlForFingerprint(html)).not.toContain("__CF$cv$params");
  });

  test("empty string and injection-free string are returned as-is", () => {
    expect(normalizeHtmlForFingerprint("")).toBe("");
    expect(normalizeHtmlForFingerprint("<p>no scripts here</p>")).toBe("<p>no scripts here</p>");
  });

  test("TanStack Start pages differing only in the inline u:<epoch-ms> normalize identically", () => {
    const a = tsrHydrated(1783993372389);
    const b = tsrHydrated(1783993374448);

    // Sanity: the raw bytes really do differ (the hydration timestamp rotated).
    expect(a).not.toBe(b);

    // But the fingerprint-normalized form is byte-identical.
    expect(normalizeHtmlForFingerprint(a)).toBe(normalizeHtmlForFingerprint(b));
  });

  test("a 13-digit epoch-ms token in body text OUTSIDE any script is preserved", () => {
    // Same script (no volatile token), but the visible body carries a different
    // 13-digit number — that's real content and must stay fingerprint-significant.
    const a = `<body><script>boot();</script><p>order 1783993372389 shipped</p></body>`;
    const b = `<body><script>boot();</script><p>order 1783993374448 shipped</p></body>`;

    expect(normalizeHtmlForFingerprint(a)).toContain("1783993372389");
    expect(normalizeHtmlForFingerprint(a)).not.toBe(normalizeHtmlForFingerprint(b));
  });

  test("a 14-digit integer inside a script is preserved (not treated as epoch-ms)", () => {
    const html = `<body><script>var id=12345678901234;</script></body>`;
    expect(normalizeHtmlForFingerprint(html)).toContain("12345678901234");
  });

  test("neutralizes a 13-digit numeric field inside a JSON-LD script (accepted narrowing)", () => {
    // SCRIPT_BLOCK also matches <script type="application/ld+json">, so a structured-data
    // payload differing ONLY in a standalone 13-digit numeric field (price-in-cents /
    // numeric id) collides for render reuse. This documents that accepted narrowing (#991).
    const jsonLd = (sku: number) =>
      `<html><body><script type="application/ld+json">{"@type":"Product","sku":${sku}}</script></body></html>`;
    const a = jsonLd(1234567890123);
    const b = jsonLd(9876543210987);

    expect(a).not.toBe(b);
    expect(normalizeHtmlForFingerprint(a)).toBe(normalizeHtmlForFingerprint(b));
  });

  test("a 13-digit cache-buster in a <script src> attribute stays fingerprint-significant", () => {
    // The epoch pass rewrites script BODIES only. A deploy-version bump in the
    // opening tag's src changes the rendered output, so it MUST change the hash —
    // the token in the attribute is preserved, not neutralized.
    const a = `<html><body><script src="/app.js?v=1783993372389"></script></body></html>`;
    const b = `<html><body><script src="/app.js?v=9876543210987"></script></body></html>`;

    expect(normalizeHtmlForFingerprint(a)).toContain("1783993372389");
    expect(normalizeHtmlForFingerprint(a)).not.toBe(normalizeHtmlForFingerprint(b));
  });
});
