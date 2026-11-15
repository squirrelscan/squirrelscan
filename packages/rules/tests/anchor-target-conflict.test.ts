// links/anchor-target-conflict: one anchor text, several destinations (#1372).

import { describe, expect, test } from "bun:test";

import { AnchorGraphBuilder } from "../src/links/anchor-mismatch";
import {
  anchorTargetConflictRule,
  evaluateAnchorConflicts,
} from "../src/links/anchor-target-conflict";
import type { CheckResult, ParsedPage, RuleContext } from "../src/types";
import type { LinkData } from "@squirrelscan/core-contracts";

const BASE = "https://example.com/";

function body(url: string, text: string): LinkData {
  return { url, text, isInternal: true, isChrome: false };
}
function chrome(url: string, text: string): LinkData {
  return { url, text, isInternal: true, isChrome: true };
}

interface PageSpec {
  url: string;
  links?: LinkData[];
}

function ctx(pages: PageSpec[]): RuleContext {
  return {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages: pages.map((p) => ({
        url: p.url,
        finalUrl: p.url,
        statusCode: 200,
        parsed: {
          meta: { title: p.url },
          h1: { count: 0, texts: [] },
          links: p.links ?? [],
        } as unknown as ParsedPage,
      })),
      robotsTxt: null,
      sitemaps: null,
    },
    options: {},
  } as unknown as RuleContext;
}

async function check(pages: PageSpec[]): Promise<CheckResult> {
  const result = await anchorTargetConflictRule.run(ctx(pages));
  return (result as { checks: CheckResult[] }).checks[0]!;
}

// A site of `n` article pages plus the targets, each article carrying `linksFor(i)`.
function site(n: number, linksFor: (i: number) => LinkData[], targets: string[]): PageSpec[] {
  const pages: PageSpec[] = [{ url: BASE }];
  for (const t of targets) pages.push({ url: `https://example.com${t}` });
  for (let i = 0; i < n; i++) pages.push({ url: `https://example.com/a${i}`, links: linksFor(i) });
  return pages;
}

describe("links/anchor-target-conflict: anchor to several URLs", () => {
  test("warns, naming the deviating destination and example source pages", async () => {
    // 9 pages say Pricing -> /pricing, 2 say Pricing -> /plans.
    const c = await check(
      site(11, (i) => [body(i < 9 ? "/pricing" : "/plans", "Pricing")], ["/pricing", "/plans"]),
    );
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(1);
    expect(c.items![0]!.label).toContain('"Pricing" points at 2 URLs');
    expect(c.items![0]!.label).toContain("/plans (2)");
    expect(c.items![0]!.sourcePages).toEqual([
      "https://example.com/a10",
      "https://example.com/a9",
    ]);
  });

  test("an even split has no norm and is not reported", async () => {
    const c = await check(
      site(10, (i) => [body(i < 5 ? "/pricing" : "/plans", "Pricing")], ["/pricing", "/plans"]),
    );
    expect(c.status).toBe("pass");
  });

  test("anchor text is compared case and whitespace insensitively", async () => {
    const c = await check(
      site(
        11,
        (i) => [body(i < 9 ? "/pricing" : "/plans", i % 2 ? "Pricing" : "  pricing ")],
        ["/pricing", "/plans"],
      ),
    );
    expect(c.status).toBe("warn");
  });

  test("fails once findings reach the fail threshold", async () => {
    const names = Array.from({ length: 10 }, (_, k) => `Topic${String.fromCharCode(97 + k)}`);
    const targets = names.flatMap((_, k) => [`/t${k}`, `/u${k}`]);
    const c = await check(
      site(12, (i) => names.map((n, k) => body(i < 10 ? `/t${k}` : `/u${k}`, n)), targets),
    );
    expect(c.status).toBe("fail");
    expect(c.details?.total).toBe(10);
  });
});

describe("links/anchor-target-conflict: URL with divergent anchors", () => {
  const anchors = ["Pricing", "Buy now", "Subscription costs", "Plans and tiers"];
  const pages = (): PageSpec[] =>
    site(12, (i) => [body("/pricing", anchors[i % 4]!)], ["/pricing"]);

  test("warns for a URL linked with unrelated anchors", async () => {
    const c = await check(pages());
    expect(c.status).toBe("warn");
    expect(c.items).toHaveLength(1);
    expect(c.items![0]!.id).toBe("target: https://example.com/pricing");
    expect(c.items![0]!.label).toContain("4 unrelated anchor texts");
  });

  test("anchors that share a word are one variant", async () => {
    const related = ["Pricing", "Pricing plans", "Our pricing", "Pricing page"];
    const c = await check(site(12, (i) => [body("/pricing", related[i % 4]!)], ["/pricing"]));
    expect(c.status).toBe("pass");
  });

  test("the homepage is never judged for divergent anchors", async () => {
    const c = await check(site(12, (i) => [body("/", anchors[i % 4]!)], []));
    expect(c.status).toBe("pass");
  });
});

describe("links/anchor-target-conflict: no false positives", () => {
  test("generic anchors pointing everywhere never produce a finding", async () => {
    const c = await check(
      site(
        12,
        (i) => [
          body(`/p${i % 3}`, "Read more"),
          body(`/p${(i + 1) % 3}`, "learn more"),
          body(`/p${(i + 2) % 3}`, "Click here"),
          body(`/p${i % 3}`, "Weiterlesen"),
        ],
        ["/p0", "/p1", "/p2"],
      ),
    );
    expect(c.status).toBe("skipped");
  });

  test("chrome links are ignored", async () => {
    const c = await check(
      site(
        11,
        (i) => [chrome(i < 5 ? "/pricing" : "/plans", "Pricing")],
        ["/pricing", "/plans"],
      ),
    );
    expect(c.status).toBe("skipped");
  });

  test("a consistent site passes", async () => {
    const c = await check(
      site(12, (i) => [body("/pricing", "Pricing"), body("/about", `Team ${i % 2}`)], ["/pricing", "/about"]),
    );
    expect(c.status).toBe("pass");
  });
});

describe("links/anchor-target-conflict: skipped", () => {
  test("fewer than 10 pages skips", async () => {
    const c = await check(site(3, () => [body("/pricing", "Pricing")], ["/pricing"]));
    expect(c.status).toBe("skipped");
  });

  test("a missing site skips", async () => {
    const r = await anchorTargetConflictRule.run({ site: undefined } as unknown as RuleContext);
    expect((r as { checks: CheckResult[] }).checks[0]!.status).toBe("skipped");
  });
});

describe("links/anchor-target-conflict: bounded graph", () => {
  test("pairs past the cap are dropped deterministically and counted", () => {
    const run = (): CheckResult => {
      const builder = new AnchorGraphBuilder(3, undefined, undefined);
      for (let i = 0; i < 12; i++) {
        builder.addPage(`https://example.com/p${i}`, {
          status: 200,
          contentType: "text/html",
          links: [body("/p0", "Alpha"), body("/p1", "Beta"), body("/p2", "Gamma")],
        });
      }
      return evaluateAnchorConflicts(builder.build(), BASE, []);
    };
    const a = run();
    expect(a.details?.droppedPairs).toBeGreaterThan(0);
    expect(run()).toEqual(a);
  });
});
