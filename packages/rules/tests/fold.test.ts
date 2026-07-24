// foldOverflowChecks (#910) — per-page rules legitimately emit one check per
// affected page, so 500+ page crawls overflow REPORT_LIMITS.maxChecksPerRule
// and the publish schema silently slices pages off the report (#817). The fold
// collapses each over-cap (name, status) issue class into ONE aggregate check
// that keeps every affected page and the itemized detail within the caps.

import { describe, expect, test } from "bun:test";

import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

import { clampItemId } from "@squirrelscan/core-contracts/clamp";

import {
  capChecksForPublish,
  capMixedRuleChecksForPublish,
  clampCheckDetails,
  clampCheckItemIds,
  clampCheckStrings,
  clampCheckItemsOverflow,
  clampReportPagesToBudget,
  DEFAULT_FOLD_LIMITS,
  foldOverflowChecks,
  unfoldAggregateCheck,
  type FoldLimits,
} from "../src/fold";
import { altTextRule } from "../src/images/alt-text";
import { mergeRuleRunResult } from "../src/merge";
import type { CheckResult, ParsedPage, RuleContext, RuleResult, RuleRunResult } from "../src/types";

const SMALL: FoldLimits = {
  maxChecks: 5,
  maxItemsPerCheck: 3,
  maxPagesPerCheck: 4,
  maxSourcePagesPerItem: 2,
};

function failCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "thing-broken",
    status: "fail",
    message: "1 thing broken",
    ...overrides,
  };
}

describe("foldOverflowChecks", () => {
  test("at or below the cap the array passes through untouched (same reference)", () => {
    const checks = Array.from({ length: 5 }, (_, i) =>
      failCheck({ pageUrl: `https://example.com/p/${i}` }),
    );
    expect(foldOverflowChecks(checks, SMALL)).toBe(checks);
  });

  test("over-cap checks fold to one aggregate per (name, status) class; singletons survive as-is", () => {
    const single: CheckResult = {
      name: "other-check",
      status: "pass",
      message: "fine",
      pageUrl: "https://example.com/",
    };
    const checks = [
      ...Array.from({ length: 6 }, (_, i) => failCheck({ pageUrl: `https://example.com/p/${i}` })),
      single,
    ];

    const folded = foldOverflowChecks(checks, SMALL);
    expect(folded).toHaveLength(2);
    // Sorted by (name, status) for run-to-run determinism.
    expect(folded[0]).toBe(single);

    const aggregate = folded[1]!;
    expect(aggregate.name).toBe("thing-broken");
    expect(aggregate.status).toBe("fail");
    expect(aggregate.message).toBe("1 thing broken (+5 more pages)");
    expect(aggregate.details?.aggregated).toBe(true);
    expect(aggregate.details?.occurrences).toBe(6);
    // Pages capped at maxPagesPerCheck, sorted.
    expect(aggregate.pages).toEqual([
      "https://example.com/p/0",
      "https://example.com/p/1",
      "https://example.com/p/2",
      "https://example.com/p/3",
    ]);
  });

  test("items merge by id across folded checks; the contributing page becomes a sourcePage", () => {
    const checks = Array.from({ length: 6 }, (_, i) =>
      failCheck({
        pageUrl: `https://example.com/p/${i}`,
        items: [{ id: "https://cdn.example.com/shared.jpg" }],
      }),
    );

    const [aggregate] = foldOverflowChecks(checks, SMALL);
    expect(aggregate!.items).toHaveLength(1);
    expect(aggregate!.items![0]!.id).toBe("https://cdn.example.com/shared.jpg");
    // sourcePages capped at maxSourcePagesPerItem, sorted.
    expect(aggregate!.items![0]!.sourcePages).toEqual([
      "https://example.com/p/0",
      "https://example.com/p/1",
    ]);
  });

  test("item overflow past maxItemsPerCheck and folded per-check remainders land in details.additional", () => {
    const checks = Array.from({ length: 6 }, (_, i) =>
      failCheck({
        pageUrl: `https://example.com/p/${i}`,
        items: [{ id: `item-${i}` }],
        // Two checks already truncated their own items (rule-side "+N more").
        details: i < 2 ? { additional: 10 } : undefined,
      }),
    );

    const [aggregate] = foldOverflowChecks(checks, SMALL);
    expect(aggregate!.items).toHaveLength(SMALL.maxItemsPerCheck);
    // 3 items dropped at the cap + 2×10 carried remainders.
    expect(aggregate!.details?.additional).toBe(23);
  });

  test("a repeat occurrence of an already-dropped item id counts once in additional", () => {
    // Cap fills with item-0..2; "shared-cdn" first appears after the cap and
    // then recurs on every later check — it must count as ONE dropped item.
    const checks = [
      ...Array.from({ length: 3 }, (_, i) =>
        failCheck({ pageUrl: `https://example.com/p/${i}`, items: [{ id: `item-${i}` }] }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        failCheck({ pageUrl: `https://example.com/q/${i}`, items: [{ id: "shared-cdn" }] }),
      ),
    ];

    const [aggregate] = foldOverflowChecks(checks, SMALL);
    expect(aggregate!.items).toHaveLength(SMALL.maxItemsPerCheck);
    expect(aggregate!.details?.additional).toBe(1);
  });

  test("provenance stays carried only when every folded check was carried", () => {
    const carried = Array.from({ length: 6 }, (_, i) =>
      failCheck({
        pageUrl: `https://example.com/p/${i}`,
        provenance: "carried",
        lastSeenAt: 1000 + i,
      }),
    );
    const [allCarried] = foldOverflowChecks(carried, SMALL);
    expect(allCarried!.provenance).toBe("carried");
    expect(allCarried!.lastSeenAt).toBe(1005);

    const mixed = [...carried.slice(0, 5), failCheck({ pageUrl: "https://example.com/fresh" })];
    const [notCarried] = foldOverflowChecks(mixed, SMALL);
    expect(notCarried!.provenance).toBeUndefined();
  });

  test("a pathological rule with more distinct issue classes than the cap still slices to the cap", () => {
    const checks = Array.from({ length: 10 }, (_, i) =>
      failCheck({ name: `class-${i}`, pageUrl: `https://example.com/p/${i}` }),
    );
    expect(foldOverflowChecks(checks, SMALL)).toHaveLength(SMALL.maxChecks);
  });
});

// #910 acceptance: the exact drmadnani.com failure mode — images/alt-text
// failing on every page of a crawl larger than maxChecksPerRule. The rule's
// merged emission must fold to within REPORT_LIMITS with no page lost.
describe("images/alt-text over-cap crawl (#910)", () => {
  const FAIL_PAGES = 600;
  const PASS_PAGES = 150;

  function pageCtx(pageUrl: string, missingAlt: boolean, i: number): RuleContext {
    const images = [
      {
        src: `https://cdn.example.com/img-${i}.jpg`,
        alt: missingAlt ? null : "described",
      },
    ];
    return {
      page: { url: pageUrl, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { images } as unknown as ParsedPage,
      options: {},
    } as unknown as RuleContext;
  }

  test("merged per-page emission exceeds the cap; folded output stays within every cap", () => {
    const map = new Map<string, RuleRunResult>();
    for (let i = 0; i < FAIL_PAGES + PASS_PAGES; i++) {
      const pageUrl = `https://example.com/p/${i}`;
      const result = altTextRule.run(pageCtx(pageUrl, i < FAIL_PAGES, i)) as RuleResult;
      // The adapter stamps pageUrl on page-scope checks before merging.
      for (const check of result.checks) {
        if (!check.pageUrl) check.pageUrl = pageUrl;
      }
      mergeRuleRunResult(map, altTextRule.meta.id, {
        meta: altTextRule.meta,
        checks: result.checks,
      });
    }

    const merged = map.get("images/alt-text")!.checks;
    expect(merged.length).toBe(FAIL_PAGES + PASS_PAGES);
    expect(merged.length).toBeGreaterThan(REPORT_LIMITS.maxChecksPerRule);

    const folded = foldOverflowChecks(merged);

    // One aggregate per issue class: alt-text-missing (fail) + alt-text (pass).
    expect(folded.length).toBeLessThanOrEqual(REPORT_LIMITS.maxChecksPerRule);
    expect(folded).toHaveLength(2);

    const fail = folded.find((c) => c.status === "fail")!;
    expect(fail.name).toBe("alt-text-missing");
    expect(fail.details?.occurrences).toBe(FAIL_PAGES);
    // Every affected page survives the fold (the schema slice used to drop
    // pages past the cap wholesale).
    expect(fail.pages).toHaveLength(FAIL_PAGES);
    expect(fail.items!.length).toBeLessThanOrEqual(REPORT_LIMITS.maxItemsPerCheck);

    const pass = folded.find((c) => c.status === "pass")!;
    expect(pass.name).toBe("alt-text");
    expect(pass.details?.occurrences).toBe(PASS_PAGES);
  });
});

// unfoldAggregateCheck (#916) — the server smart-audits union receives a published
// (already-folded) report and must re-derive one finding per affected page.
describe("unfoldAggregateCheck", () => {
  test("a non-aggregate check passes through unchanged", () => {
    const plain: CheckResult = {
      name: "x-broken",
      status: "fail",
      message: "broke",
      pageUrl: "https://e.com/",
    };
    expect(unfoldAggregateCheck(plain)).toEqual([plain]);
    // A check that happens to carry `pages` but isn't a fold aggregate is untouched.
    const withPages: CheckResult = { ...plain, pages: ["https://e.com/a"] };
    expect(unfoldAggregateCheck(withPages)).toEqual([withPages]);
  });

  test("expands to one per-page check, attributing items by sourcePages and stripping aggregate detail", () => {
    const aggregate: CheckResult = {
      name: "alt-text-missing",
      status: "fail",
      message: "img missing alt (+2 more pages)",
      pages: ["https://e.com/a", "https://e.com/b", "https://e.com/c"],
      items: [
        { id: "img1", sourcePages: ["https://e.com/a"] },
        { id: "img2", sourcePages: ["https://e.com/b", "https://e.com/c"] },
      ],
      details: { aggregated: true, occurrences: 3, additional: 5, ruleHint: "keep-me" },
    };

    const out = unfoldAggregateCheck(aggregate);
    expect(out).toHaveLength(3);

    const a = out.find((c) => c.pageUrl === "https://e.com/a")!;
    expect(a.pages).toBeUndefined();
    expect(a.items?.map((i) => i.id)).toEqual(["img1"]);
    // The fold's " (+N more pages)" suffix is stripped so a re-fold won't stack one.
    expect(a.message).toBe("img missing alt");
    // Fold-only bookkeeping is dropped; non-fold detail keys survive.
    expect(a.details?.aggregated).toBeUndefined();
    expect(a.details?.occurrences).toBeUndefined();
    expect(a.details?.ruleHint).toBe("keep-me");
    // `additional` (density-penalty input) is pinned to the FIRST page, not lost.
    expect(a.details?.additional).toBe(5);

    const b = out.find((c) => c.pageUrl === "https://e.com/b")!;
    expect(b.items?.map((i) => i.id)).toEqual(["img2"]);
    expect(b.details?.additional).toBeUndefined();
    // A page with no attributed items yields an itemless check, not items: [].
    const withNoMatchingItem = unfoldAggregateCheck({
      ...aggregate,
      items: [{ id: "img1", sourcePages: ["https://e.com/a"] }],
    }).find((c) => c.pageUrl === "https://e.com/c")!;
    expect(withNoMatchingItem.items).toBeUndefined();
  });

  test("fold → unfold round-trips the affected page set (lossless under the page cap)", () => {
    const BIG_PAGES: FoldLimits = {
      maxChecks: 3,
      maxItemsPerCheck: 1000,
      maxPagesPerCheck: 2000,
      maxSourcePagesPerItem: 5,
    };
    const perPage = Array.from({ length: 6 }, (_, i) =>
      failCheck({ pageUrl: `https://example.com/p/${i}` }),
    );
    const folded = foldOverflowChecks(perPage, BIG_PAGES);
    expect(folded).toHaveLength(1);

    const unfolded = unfoldAggregateCheck(folded[0]!);
    expect(unfolded.map((c) => c.pageUrl).sort()).toEqual(perPage.map((c) => c.pageUrl).sort());
    for (const c of unfolded) {
      expect(c.pageUrl).toBeTruthy();
      expect(c.details?.aggregated).toBeUndefined();
    }
  });

  test("fold → unfold → re-fold keeps ONE page-count suffix and preserves `additional`", () => {
    const BIG_PAGES: FoldLimits = {
      maxChecks: 3,
      maxItemsPerCheck: 1000,
      maxPagesPerCheck: 2000,
      maxSourcePagesPerItem: 5,
    };
    // 6 per-page fails, each with its own item + rule-side truncation remainder.
    const perPage = Array.from({ length: 6 }, (_, i) =>
      failCheck({
        pageUrl: `https://example.com/p/${i}`,
        items: [{ id: `img-${i}` }],
        details: { additional: 2 },
      }),
    );
    const folded = foldOverflowChecks(perPage, BIG_PAGES);
    expect(folded).toHaveLength(1);
    const foldedAdditional = folded[0]!.details?.additional as number;
    expect(foldedAdditional).toBe(12); // 6×2 remainders summed, no items dropped

    const refolded = foldOverflowChecks(unfoldAggregateCheck(folded[0]!), BIG_PAGES);
    expect(refolded).toHaveLength(1);
    // Exactly one "(+N more pages)" suffix — never doubled (review finding).
    expect(refolded[0]!.message.match(/\(\+\d+ more pages\)/g) ?? []).toHaveLength(1);
    // The density-penalty remainder survives the round trip (not silently dropped).
    expect(refolded[0]!.details?.additional).toBe(foldedAdditional);
  });
});

describe("per-check pages cap (#918)", () => {
  test("DEFAULT_FOLD_LIMITS.maxPagesPerCheck tracks REPORT_LIMITS, above the crawl ceiling", () => {
    expect(DEFAULT_FOLD_LIMITS.maxPagesPerCheck).toBe(REPORT_LIMITS.maxPagesPerCheck);
    // Decoupled from + larger than the crawl-ceiling maxPages (#918).
    expect(REPORT_LIMITS.maxPagesPerCheck).toBeGreaterThan(REPORT_LIMITS.maxPages);
  });

  test("a >2000-page failure keeps every page (no clip at the old 2000 cap)", () => {
    // 3000 per-page fails in ONE class → one aggregate. With the raised cap it
    // keeps all 3000 pages; the old maxPages=2000 fold cap would have clipped.
    const checks = Array.from({ length: 3000 }, (_, i) =>
      failCheck({ pageUrl: `https://example.com/p/${i}` }),
    );
    const folded = foldOverflowChecks(checks); // DEFAULT limits
    expect(folded).toHaveLength(1);
    expect(folded[0]!.pages).toHaveLength(3000);
    expect(folded[0]!.pages!.length).toBeLessThanOrEqual(REPORT_LIMITS.maxPagesPerCheck);
  });

  test("re-fold attributes items from a pages-carrying check to those pages", () => {
    // A group where one check is already aggregate-shaped (pages[] + items, no
    // pageUrl). foldGroup must attribute its item to those pages via sourcePages,
    // or a later unfold drops the item from every page.
    const perPage = Array.from({ length: 5 }, (_, i) =>
      failCheck({ pageUrl: `https://example.com/p/${i}` }),
    );
    const aggregateShaped = failCheck({
      pages: ["https://example.com/agg/a", "https://example.com/agg/b"],
      items: [{ id: "shared-item" }],
    });
    const folded = foldOverflowChecks([...perPage, aggregateShaped], SMALL);
    expect(folded).toHaveLength(1);
    const item = folded[0]!.items?.find((it) => it.id === "shared-item");
    expect(item?.sourcePages).toContain("https://example.com/agg/a");
    expect(item?.sourcePages).toContain("https://example.com/agg/b");
  });

  test("re-fold keeps a narrowly-scoped item's sourcePages (no over-broadening)", () => {
    // An aggregate-shaped check whose item ONLY fired on page a. A re-fold must
    // NOT broaden it to page b just because the aggregate lists both pages.
    const perPage = Array.from({ length: 5 }, (_, i) =>
      failCheck({ pageUrl: `https://example.com/p/${i}` }),
    );
    const narrowAggregate = failCheck({
      pages: ["https://example.com/agg/a", "https://example.com/agg/b"],
      items: [{ id: "narrow", sourcePages: ["https://example.com/agg/a"] }],
    });
    const folded = foldOverflowChecks([...perPage, narrowAggregate], SMALL);
    const item = folded[0]!.items?.find((it) => it.id === "narrow");
    expect(item?.sourcePages).toEqual(["https://example.com/agg/a"]);
    expect(item?.sourcePages).not.toContain("https://example.com/agg/b");
  });

  test("unfold distributes multi-page items to each of their pages", () => {
    const aggregate: CheckResult = {
      name: "x",
      status: "fail",
      message: "bad (+2 more pages)",
      pages: ["https://x/a", "https://x/b", "https://x/c"],
      items: [
        { id: "item-ab", sourcePages: ["https://x/a", "https://x/b"] },
        { id: "item-c", sourcePages: ["https://x/c"] },
      ],
      details: { aggregated: true, occurrences: 3 },
    };
    const perPage = unfoldAggregateCheck(aggregate);
    expect(perPage).toHaveLength(3);
    const byUrl = new Map(perPage.map((c) => [c.pageUrl!, c]));
    expect(byUrl.get("https://x/a")!.items?.map((i) => i.id)).toEqual(["item-ab"]);
    expect(byUrl.get("https://x/b")!.items?.map((i) => i.id)).toEqual(["item-ab"]);
    expect(byUrl.get("https://x/c")!.items?.map((i) => i.id)).toEqual(["item-c"]);
  });
});

describe("clampReportPagesToBudget (#918 payload guard)", () => {
  test("no-op when total pages bytes fit the budget", () => {
    const rr = {
      r1: { checks: [failCheck({ pages: ["https://x/a", "https://x/b"] })] },
    };
    expect(clampReportPagesToBudget(rr, 1_000_000)).toBe(0);
    expect(rr.r1.checks[0]!.pages).toHaveLength(2);
    expect(rr.r1.checks[0]!.details?.pagesTruncated).toBeUndefined();
  });

  test("over budget: clips largest-first, stamps pagesTruncated, keeps >=1 page", () => {
    const big = {
      checks: [
        failCheck({
          name: "big",
          pages: Array.from({ length: 100 }, (_, i) => `https://x/big/${i}`),
        }),
      ],
    };
    const small = {
      checks: [failCheck({ name: "small", pages: ["https://x/small/0", "https://x/small/1"] })],
    };
    const rr = { big, small };
    const dropped = clampReportPagesToBudget(rr, 500);
    expect(dropped).toBeGreaterThan(0);
    // The largest array is clipped first, down to under its original length but
    // never below one page (the check still cites where it fired).
    expect(big.checks[0]!.pages!.length).toBeLessThan(100);
    expect(big.checks[0]!.pages!.length).toBeGreaterThanOrEqual(1);
    expect(big.checks[0]!.details?.pagesTruncated).toBe(100);
    // Budget met by clipping `big` alone → the small array is untouched.
    expect(small.checks[0]!.pages).toHaveLength(2);
    expect(small.checks[0]!.details?.pagesTruncated).toBeUndefined();
  });

  test("#1275: estimates multi-byte page URLs by true UTF-8 bytes, not .length", () => {
    // 10 URLs each ~100 CJK chars: ~118 UTF-16 code units but ~318 UTF-8 bytes.
    const cjkPages = Array.from(
      { length: 10 },
      (_, i) => `https://x.test/${"路".repeat(100)}/${i}`,
    );
    const rr = { r: { checks: [failCheck({ pages: cjkPages })] } };
    // The OLD `.length`-based estimate (url.length + 3) sums UNDER this budget, so
    // it would NOT clip — the pages would ride ~3KB over the real byte budget.
    const lengthEstimate = cjkPages.reduce((sum, u) => sum + u.length + 3, 0);
    expect(lengthEstimate).toBeLessThan(2000);
    // Byte-accurate estimate is over budget → it clips.
    const dropped = clampReportPagesToBudget(rr, 2000);
    expect(dropped).toBeGreaterThan(0);
    expect(rr.r.checks[0]!.pages!.length).toBeLessThan(10);
    expect(rr.r.checks[0]!.details?.pagesTruncated).toBe(10);
  });
});

// clampCheckItemIds (#996) — rules emit raw URLs / selectors as item ids (a
// `data:` URL image src blows past the medium-string cap); the publish schema
// used to REJECT those and 400 the whole audit. Clamp producer-side so both the
// CLI and the cloud container emit already-bounded, still-unique ids.
describe("clampCheckItemIds", () => {
  const MAX = REPORT_LIMITS.maxMediumString;
  const dataUrl = (n: number) => `data:image/png;base64,${"A".repeat(n)}`;

  test("under-cap ids pass through untouched (same references)", () => {
    const checks: CheckResult[] = [
      failCheck({ items: [{ id: "https://x/a" }, { id: "https://x/b", label: "B" }] }),
      failCheck({ name: "no-items" }),
    ];
    expect(clampCheckItemIds(checks)).toBe(checks);
  });

  test("clamps oversize id to the cap and keeps distinct long ids distinct", () => {
    const idA = dataUrl(5000);
    const idB = `${dataUrl(4999)}B`; // differs only at the end
    const checks: CheckResult[] = [failCheck({ items: [{ id: idA }, { id: idB }] })];
    const out = clampCheckItemIds(checks);

    expect(out).not.toBe(checks); // new refs when something changed
    const [a, b] = out[0]!.items!;
    expect(a!.id.length).toBe(MAX);
    expect(b!.id.length).toBe(MAX);
    expect(a!.id).not.toBe(b!.id); // hash suffix prevents collision
    expect(a!.id).toBe(clampItemId(idA)); // matches the shared clamp exactly
  });

  test("clampItemId is idempotent — re-clamping a clamped id is a no-op", () => {
    const clamped = clampItemId(dataUrl(5000));
    expect(clamped.length).toBe(MAX);
    // A clamped id sits exactly AT the cap, so the length<=max early-return
    // must keep producer-clamp + server-clamp from diverging.
    expect(clampItemId(clamped)).toBe(clamped);
  });

  test("clamps an oversize label but leaves an untouched item by reference", () => {
    const keep = { id: "https://x/keep" };
    const checks: CheckResult[] = [
      failCheck({ items: [keep, { id: "https://x/y", label: "Z".repeat(MAX + 50) }] }),
    ];
    const out = clampCheckItemIds(checks);
    expect(out[0]!.items![0]).toBe(keep); // unchanged item not re-allocated
    expect(out[0]!.items![1]!.label!.length).toBe(MAX);
  });
});

// clampCheckItemsOverflow (#1003) — a standalone check (never grouped by fold
// because it's the only check of its issue class) can carry more items than
// maxItemsPerCheck on its own. broken-links/broken-external-links/broken-images
// (scope: "site", each ONE check with one item per broken link/image found
// site-wide) hit this on link/image-heavy sites: the check COUNT never
// overflows maxChecksPerRule, so foldOverflowChecks never triggers, and
// foldGroup's item-merge cap only fires for GROUPED (name,status) classes.
describe("clampCheckItemsOverflow", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `item-${i}` }));

  test("under-cap items pass through untouched (same references)", () => {
    const checks: CheckResult[] = [failCheck({ items: items(3) }), failCheck({ name: "no-items" })];
    expect(clampCheckItemsOverflow(checks, 5)).toBe(checks);
  });

  test("slices an oversize items array to the cap and stamps details.additional", () => {
    const checks: CheckResult[] = [failCheck({ items: items(1200) })];
    const out = clampCheckItemsOverflow(checks, 1000);
    expect(out).not.toBe(checks); // new refs when something changed
    expect(out[0]!.items).toHaveLength(1000);
    expect(out[0]!.items![0]!.id).toBe("item-0"); // keeps the FIRST maxItems, not a random slice
    expect(out[0]!.details?.additional).toBe(200);
  });

  test("adds the dropped count to an existing rule-side additional remainder", () => {
    const checks: CheckResult[] = [failCheck({ items: items(1100), details: { additional: 50 } })];
    const out = clampCheckItemsOverflow(checks, 1000);
    // 100 dropped by this clamp + 50 already carried by the rule.
    expect(out[0]!.details?.additional).toBe(150);
  });

  test("a check with no items, or exactly at the cap, is left untouched by reference", () => {
    const atCap = failCheck({ items: items(1000) });
    const noItems = failCheck({ name: "clean" });
    const checks = [atCap, noItems];
    const out = clampCheckItemsOverflow(checks, 1000);
    expect(out).toBe(checks);
    expect(out[0]).toBe(atCap);
    expect(out[1]).toBe(noItems);
  });

  test("defaults to REPORT_LIMITS.maxItemsPerCheck when no cap is passed", () => {
    const checks: CheckResult[] = [failCheck({ items: items(REPORT_LIMITS.maxItemsPerCheck + 1) })];
    const out = clampCheckItemsOverflow(checks);
    expect(out[0]!.items).toHaveLength(REPORT_LIMITS.maxItemsPerCheck);
  });
});

// capChecksForPublish (#1003) — the composed producer-side pre-clamp for a
// SINGLE RULE's checks array: id/label clamp (#996) → items-overflow clamp
// (#1003) → checks-count fold (#910), so ruleResults.<id>.checks is bounded
// on every axis before it ever reaches the publish schema's silent
// truncatedArray slice (#817). Folding by (name,status) is sound here because
// every check in the array comes from the SAME rule.
describe("capChecksForPublish", () => {
  test("a fully under-cap array passes through with no changes", () => {
    const checks: CheckResult[] = [failCheck({ pageUrl: "https://x/a" })];
    const out = capChecksForPublish(checks, 500);
    expect(out).toEqual(checks);
  });

  test("clamps a standalone check's oversize items array even when checks.length is well under maxChecks", () => {
    // A single site-wide check (broken-links pattern) with 1500 items — check
    // COUNT is 1, nowhere near maxChecks, so foldOverflowChecks alone would
    // never touch it.
    const items = Array.from({ length: 1500 }, (_, i) => ({ id: `https://x/broken-${i}` }));
    const checks: CheckResult[] = [failCheck({ name: "broken-links", items })];
    const out = capChecksForPublish(checks, 500);
    expect(out).toHaveLength(1);
    expect(out[0]!.items).toHaveLength(REPORT_LIMITS.maxItemsPerCheck);
    expect(out[0]!.details?.additional).toBe(1500 - REPORT_LIMITS.maxItemsPerCheck);
  });

  test("folds one rule's per-page checks over maxChecks into an aggregate (#910 shape)", () => {
    const checks = Array.from({ length: 210 }, (_, i) =>
      failCheck({ pageUrl: `https://x/p/${i}` }),
    );
    const out = capChecksForPublish(checks, REPORT_LIMITS.maxChecksPerPage);
    expect(out.length).toBeLessThanOrEqual(REPORT_LIMITS.maxChecksPerPage);
  });

  test("also clamps oversize item ids (#996) in the same pass", () => {
    const longId = `https://x/${"a".repeat(REPORT_LIMITS.maxMediumString + 100)}`;
    const checks: CheckResult[] = [failCheck({ items: [{ id: longId }] })];
    const out = capChecksForPublish(checks, 500);
    expect(out[0]!.items![0]!.id.length).toBe(REPORT_LIMITS.maxMediumString);
  });
});

// capMixedRuleChecksForPublish (#1003) — the producer-side pre-clamp for a
// checks array that mixes MULTIPLE rules' checks: pages[].checks (every
// page-scoped rule's check for one page) and siteChecks (every site-scoped
// rule's check, flattened). Unlike capChecksForPublish, this must NEVER fold
// by (name,status) — two different rules could coincidentally share a check
// name+status, and merging them would silently drop one check's
// value/expected and mislabel the result with fold's "(+N more pages)"
// wording (a review finding on the original #1003 implementation, which
// reused capChecksForPublish/foldOverflowChecks here).
describe("capMixedRuleChecksForPublish", () => {
  test("a fully under-cap array passes through with no changes", () => {
    const checks: CheckResult[] = [failCheck({ name: "rule-a" }), failCheck({ name: "rule-b" })];
    const out = capMixedRuleChecksForPublish(checks, 500);
    expect(out).toEqual(checks);
  });

  test("caps an over-count array with a PLAIN SLICE — never merges same (name,status) checks from different rules", () => {
    // Two DIFFERENT rules that happen to both emit a "broken" / "fail" check —
    // folding would wrongly treat these as the same recurring finding.
    const ruleA = failCheck({ name: "broken", value: "rule-a-value" });
    const ruleB = failCheck({ name: "broken", value: "rule-b-value" });
    const out = capMixedRuleChecksForPublish([ruleA, ruleB], 10);
    expect(out).toHaveLength(2);
    // Both checks survive UNMERGED — neither value/expected was dropped, and
    // no aggregated/"(+N more pages)" fold bookkeeping was added.
    expect(out.find((c) => c.value === "rule-a-value")).toBeTruthy();
    expect(out.find((c) => c.value === "rule-b-value")).toBeTruthy();
    expect(out.every((c) => c.details?.aggregated === undefined)).toBe(true);
    expect(out.every((c) => !c.message.includes("more pages"))).toBe(true);
  });

  test("slices to maxChecks (last-resort, no signal) when the array is truly over cap", () => {
    const checks = Array.from({ length: 210 }, (_, i) => failCheck({ name: `rule-${i}` }));
    const out = capMixedRuleChecksForPublish(checks, 200);
    expect(out).toHaveLength(200);
    expect(out[0]).toBe(checks[0]); // untouched references, plain slice
  });

  test("still clamps a standalone check's oversize items array", () => {
    const items = Array.from({ length: 1500 }, (_, i) => ({ id: `item-${i}` }));
    const checks: CheckResult[] = [failCheck({ items })];
    const out = capMixedRuleChecksForPublish(checks, 500);
    expect(out[0]!.items).toHaveLength(REPORT_LIMITS.maxItemsPerCheck);
    expect(out[0]!.details?.additional).toBe(1500 - REPORT_LIMITS.maxItemsPerCheck);
  });

  test("still clamps oversize item ids (#996)", () => {
    const longId = `https://x/${"a".repeat(REPORT_LIMITS.maxMediumString + 100)}`;
    const checks: CheckResult[] = [failCheck({ items: [{ id: longId }] })];
    const out = capMixedRuleChecksForPublish(checks, 500);
    expect(out[0]!.items![0]!.id.length).toBe(REPORT_LIMITS.maxMediumString);
  });
});

// #1263: clampCheckStrings bounds the DISPLAY check strings that interpolate
// crawled page content (message/value/expected/skipReason) at the producer-side
// fold choke point — the API publish schema already truncates these (#1216), so
// this closes the LOCAL/unpublished-report + pre-publish-derivation hole.
describe("clampCheckStrings (#1263)", () => {
  const M = REPORT_LIMITS.maxMediumString;
  const over = (n: number) => "x".repeat(n + 1);

  test("truncates message/value/expected/skipReason to maxMediumString", () => {
    const [c] = clampCheckStrings([
      {
        name: "core-title",
        status: "fail",
        message: over(M),
        value: over(M),
        expected: over(M),
        skipReason: over(M),
      },
    ]);
    expect(c!.message.length).toBe(M);
    expect((c!.value as string).length).toBe(M);
    expect((c!.expected as string).length).toBe(M);
    expect((c!.skipReason as string).length).toBe(M);
  });

  test("leaves the `name` JOIN KEY untouched and numeric value/expected untouched", () => {
    const longName = over(M);
    const [c] = clampCheckStrings([
      { name: longName, status: "warn", message: "m", value: 123, expected: 456 },
    ]);
    expect(c!.name).toBe(longName); // fold/dedup key — never clamped
    expect(c!.value).toBe(123);
    expect(c!.expected).toBe(456);
  });

  test("returns the SAME references when nothing overruns (no content-hash churn)", () => {
    const input: CheckResult[] = [
      { name: "n", status: "pass", message: "short", value: "v", expected: "e" },
    ];
    const out = clampCheckStrings(input);
    expect(out).toBe(input);
    expect(out[0]).toBe(input[0]);
  });

  test("does not introduce an undefined `value`/`expected`/`skipReason` own-key", () => {
    const [c] = clampCheckStrings([{ name: "n", status: "fail", message: over(M) }]);
    expect(Object.hasOwn(c!, "value")).toBe(false);
    expect(Object.hasOwn(c!, "expected")).toBe(false);
    expect(Object.hasOwn(c!, "skipReason")).toBe(false);
  });

  test("capChecksForPublish applies the string clamp end to end", () => {
    const [c] = capChecksForPublish(
      [{ name: "core-title", status: "fail", message: over(M) }],
      REPORT_LIMITS.maxChecksPerRule,
    );
    expect(c!.message.length).toBe(M);
  });
});

// #1288: clampCheckDetails bounds the free-form `details` record — `details`
// is z.record(z.unknown()) at the publish schema, no single string to clamp
// against like message/value/expected, so it's bounded structurally instead
// (see clampDetailsRecord's own tests in packages/core-contracts for the
// exhaustive per-axis cap+1 coverage). This describe block is about the
// PRODUCER-SIDE WIRING: same choke point as clampCheckStrings, and — the
// scoring-critical invariant — additional/occurrences/pagesTruncated survive.
describe("clampCheckDetails (#1288)", () => {
  const M = REPORT_LIMITS.maxMediumString;
  const over = (n: number) => "x".repeat(n + 1);

  test("bounds an oversize details record (key-count cap)", () => {
    const details = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const [c] = clampCheckDetails([failCheck({ details })]);
    expect(Object.keys(c!.details!).length).toBeLessThan(30);
  });

  test("leaves an under-cap details record untouched (SAME reference)", () => {
    const checks: CheckResult[] = [failCheck({ details: { additional: 5 } })];
    const out = clampCheckDetails(checks);
    expect(out).toBe(checks);
    expect(out[0]!.details).toBe(checks[0]!.details);
  });

  test("a check with no details at all is untouched", () => {
    const checks: CheckResult[] = [failCheck()];
    const out = clampCheckDetails(checks);
    expect(out).toBe(checks);
  });

  test("scoring/issue-sync bookkeeping numbers (additional/occurrences/pagesTruncated) survive the clamp untouched", () => {
    // packages/audit-engine/src/scoring.ts's checkAdditional() reads
    // details.additional for the item-overflow-aware fail-unit count;
    // apps/api/src/services/issue-sync.ts reads details verbatim into
    // issues.metadata. Neither must ever see these bookkeeping numbers
    // altered by this clamp, even when the record ALSO needs bounding.
    const bigNoise = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`k${i}`, "x".repeat(50)]),
    );
    const details = { additional: 40, occurrences: 12, pagesTruncated: 1837, ...bigNoise };
    const [c] = clampCheckDetails([failCheck({ details })]);
    expect(c!.details!.additional).toBe(40);
    expect(c!.details!.occurrences).toBe(12);
    expect(c!.details!.pagesTruncated).toBe(1837);
  });

  test("capChecksForPublish applies the details clamp end to end, alongside the string clamp", () => {
    const bigNoise = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const [c] = capChecksForPublish(
      [failCheck({ message: over(M), details: bigNoise })],
      REPORT_LIMITS.maxChecksPerRule,
    );
    expect(c!.message.length).toBe(M);
    expect(Object.keys(c!.details!).length).toBeLessThan(30);
  });

  test("capMixedRuleChecksForPublish applies the details clamp end to end", () => {
    const bigNoise = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const [c] = capMixedRuleChecksForPublish([failCheck({ details: bigNoise })], 500);
    expect(Object.keys(c!.details!).length).toBeLessThan(30);
  });
});
