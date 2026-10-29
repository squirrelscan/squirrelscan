// #802 — applyStatusGuards must classify challenge-shaped 503s (Cloudflare /
// PerimeterX / Akamai bot walls serve their JS challenge as 503) as `blocked`,
// while a plain 503 (real outage / maintenance) stays a generic network error.
// 403 → blocked and 429 → rate_limit guards are asserted alongside (#792).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { applyStatusGuards, applyWafGuard, CrawlError } from "../src/fetcher";

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

  test("plain 403, including a Cloudflare server header → generic blocked", async () => {
    const error = await guard(403, {
      body: "Forbidden",
      headers: { server: "cloudflare" },
    });
    expect(error?.type).toBe("blocked");
    expect(error?.message).toBe("Request blocked by server");
  });

  test("403 with cf-mitigated: challenge → blocked, names Cloudflare", async () => {
    const error = await guard(403, { headers: { "cf-mitigated": "challenge" } });
    expect(error?.type).toBe("blocked");
    expect(error?.message).toBe("Blocked by Cloudflare challenge (403)");
  });

  test("Cloudflare challenge body at 403 → blocked, names the provider", async () => {
    const error = await guard(403, { body: CLOUDFLARE_CHALLENGE });
    expect(error?.type).toBe("blocked");
    expect(error?.message).toBe("Blocked by Cloudflare challenge (403)");
  });

  test("Akamai challenge body at 403 → blocked, names the provider", async () => {
    const error = await guard(403, { body: AKAMAI_CHALLENGE });
    expect(error?.type).toBe("blocked");
    expect(error?.message).toBe("Blocked by Akamai challenge (403)");
  });

  test("429 → rate_limit with retry-after (ms, #1829)", async () => {
    const error = await guard(429, { headers: { "retry-after": "30" } });
    expect(error?.type).toBe("rate_limit");
    expect(error?.retryAfterMs).toBe(30_000);
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

// #1253: a provider's challenge is a block at any status, and carries who and why.
const KASADA_CHALLENGE =
  "<!DOCTYPE html><html><head></head><body><script>window.KPSDK={};KPSDK.start=Date.now();</script>" +
  '<script src="/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/ips.js"></script></body></html>';

const DATADOME_CHALLENGE =
  `<html><head><title>example.com</title></head><body><p>Please enable JS</p><script>var dd={'rt':'c','cid':'TESTCID','host':'geo.captcha-delivery.com'}</script>` +
  '<script src="https://ct.captcha-delivery.com/c.js"></script></body></html>';

async function wafGuard(
  status: number,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<CrawlError | null> {
  const result = await Effect.runPromise(
    Effect.either(applyWafGuard(URL, status, new Headers(opts.headers), opts.body)),
  );
  return result._tag === "Left" ? result.left : null;
}

describe("a provider's challenge at any status (#1253)", () => {
  test("a Kasada challenge at 429 is blocked, not rate limited", async () => {
    const error = await guard(429, { body: KASADA_CHALLENGE });
    expect(error?.type).toBe("blocked");
    expect(error?.status).toBe(429);
    expect(error?.wafBlock).toMatchObject({ provider: "Kasada", providerId: "kasada" });
  });

  test("a plain 429 stays rate limiting, with or without a body", async () => {
    expect((await guard(429, { body: "slow down" }))?.type).toBe("rate_limit");
    expect((await guard(429))?.type).toBe("rate_limit");
  });

  test("a challenge served as 200 passes the status guards but not the WAF guard", async () => {
    expect(await guard(200, { body: DATADOME_CHALLENGE })).not.toBeNull();
    const error = await wafGuard(200, { body: DATADOME_CHALLENGE });
    expect(error?.type).toBe("blocked");
    expect(error?.message).toBe("Blocked by DataDome challenge (200)");
    expect(error?.wafBlock?.signal).toContain("DataDome");
  });

  test("an AWS WAF challenge (202, header only) and CAPTCHA (405) are blocked", async () => {
    expect((await wafGuard(202, { headers: { "x-amzn-waf-action": "challenge" } }))?.wafBlock?.providerId).toBe("aws-waf");
    expect((await wafGuard(405, { headers: { "x-amzn-waf-action": "captcha" } }))?.status).toBe(405);
  });

  test("ordinary 200, 202, 405 and 429 responses pass the WAF guard", async () => {
    const page = "<html><head><title>Hi</title></head><body><p>hello</p></body></html>";
    for (const status of [200, 202, 405]) expect(await wafGuard(status, { body: page })).toBeNull();
    expect(await wafGuard(202, { headers: { "x-amzn-requestid": "TEST" } })).toBeNull();
  });
});
