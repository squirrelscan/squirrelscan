// adblock/blocked-links — per-script warnings + page attribution (#240).
//
// (A) Each EasyList match becomes its OWN warning so the resource's identity
//     and the pages it impacts are surfaced individually. Source pages are
//     attributed from parsed links/images, the fetched-scripts map, AND a
//     <script src> scan of the parsed document (the common tracker vector that
//     previously yielded "0 pages affected").
// (B) describeBlockedResource names the vendor for known ad/tracking domains.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import type { BlocklistCheckResponse, CheckResult } from "@squirrelscan/core-contracts";

import {
  blockedLinksRule,
  describeBlockedResource,
  findSourcePages,
} from "../src/adblock/blocked-links";
import { CLOUD_SITE_KEY, type CloudResultStore } from "../src/cloud";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

// ── Helpers ─────────────────────────────────────────────────────────

function blocklistStore(data: BlocklistCheckResponse): CloudResultStore {
  return new Map([
    ["blocklist-check", new Map([[CLOUD_SITE_KEY, { status: "ok", data }]])],
  ]);
}

function ctxFor(
  pagesHtml: { url: string; html: string }[],
  data: BlocklistCheckResponse,
  scripts?: SiteData["scripts"],
): RuleContext {
  const pages: SiteData["pages"] = pagesHtml.map((p) => ({
    url: p.url,
    statusCode: 200,
    parsed: parsePage(p.html, p.url),
  }));
  return {
    page: {
      url: pages[0]?.url ?? "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: pages[0]?.parsed ?? ({} as ParsedPage),
    site: {
      baseUrl: "https://example.com",
      pages,
      robotsTxt: null,
      sitemaps: null,
      scripts,
    },
    cloudResults: blocklistStore(data),
    options: {},
  };
}

const TW = "https://ads-twitter.com/uwt.js";
const FB = "https://connect.facebook.net/en_US/fbevents.js";

function pageWithScripts(url: string, ...srcs: string[]): { url: string; html: string } {
  const tags = srcs.map((s) => `<script src="${s}"></script>`).join("");
  return { url, html: `<html><head>${tags}</head><body><h1>Hi</h1></body></html>` };
}

// ── (B) vendor descriptions ─────────────────────────────────────────

describe("describeBlockedResource", () => {
  test("names known vendor by registrable domain", () => {
    expect(describeBlockedResource(TW)).toBe("ads-twitter.com — X/Twitter ad pixel");
    expect(describeBlockedResource(FB)).toBe(
      "connect.facebook.net — Meta/Facebook pixel",
    );
  });

  test("falls back to hostname for unknown vendors", () => {
    expect(describeBlockedResource("https://tracker.example.io/a.js")).toBe(
      "tracker.example.io",
    );
  });

  test("returns the raw value for non-URL input", () => {
    expect(describeBlockedResource(".ad-banner")).toBe(".ad-banner");
  });
});

// ── (A) source-page attribution ─────────────────────────────────────

describe("findSourcePages", () => {
  test("attributes a blocked <script src> to the page that loads it", () => {
    const ctx = ctxFor(
      [pageWithScripts("https://example.com/", TW), pageWithScripts("https://example.com/about")],
      { matches: [], listsVersion: "v1" },
    );
    expect(findSourcePages(ctx, TW)).toEqual(["https://example.com/"]);
  });

  test("attributes an anchor link to its page", () => {
    const ctx = ctxFor(
      [{ url: "https://example.com/", html: `<html><body><a href="${TW}">x</a></body></html>` }],
      { matches: [], listsVersion: "v1" },
    );
    expect(findSourcePages(ctx, TW)).toEqual(["https://example.com/"]);
  });

  test("prefers the fetched-scripts source map when present", () => {
    const ctx = ctxFor(
      [pageWithScripts("https://example.com/", TW)],
      { matches: [], listsVersion: "v1" },
      [
        {
          url: TW,
          status: 200,
          error: null,
          contentType: "application/javascript",
          sizeBytes: 10,
          content: null,
          sourcePages: ["https://example.com/p1", "https://example.com/p2"],
        },
      ],
    );
    expect(findSourcePages(ctx, TW)).toEqual([
      "https://example.com/p1",
      "https://example.com/p2",
    ]);
  });

  test("returns empty for an unreferenced resource", () => {
    const ctx = ctxFor([pageWithScripts("https://example.com/")], {
      matches: [],
      listsVersion: "v1",
    });
    expect(findSourcePages(ctx, TW)).toEqual([]);
  });
});

// ── (A) + (B) rule output ───────────────────────────────────────────

describe("blockedLinksRule", () => {
  test("emits one warning per blocked script, each naming the vendor + pages", () => {
    const ctx = ctxFor(
      [
        pageWithScripts("https://example.com/", TW, FB),
        pageWithScripts("https://example.com/about", TW),
      ],
      {
        matches: [
          { value: TW, kind: "url", list: "easylist" },
          { value: FB, kind: "url", list: "easylist", rule: "||facebook.net^" },
        ],
        listsVersion: "2024-06",
      },
    );

    const checks = blockedLinksRule.run(ctx).checks as CheckResult[];
    expect(checks).toHaveLength(2);
    for (const c of checks) {
      expect(c.status).toBe("warn");
      expect(c.name).toBe("blocked-links");
    }

    // Sorted by page-impact desc: TW (2 pages) before FB (1 page).
    expect(checks[0].message).toBe(
      `Blocked by ad blockers: ads-twitter.com — X/Twitter ad pixel — ${TW} (2 pages)`,
    );
    expect(checks[0].items?.[0]?.sourcePages).toEqual([
      "https://example.com/",
      "https://example.com/about",
    ]);

    expect(checks[1].message).toBe(
      `Blocked by ad blockers: connect.facebook.net — Meta/Facebook pixel — ${FB} (1 page)`,
    );
    expect(checks[1].items?.[0]?.sourcePages).toEqual(["https://example.com/"]);
    expect(checks[1].items?.[0]?.label).toBe('matches "||facebook.net^"');
  });

  test("distinct same-host resources get distinct messages (no grouping collision)", () => {
    const uwt = "https://ads-twitter.com/uwt.js";
    const jot = "https://ads-twitter.com/i/jot";
    const ctx = ctxFor([pageWithScripts("https://example.com/", uwt, jot)], {
      matches: [
        { value: uwt, kind: "url", list: "easylist" },
        { value: jot, kind: "url", list: "easylist" },
      ],
      listsVersion: "v1",
    });
    const checks = blockedLinksRule.run(ctx).checks as CheckResult[];
    expect(checks).toHaveLength(2);
    // Messages must differ even after digit-normalization (same host, same
    // page count) — the full resource URL is the discriminator.
    const norm = (m: string) => m.replace(/\d+/g, "#");
    expect(norm(checks[0].message)).not.toBe(norm(checks[1].message));
  });

  test("truncates a long URL in the message but keeps the full URL on item.id", () => {
    const longUrl = `https://ads-twitter.com/uwt.js?${"a".repeat(200)}`;
    const ctx = ctxFor([pageWithScripts("https://example.com/", longUrl)], {
      matches: [{ value: longUrl, kind: "url", list: "easylist" }],
      listsVersion: "v1",
    });
    const checks = blockedLinksRule.run(ctx).checks as CheckResult[];
    expect(checks).toHaveLength(1);
    // Message URL is shortened with an ellipsis; full URL is NOT in the message.
    expect(checks[0].message).toContain("…");
    expect(checks[0].message).not.toContain(longUrl);
    // Full URL is preserved on the item id.
    expect(checks[0].items?.[0]?.id).toBe(longUrl);
  });

  test("two long same-prefix URLs still produce distinct messages", () => {
    const prefix = `https://ads-twitter.com/uwt.js?${"a".repeat(200)}`;
    const a = `${prefix}1`;
    const b = `${prefix}2`;
    const ctx = ctxFor([pageWithScripts("https://example.com/", a, b)], {
      matches: [
        { value: a, kind: "url", list: "easylist" },
        { value: b, kind: "url", list: "easylist" },
      ],
      listsVersion: "v1",
    });
    const checks = blockedLinksRule.run(ctx).checks as CheckResult[];
    expect(checks).toHaveLength(2);
    // Differ only past the 80-char display cap — the appended hash disambiguates.
    const norm = (m: string) => m.replace(/\d+/g, "#");
    expect(norm(checks[0].message)).not.toBe(norm(checks[1].message));
  });

  test("clamps maxMatchesToReport to at least one warning", () => {
    const ctx = ctxFor([pageWithScripts("https://example.com/", TW)], {
      matches: [{ value: TW, kind: "url", list: "easylist" }],
      listsVersion: "v1",
    });
    ctx.options = { maxMatchesToReport: 0 };
    const checks = blockedLinksRule.run(ctx).checks as CheckResult[];
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("warn");
  });

  test("emits a warning even when no page could be attributed (empty sourcePages)", () => {
    // Match exists but the resource is referenced by nothing we parsed.
    const ctx = ctxFor([pageWithScripts("https://example.com/")], {
      matches: [{ value: TW, kind: "url", list: "easylist" }],
      listsVersion: "v1",
    });
    const checks = blockedLinksRule.run(ctx).checks as CheckResult[];
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.[0]?.sourcePages).toEqual([]);
    // No "(N pages)" suffix when nothing was attributed.
    expect(checks[0].message).not.toContain("page");
  });

  test("passes when no EasyList matches", () => {
    const ctx = ctxFor([pageWithScripts("https://example.com/")], {
      matches: [],
      listsVersion: "v1",
    });
    const checks = blockedLinksRule.run(ctx).checks as CheckResult[];
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("pass");
  });

  test("ignores EasyPrivacy + selector matches (reported elsewhere)", () => {
    const ctx = ctxFor([pageWithScripts("https://example.com/", TW)], {
      matches: [
        { value: TW, kind: "url", list: "easyprivacy" },
        { value: ".ad", kind: "selector", list: "easylist" },
      ],
      listsVersion: "v1",
    });
    const checks = blockedLinksRule.run(ctx).checks as CheckResult[];
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("pass");
  });

  test("skips when the cloud result was not prefetched", () => {
    const ctx = ctxFor([pageWithScripts("https://example.com/")], {
      matches: [],
      listsVersion: "v1",
    });
    ctx.cloudResults = new Map();
    const checks = blockedLinksRule.run(ctx).checks as CheckResult[];
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("skipped");
  });
});
