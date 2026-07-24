// #802 — applyStatusGuards must classify challenge-shaped 503s (Cloudflare /
// PerimeterX / Akamai bot walls serve their JS challenge as 503) as `blocked`,
// while a plain 503 (real outage / maintenance) stays a generic network error.
// 403 → blocked and 429 → rate_limit guards are asserted alongside (#792).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { applyStatusGuards, CrawlError } from "../src/fetcher";

const URL = "https://example.com/";

// Run the guard and return the CrawlError it failed with, or null if it passed.
async function guard(
  status: number,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<CrawlError | null> {
  const result = await Effect.runPromise(
    Effect.either(applyStatusGuards(URL, status, new Headers(opts.headers), opts.body)),
  );
  return result._tag === "Left" ? result.left : null;
}

const CLOUDFLARE_CHALLENGE =
  '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification">Checking your browser before accessing example.com</div><script src="/cdn-cgi/challenge-platform/orchestrate/jsch/v1"></script></body></html>';

const PERIMETERX_CHALLENGE =
  '<!doctype html><html><head><title>Access to this page has been denied</title></head><body><div id="px-captcha"></div><script>window._pxAppId="PX12345";</script></body></html>';

// Real Akamai deny/challenge page shape: tag-broken heading + entity-encoded
// reference line ("Reference&#32;&#35;18&#46;...") in the raw HTML.
const AKAMAI_CHALLENGE =
  '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don\'t have permission to access "http&#58;&#47;&#47;www&#46;example&#46;com&#47;" on this server.<P>\nReference&#32;&#35;18&#46;9d367a83&#46;1614887475&#46;2b3c78d\n</BODY>\n</HTML>';

describe("applyStatusGuards (#792/#802)", () => {
  test("2xx and 404 pass through unguarded", async () => {
    expect(await guard(200)).toBeNull();
    expect(await guard(404)).toBeNull();
  });

  test("403 → blocked", async () => {
    const error = await guard(403);
    expect(error?.type).toBe("blocked");
  });

  test("429 → rate_limit with retry-after", async () => {
    const error = await guard(429, { headers: { "retry-after": "30" } });
    expect(error?.type).toBe("rate_limit");
    expect(error?.retryAfter).toBe(30);
  });

  test("plain 5xx → generic network error", async () => {
    const error = await guard(500);
    expect(error?.type).toBe("network");
    expect(error?.message).toContain("500");
  });

  test("plain 503 with a non-challenge body → generic network error", async () => {
    const error = await guard(503, { body: "Service temporarily unavailable" });
    expect(error?.type).toBe("network");
    expect(error?.message).toContain("503");
  });

  test("503 with no body available → generic network error", async () => {
    const error = await guard(503);
    expect(error?.type).toBe("network");
  });

  test("Cloudflare challenge 503 → blocked, names the provider", async () => {
    const error = await guard(503, { body: CLOUDFLARE_CHALLENGE });
    expect(error?.type).toBe("blocked");
    expect(error?.message).toContain("Cloudflare");
  });

  test("PerimeterX challenge 503 → blocked", async () => {
    const error = await guard(503, { body: PERIMETERX_CHALLENGE });
    expect(error?.type).toBe("blocked");
  });

  test("Akamai challenge 503 → blocked", async () => {
    const error = await guard(503, { body: AKAMAI_CHALLENGE });
    expect(error?.type).toBe("blocked");
    expect(error?.message).toContain("Akamai");
  });

  test("503 with cf-mitigated: challenge header → blocked even without a body", async () => {
    const error = await guard(503, { headers: { "cf-mitigated": "challenge" } });
    expect(error?.type).toBe("blocked");
    expect(error?.message).toContain("Cloudflare");
  });

  test("challenge markers at a non-503 5xx status stay a network error (guard is 503-scoped)", async () => {
    const error = await guard(502, { body: CLOUDFLARE_CHALLENGE });
    expect(error?.type).toBe("network");
  });
});
