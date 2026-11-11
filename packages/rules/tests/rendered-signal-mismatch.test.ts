// crawl/rendered-signal-mismatch: raw HTML vs cloud-rendered head signals (repo#1684).
//
// A page rule with four checks. Verifies each check's pass/fail, the canonical normalisation, the
// noindex side, the title and H1 warnings with both texts, and every skip (a browser-rendered crawl,
// no render result, a failed render). The soft-404 skip is the rule's `skipOnSoft404` flag.

import { describe, expect, test } from "bun:test";

import type { RenderResultItem } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import type { CloudResultEnvelope, CloudResultStore } from "../src/cloud";
import {
  canonicalKey,
  collectRobotsDirectives,
  directivesSayNoindex,
  renderedSignalMismatchRule,
  robotsSaysNoindex,
} from "../src/crawl/rendered-signal-mismatch";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/page";

interface Signals {
  title?: string;
  canonical?: string;
  robots?: string;
  h1?: string;
  /** Raw head markup appended after the rest, for a second robots tag or an odd `name`. */
  extraHead?: string;
}

function html(s: Signals): string {
  return `<!DOCTYPE html><html><head>${s.title === undefined ? "" : `<title>${s.title}</title>`}${
    s.canonical === undefined ? "" : `<link rel="canonical" href="${s.canonical}">`
  }${s.robots === undefined ? "" : `<meta name="robots" content="${s.robots}">`}${s.extraHead ?? ""}</head><body>${
    s.h1 === undefined ? "" : `<h1>${s.h1}</h1>`
  }<p>body</p></body></html>`;
}

const SAME: Signals = {
  title: "Pricing",
  canonical: "https://example.com/page",
  robots: "index,follow",
  h1: "Pricing",
};

function envelope(htmlText: string | undefined): CloudResultEnvelope<RenderResultItem> {
  return { status: "ok", data: { url: URL, status: 200, html: htmlText } };
}

function makeCtx(
  raw: Signals,
  render?: CloudResultEnvelope<RenderResultItem>,
  over: { rendered?: boolean } = {},
): RuleContext {
  const rawHtml = html(raw);
  const parsed = parsePage(rawHtml, URL);
  const cloudResults: CloudResultStore | undefined = render
    ? new Map([["render", new Map([[URL, render as CloudResultEnvelope]])]])
    : undefined;
  return {
    page: {
      url: URL,
      html: rawHtml,
      statusCode: 200,
      loadTime: 0,
      headers: {},
      parsed,
      ...(over.rendered ? { rendered: true } : {}),
    },
    parsed,
    cloudResults,
    options: {},
  } as unknown as RuleContext;
}

function checks(ctx: RuleContext): Record<string, CheckResult> {
  const out = (renderedSignalMismatchRule.run(ctx) as { checks: CheckResult[] }).checks;
  expect(out.map((c) => c.name)).toEqual([
    "canonical-mismatch",
    "noindex-mismatch",
    "title-modified",
    "h1-modified",
  ]);
  return Object.fromEntries(out.map((c) => [c.name, c]));
}

const run = (raw: Signals, rendered: Signals) =>
  checks(makeCtx(raw, envelope(html(rendered))));

describe("crawl/rendered-signal-mismatch", () => {
  test("declares the render cloud spec, page scope and error severity", () => {
    expect(renderedSignalMismatchRule.meta.cloud).toEqual({
      service: "render",
      unit: "page",
      creditFeature: "audit_page",
    });
    expect(renderedSignalMismatchRule.meta.scope).toBe("page");
    expect(renderedSignalMismatchRule.meta.verdictScope).toBe("page");
    expect(renderedSignalMismatchRule.meta.category).toBe("crawl");
    expect(renderedSignalMismatchRule.meta.skipOnSoft404).toBe(true);
  });

  test("identical signals on both sides pass all four checks", () => {
    const c = run(SAME, SAME);
    expect(Object.values(c).map((x) => x.status)).toEqual(["pass", "pass", "pass", "pass"]);
  });

  describe("canonical-mismatch", () => {
    test("a different canonical fails and shows both URLs", () => {
      const c = run(SAME, { ...SAME, canonical: "https://example.com/other" })["canonical-mismatch"]!;
      expect(c.status).toBe("fail");
      expect(c.message).toContain("https://example.com/page");
      expect(c.message).toContain("https://example.com/other");
      expect(c.details).toEqual({
        raw: "https://example.com/page",
        rendered: "https://example.com/other",
      });
    });

    test("a canonical only the render adds, when it points elsewhere, fails; one it removes fails", () => {
      const added = run(
        { ...SAME, canonical: undefined },
        { ...SAME, canonical: "https://example.com/elsewhere" },
      )["canonical-mismatch"]!;
      expect(added.status).toBe("fail");
      expect(added.message).toContain("adds a canonical");
      const removed = run(SAME, { ...SAME, canonical: undefined })["canonical-mismatch"]!;
      expect(removed.status).toBe("fail");
      expect(removed.message).toContain("removes the canonical");
    });

    test("the standard SPA shape, no raw canonical and the script adds the page's own URL, warns", () => {
      for (const rendered of [
        "https://example.com/page",
        "https://example.com/page/",
        "/page",
        "https://EXAMPLE.com/page#top",
      ]) {
        const c = run({ ...SAME, canonical: undefined }, { ...SAME, canonical: rendered })[
          "canonical-mismatch"
        ]!;
        expect(c.status).toBe("warn");
        expect(c.message).toContain("this page's own URL");
        expect(c.details).toMatchObject({ raw: null, selfCanonicalAddedByScript: true });
      }
    });

    test("a script that changes a canonical the raw HTML had still fails, even to the page's own URL", () => {
      const c = run(
        { ...SAME, canonical: "https://example.com/other" },
        { ...SAME, canonical: "https://example.com/page" },
      )["canonical-mismatch"]!;
      expect(c.status).toBe("fail");
    });

    test("no canonical on either side passes", () => {
      const c = run({ ...SAME, canonical: undefined }, { ...SAME, canonical: undefined });
      expect(c["canonical-mismatch"]!.status).toBe("pass");
    });

    test("a trailing slash, host case and a default port are not a mismatch", () => {
      for (const rendered of [
        "https://example.com/page/",
        "https://EXAMPLE.com/page",
        "https://example.com:443/page",
        "https://example.com/page#section",
        "/page",
      ]) {
        const c = run(SAME, { ...SAME, canonical: rendered })["canonical-mismatch"]!;
        expect(c.status).toBe("pass");
      }
    });

    test("a different query, scheme or host is a mismatch", () => {
      for (const rendered of [
        "https://example.com/page?x=1",
        "http://example.com/page",
        "https://www.example.com/page",
      ]) {
        const c = run(SAME, { ...SAME, canonical: rendered })["canonical-mismatch"]!;
        expect(c.status).toBe("fail");
      }
    });
  });

  describe("noindex-mismatch", () => {
    test("noindex only in the raw HTML fails and says the raw side carries it", () => {
      const c = run({ ...SAME, robots: "noindex, follow" }, SAME)["noindex-mismatch"]!;
      expect(c.status).toBe("fail");
      expect(c.details).toMatchObject({ raw: true, rendered: false, carriedBy: "raw" });
    });

    test("noindex only in the rendered DOM fails and says the rendered side carries it", () => {
      const c = run(SAME, { ...SAME, robots: "NOINDEX" })["noindex-mismatch"]!;
      expect(c.status).toBe("fail");
      expect(c.details).toMatchObject({ raw: false, rendered: true, carriedBy: "rendered" });
    });

    test("noindex on both sides, or on neither, passes; other directives are not noindex", () => {
      expect(
        run({ ...SAME, robots: "noindex" }, { ...SAME, robots: "noindex,nofollow" })[
          "noindex-mismatch"
        ]!.status,
      ).toBe("pass");
      expect(
        run({ ...SAME, robots: "nofollow" }, { ...SAME, robots: "noarchive" })["noindex-mismatch"]!
          .status,
      ).toBe("pass");
    });

    test("robotsSaysNoindex reads tokens, and `none` includes noindex", () => {
      expect(robotsSaysNoindex(null)).toBe(false);
      expect(robotsSaysNoindex("index, follow")).toBe(false);
      expect(robotsSaysNoindex("max-snippet:-1, noindex")).toBe(true);
      expect(robotsSaysNoindex("none")).toBe(true);
      expect(robotsSaysNoindex("noindexed")).toBe(false);
    });

    test("a second robots tag a script appends is a mismatch: the first tag alone would read equal", () => {
      const raw = { ...SAME, robots: "index, follow" };
      const rendered = { ...SAME, robots: "index, follow", extraHead: '<meta name="robots" content="noindex">' };
      const c = run(raw, rendered)["noindex-mismatch"]!;
      expect(c.status).toBe("fail");
      expect(c.details).toMatchObject({ raw: false, rendered: true, carriedBy: "rendered" });
      expect((c.details as { renderedRobots: string }).renderedRobots).toBe("index, follow | noindex");
    });

    test("a second tag in the raw HTML that the script removes is a mismatch too", () => {
      const raw = { ...SAME, robots: "index", extraHead: '<meta name="robots" content="noindex">' };
      const c = run(raw, { ...SAME, robots: "index" })["noindex-mismatch"]!;
      expect(c.status).toBe("fail");
      expect(c.details).toMatchObject({ raw: true, rendered: false, carriedBy: "raw" });
    });

    test("a googlebot tag counts: only the render adds a googlebot noindex fails; on both sides passes", () => {
      const noindex = '<meta name="googlebot" content="noindex, nofollow">';
      const added = run({ ...SAME }, { ...SAME, extraHead: noindex })["noindex-mismatch"]!;
      expect(added.status).toBe("fail");
      const both = run({ ...SAME, extraHead: noindex }, { ...SAME, extraHead: noindex })[
        "noindex-mismatch"
      ]!;
      expect(both.status).toBe("pass");
    });

    test("the name is matched without regard to case", () => {
      const upper = run(
        { ...SAME },
        { ...SAME, extraHead: '<meta NAME="ROBOTS" content="NoIndex">' },
      )["noindex-mismatch"]!;
      expect(upper.status).toBe("fail");
      const mixed = run(
        { ...SAME },
        { ...SAME, extraHead: '<meta name="GoogleBot" content="none">' },
      )["noindex-mismatch"]!;
      expect(mixed.status).toBe("fail");
    });

    test("other meta names are not robots directives", () => {
      const c = run(
        { ...SAME },
        { ...SAME, extraHead: '<meta name="bingbot" content="noindex"><meta name="keywords" content="noindex">' },
      )["noindex-mismatch"]!;
      expect(c.status).toBe("pass");
    });

    test("the raw document is read again from the raw HTML when the crawl released it", () => {
      const ctx = makeCtx({ ...SAME, robots: "index, follow" }, envelope(html({ ...SAME, robots: "index", extraHead: '<meta name="robots" content="noindex">' })));
      // A large crawl drops each page's document as it goes: the rule falls back to page.html.
      (ctx.parsed as { document: unknown }).document = null;
      const out = (renderedSignalMismatchRule.run(ctx) as { checks: CheckResult[] }).checks;
      expect(out.find((c) => c.name === "noindex-mismatch")!.status).toBe("fail");
    });

    test("collectRobotsDirectives lists every robots and googlebot tag, and directivesSayNoindex reads them all", () => {
      const doc = parsePage(
        html({ robots: "index", extraHead: '<meta name="Googlebot" content="noindex"><meta name="x" content="noindex">' }),
        URL,
      ).document!;
      expect(collectRobotsDirectives(doc)).toEqual(["index", "noindex"]);
      expect(directivesSayNoindex(["index", "follow"])).toBe(false);
      expect(directivesSayNoindex(["index", "none"])).toBe(true);
      expect(directivesSayNoindex([])).toBe(false);
    });
  });

  describe("title-modified and h1-modified", () => {
    test("a changed title warns and shows the raw and rendered text", () => {
      const c = run(SAME, { ...SAME, title: "Loading..." })["title-modified"]!;
      expect(c.status).toBe("warn");
      expect(c.details).toEqual({ raw: "Pricing", rendered: "Loading..." });
      expect(c.message).toContain("Pricing");
      expect(c.message).toContain("Loading...");
    });

    test("whitespace and case differences are not a change", () => {
      const c = run(
        { ...SAME, title: "  Our   Pricing " },
        { ...SAME, title: "our pricing" },
      )["title-modified"]!;
      expect(c.status).toBe("pass");
    });

    test("a first H1 that differs, or exists on one side only, warns with both texts", () => {
      const changed = run(SAME, { ...SAME, h1: "Plans" })["h1-modified"]!;
      expect(changed.status).toBe("warn");
      expect(changed.details).toEqual({ raw: "Pricing", rendered: "Plans" });
      expect(run({ ...SAME, h1: undefined }, SAME)["h1-modified"]!.status).toBe("warn");
      expect(run(SAME, { ...SAME, h1: undefined })["h1-modified"]!.status).toBe("warn");
    });

    test("only the first H1 is compared", () => {
      const raw = `<!DOCTYPE html><html><head><title>T</title></head><body><h1>One</h1><h1>Two</h1></body></html>`;
      const rendered = `<!DOCTYPE html><html><head><title>T</title></head><body><h1>One</h1><h1>Changed</h1></body></html>`;
      const ctx = makeCtx(SAME, envelope(rendered));
      const parsed = parsePage(raw, URL);
      (ctx as { parsed: unknown }).parsed = parsed;
      expect(checks(ctx)["h1-modified"]!.status).toBe("pass");
    });

    test("a runaway title is cut in the finding, not in the comparison", () => {
      const long = "x".repeat(500);
      const c = run(SAME, { ...SAME, title: long })["title-modified"]!;
      expect(c.status).toBe("warn");
      expect((c.details as { rendered: string }).rendered.length).toBeLessThanOrEqual(200);
    });
  });

  describe("skips: one skipped check, never a pass or a fail", () => {
    const only = (ctx: RuleContext): CheckResult => {
      const out = (renderedSignalMismatchRule.run(ctx) as { checks: CheckResult[] }).checks;
      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe("rendered-signal-mismatch");
      return out[0]!;
    };

    test("a browser-rendered crawl skips, with the reason", () => {
      const c = only(makeCtx(SAME, envelope(html(SAME)), { rendered: true }));
      expect(c.status).toBe("skipped");
      expect(c.skipReason).toContain("browser-rendered");
    });

    test("no render result (a CLI audit without the cloud) skips with a reason", () => {
      const c = only(makeCtx(SAME));
      expect(c.status).toBe("skipped");
      expect(c.skipReason).toBeTruthy();
    });

    test("a skipped render result skips, and an empty render says so", () => {
      const skippedEnvelope = {
        status: "skipped",
        skipReason: "render-disabled",
      } as unknown as CloudResultEnvelope<RenderResultItem>;
      expect(only(makeCtx(SAME, skippedEnvelope)).status).toBe("skipped");
      const empty = only(makeCtx(SAME, envelope(undefined)));
      expect(empty.status).toBe("skipped");
      expect(empty.message).toContain("No rendered HTML");
    });
  });

  test("the same input gives the same result every run", () => {
    const a = JSON.stringify(run(SAME, { ...SAME, title: "Other", canonical: "/x", h1: "Y" }));
    const b = JSON.stringify(run(SAME, { ...SAME, title: "Other", canonical: "/x", h1: "Y" }));
    expect(a).toBe(b);
  });

  test("canonicalKey resolves, drops the fragment and the trailing slash, and keeps the root", () => {
    expect(canonicalKey("/a/", URL)).toBe("https://example.com/a");
    expect(canonicalKey("https://example.com/", URL)).toBe("https://example.com/");
    expect(canonicalKey("  ", URL)).toBeNull();
    expect(canonicalKey(null, URL)).toBeNull();
  });
});
