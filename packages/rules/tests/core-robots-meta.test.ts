// core/robots-meta — X-Robots-Tag header, pub#457.
//
// A page served with `X-Robots-Tag: noindex` and no robots meta tag was reported
// nowhere: core/robots-meta read the meta tag only, and crawl/indexability, which
// does read the header, reports at info status, which the report leaves out. The
// rule now reads both and names the source (and the crawler, for a scoped header
// such as `X-Robots-Tag: googlebot: noindex`) in its message.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { parseXRobotsTag, robotsMetaRule } from "../src/core/robots-meta";
import type { ParsedPage, RuleContext } from "../src/types";

function run(opts: { meta?: string; header?: string }): CheckResult {
  const url = "https://example.com/";
  const metaTag = opts.meta === undefined ? "" : `<meta name="robots" content="${opts.meta}">`;
  const html = `<!doctype html><html lang="en"><head><title>t</title>${metaTag}</head><body><p>x</p></body></html>`;
  const headers: Record<string, string> = {};
  if (opts.header !== undefined) headers["x-robots-tag"] = opts.header;
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  const checks = robotsMetaRule.run(ctx).checks as CheckResult[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

describe("parseXRobotsTag", () => {
  test("an unscoped value is one group for every crawler", () => {
    expect(parseXRobotsTag("noindex, nofollow")).toEqual([
      { agent: null, directives: "noindex, nofollow" },
    ]);
  });

  test("a user-agent prefix scopes the entries after it until the next prefix", () => {
    expect(parseXRobotsTag("googlebot: nofollow, otherbot: noindex, nofollow")).toEqual([
      { agent: "googlebot", directives: "nofollow" },
      { agent: "otherbot", directives: "noindex, nofollow" },
    ]);
  });

  test("an unscoped header joined before a scoped one stays unscoped", () => {
    expect(parseXRobotsTag("noindex, Googlebot-News: nofollow")).toEqual([
      { agent: null, directives: "noindex" },
      { agent: "googlebot-news", directives: "nofollow" },
    ]);
  });

  test("name: value directives are not user-agent prefixes", () => {
    expect(
      parseXRobotsTag("max-snippet: 20, max-image-preview: large, unavailable_after: 2026-01-01"),
    ).toEqual([
      {
        agent: null,
        directives: "max-snippet: 20, max-image-preview: large, unavailable_after: 2026-01-01",
      },
    ]);
  });

  test("comma-split unavailable_after dates stay in their group", () => {
    // ISO 8601 with a decimal comma and a negative offset, then RFC 850.
    expect(
      parseXRobotsTag("googlebot: unavailable_after: 2026-06-25T15:00:00,5-08:00, noindex"),
    ).toEqual([
      {
        agent: "googlebot",
        directives: "unavailable_after: 2026-06-25T15:00:00, 5-08:00, noindex",
      },
    ]);
    expect(
      parseXRobotsTag("unavailable_after: Friday, 25-Jun-10 15:00:00 PST, bingbot: noindex"),
    ).toEqual([
      { agent: null, directives: "unavailable_after: Friday, 25-Jun-10 15:00:00 PST" },
      { agent: "bingbot", directives: "noindex" },
    ]);
  });

  test("a crawler name may start with a digit", () => {
    expect(parseXRobotsTag("googlebot: index, 360Spider: noindex")).toEqual([
      { agent: "googlebot", directives: "index" },
      { agent: "360spider", directives: "noindex" },
    ]);
  });

  test("a prefix that is not a user-agent token is read as a directive", () => {
    expect(parseXRobotsTag("<b>bot</b>: noindex")).toEqual([
      { agent: null, directives: "<b>bot</b>: noindex" },
    ]);
  });
});

describe("core/robots-meta — sources (pub#457)", () => {
  test("no meta tag and no header passes as before", () => {
    const c = run({});
    expect(c.status).toBe("pass");
    expect(c.message).toBe("No robots meta tag (defaults to index, follow)");
    expect(c.value).toBeNull();
  });

  test("meta noindex,nofollow names the meta tag and keeps the raw value", () => {
    const c = run({ meta: "noindex,nofollow" });
    expect(c.status).toBe("warn");
    expect(c.message).toBe("Page is set to noindex and nofollow via robots meta tag");
    expect(c.value).toBe("noindex,nofollow");
  });

  test("X-Robots-Tag: noindex alone is reported, naming the header", () => {
    const c = run({ header: "noindex" });
    expect(c.status).toBe("warn");
    expect(c.message).toBe("Page is set to noindex via X-Robots-Tag header");
    expect(c.value).toBe("X-Robots-Tag: noindex");
  });

  test("a googlebot-scoped header names the crawler", () => {
    const c = run({ header: "googlebot: noindex" });
    expect(c.status).toBe("warn");
    expect(c.message).toBe("Page is set to noindex via X-Robots-Tag header for googlebot");
    expect(c.value).toBe("X-Robots-Tag: googlebot: noindex");
  });

  test("several scoped crawlers are listed, past five they are counted", () => {
    expect(run({ header: "googlebot: noindex, bingbot: noindex" }).message).toBe(
      "Page is set to noindex via X-Robots-Tag header for googlebot, bingbot",
    );
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((bot) => `${bot}bot: noindex`).join(", ");
    expect(run({ header: many }).message).toBe(
      "Page is set to noindex via X-Robots-Tag header for abot, bbot, cbot, dbot, ebot and 2 more",
    );
  });

  test("an unscoped header directive folds away the scoped ones", () => {
    expect(run({ header: "noindex, googlebot: noindex" }).message).toBe(
      "Page is set to noindex via X-Robots-Tag header",
    );
  });

  test("meta and header both declaring noindex name both", () => {
    const c = run({ meta: "noindex", header: "noindex" });
    expect(c.message).toBe("Page is set to noindex via robots meta tag and X-Robots-Tag header");
    expect(c.value).toBe("robots meta: noindex; X-Robots-Tag: noindex");
  });

  test("different sources for noindex and nofollow get one clause each", () => {
    const c = run({ meta: "nofollow", header: "googlebot: noindex" });
    expect(c.status).toBe("warn");
    expect(c.message).toBe(
      "Page is set to noindex via X-Robots-Tag header for googlebot, nofollow via robots meta tag",
    );
  });

  test("header nofollow alone is info, naming the header", () => {
    const c = run({ header: "nofollow" });
    expect(c.status).toBe("info");
    expect(c.message).toBe(
      "Page is set to nofollow via X-Robots-Tag header (links won't pass equity)",
    );
  });

  test("crawler names are not searched for directives", () => {
    const c = run({ header: "noindexbot: index" });
    expect(c.status).toBe("pass");
    expect(c.message).toBe("X-Robots-Tag header allows indexing");
  });

  test("a date fragment never becomes a crawler name in the message", () => {
    expect(
      run({ header: "googlebot: unavailable_after: 2026-06-25T15:00:00,5-08:00, noindex" }).message,
    ).toBe("Page is set to noindex via X-Robots-Tag header for googlebot");
  });

  test("header case is ignored", () => {
    expect(run({ header: "GoogleBot: NOINDEX" }).message).toBe(
      "Page is set to noindex via X-Robots-Tag header for googlebot",
    );
  });

  test("a header without noindex or nofollow passes and says so", () => {
    expect(run({ header: "noarchive" }).message).toBe("X-Robots-Tag header allows indexing");
    expect(run({ meta: "index, follow", header: "max-snippet: 50" }).message).toBe(
      "Robots meta tag and X-Robots-Tag header allow indexing",
    );
    expect(run({ meta: "index, follow" }).message).toBe("Robots meta tag allows indexing");
  });

  test("a blank header counts as no header", () => {
    const c = run({ header: "  " });
    expect(c.status).toBe("pass");
    expect(c.message).toBe("No robots meta tag (defaults to index, follow)");
  });
});
