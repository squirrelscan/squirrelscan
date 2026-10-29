// A perimeter provider's challenge or block page fails a seed audit, so the bar
// is high: every provider has a real-shaped block and a near-miss that must not
// read as one (squirrelscan/squirrelscan#1253). See fixtures/waf-blocks.ts for
// where each shape comes from.

import { describe, expect, test } from "bun:test";

import { classifyWafResponse, detectWafChallengePage, inspectWafChallengePage } from "../src";
import { BLOCKED, NEAR_MISSES, type Sample } from "./fixtures/waf-blocks";

function response(sample: Sample) {
  return {
    status: sample.status,
    headers: { server: sample.headers.server ?? null, raw: sample.headers },
    html: sample.html,
  };
}

describe("a provider's challenge or block page is blocked", () => {
  for (const sample of BLOCKED) {
    test(`${sample.name} [${sample.how}]`, () => {
      const result = classifyWafResponse(response(sample));
      expect(result.verdict).toBe("blocked");
      expect(result.providerId).toBe(sample.provider);
      expect(result.signal).toContain(sample.signal);
      expect(inspectWafChallengePage(response(sample))).toMatchObject({
        detected: true,
        providerId: sample.provider,
      });
      expect(detectWafChallengePage(response(sample)).detected).toBe(true);
    });
  }

  test("every listed provider has at least one block and one near-miss", () => {
    const providers = new Set(BLOCKED.map((sample) => sample.provider));
    for (const provider of providers) {
      expect(NEAR_MISSES.some((sample) => sample.provider === provider)).toBe(true);
    }
    expect([...providers].sort()).toEqual(
      [
        "aws-waf",
        "akamai",
        "cloudflare",
        "datadome",
        "f5",
        "imperva",
        "kasada",
        "perimeterx",
        "radware",
        "sucuri",
        "vercel",
        "wordfence",
      ].sort(),
    );
  });

  test("statuses 200, 202, 403, 405, 429 and 503 are all covered", () => {
    const statuses = new Set(BLOCKED.map((sample) => sample.status));
    for (const status of [200, 202, 403, 405, 429, 503]) expect(statuses.has(status)).toBe(true);
  });
});

describe("a page that only looks like a provider is not blocked", () => {
  for (const sample of NEAR_MISSES) {
    test(`${sample.name} [${sample.how}]`, () => {
      expect(classifyWafResponse(response(sample)).verdict).not.toBe("blocked");
      expect(detectWafChallengePage(response(sample)).detected).toBe(false);
    });
  }
});

describe("a refusal with no provider marker warns and is still audited", () => {
  test("a bare Access Denied from Cloudflare is suspect, not blocked", () => {
    const result = classifyWafResponse({
      status: 403,
      headers: { server: "cloudflare", raw: { "cf-ray": "0-SYD" } },
      html: "<html><body><h1>Forbidden</h1></body></html>",
    });
    expect(result).toMatchObject({ verdict: "suspect", providerId: "cloudflare" });
    expect(
      detectWafChallengePage({
        status: 403,
        headers: { server: "cloudflare" },
        html: "<h1>Forbidden</h1>",
      }).detected,
    ).toBe(false);
  });

  test("a refusal from an unknown server is clear", () => {
    expect(
      classifyWafResponse({ status: 403, headers: { server: "nginx" }, html: "<h1>Forbidden</h1>" })
        .verdict,
    ).toBe("clear");
  });
});

describe("the signal names what matched, never the page", () => {
  test("a hostile title does not reach the signal", () => {
    const html = `<html><head><title>Attention Required! | Cloudflare ${"x".repeat(5000)}</title></head><body><div id="cf-error-details"></div></body></html>`;
    const result = classifyWafResponse({ status: 403, headers: {}, html });
    expect(result.signal?.length ?? 0).toBeLessThan(100);
  });
});

describe("hostile input stays linear", () => {
  // Scale the trigger, not the filler: 4x the input must not cost far more than 4x the time.
  const shapes: Array<[string, (n: number) => string]> = [
    ["open braces after var dd", (n) => "var dd={".repeat(n)],
    ["unclosed tags", (n) => "<a ".repeat(n)],
    ["reference entities", (n) => "Reference&#32;&#35;1".repeat(n)],
    ["access denied runs", (n) => "<title>Access Denied</title>".repeat(n)],
    ["support id labels", (n) => "Your support ID is ".repeat(n)],
    ["pointy comments", (n) => "<!--".repeat(n)],
    ["quote runs", (n) => '<div class="'.repeat(n)],
    ["src attributes", (n) => '<script src="//'.repeat(n)],
  ];

  function time(html: string): number {
    const start = performance.now();
    classifyWafResponse({ status: 403, headers: { server: "cloudflare" }, html });
    inspectWafChallengePage({ status: 200, headers: {}, html });
    return performance.now() - start;
  }

  for (const [name, build] of shapes) {
    test(`${name}: a 1 MB body returns quickly`, () => {
      const unit = build(1).length;
      const small = build(Math.ceil(262_144 / unit));
      const large = build(Math.ceil(1_048_576 / unit));
      const warm = time(small);
      const ratioBase = Math.max(warm, 1);
      const elapsed = time(large);
      // The scan reads a bounded prefix, so a 4x larger body must not cost 4x, and certainly not quadratic.
      expect(elapsed).toBeLessThan(750);
      expect(elapsed / ratioBase).toBeLessThan(12);
    });
  }
});
