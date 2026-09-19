import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";
import { componentFixGroups } from "../../report/src/component-fix-groups";

import { linkTextRule } from "../src/a11y/link-text";
import { foldOverflowChecks, unfoldAggregateCheck } from "../src/fold";
import { ComponentOccurrenceCache, componentOccurrence } from "../src/shared/component-occurrence";
import type { CheckResult, ParsedPage, RuleContext } from "../src/types";

function run(html: string, pageUrl = "https://example.com/docs/") {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const ctx: RuleContext = {
    page: { url: pageUrl, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: {},
  };
  return linkTextRule.run(ctx).checks;
}

describe("linkTextRule component occurrences", () => {
  test("keeps distinct elements and hashes resolved destinations without exposing them", () => {
    const [check] = run(
      '<footer><a href="/pricing?token=private">Learn more</a><a href="/docs">Learn more</a></footer>',
    );
    expect(check?.message).toBe("2 link(s) with generic text");
    expect(check?.items).toEqual([{ id: "learn more" }]);
    expect(check?.componentOccurrences).toHaveLength(2);
    expect(check?.componentOccurrences?.map((occurrence) => occurrence.element.locator)).toEqual([
      "footer:1>footer>a:1",
      "footer:1>footer>a:2",
    ]);
    expect(check?.componentOccurrences?.[0]?.defect.values).toEqual({
      nameSource: "text",
      normalizedText: "learn more",
    });
    expect(check?.componentOccurrences?.[0]?.defect.valueHashes.destination).toMatch(/^s128:[0-9a-f]{32}$/);
    expect(JSON.stringify(check?.componentOccurrences)).not.toContain("token=private");
  });

  test("does not attribute an article header as site chrome", () => {
    const [check] = run('<article><header><a href="/docs">Learn more</a></header></article>');
    expect(check?.componentOccurrences?.[0]).toMatchObject({
      groupable: false,
      confidence: "uncertain",
      uncertainReason: "content-nested",
      region: { role: "header", nestedIn: "article" },
    });
  });

  test("records WHY an observation is uncertain instead of degrading in silence", () => {
    const noRegion = run('<div><a href="/docs">Learn more</a></div>')[0]!;
    expect(noRegion.componentOccurrences?.[0]).toMatchObject({
      groupable: false,
      confidence: "uncertain",
      uncertainReason: "no-region",
    });

    // A region larger than the skeleton budget is still a real observation; it
    // just cannot be matched structurally, and it has to say so.
    const huge = Array.from({ length: 400 }, (_, i) => `<span>${i}</span>`).join("");
    const truncated = run(`<footer>${huge}<a href="/docs">Learn more</a></footer>`)[0]!;
    expect(truncated.componentOccurrences?.[0]).toMatchObject({
      groupable: false,
      confidence: "uncertain",
      uncertainReason: "structure-truncated",
    });

    const clean = run('<footer><a href="/docs">Learn more</a></footer>')[0]!;
    expect(clean.componentOccurrences?.[0]?.confidence).toBe("observed");
    expect(clean.componentOccurrences?.[0]?.uncertainReason).toBeUndefined();
  });

  test("per-page nav state and per-page footer text do not split one component", () => {
    // Same footer, different active link and a per-page string in the text.
    const pageA = run(
      '<footer class="site-footer"><nav><a class="nav-link is-active" aria-current="page" href="/a">Home</a><a class="nav-link" href="/b">Docs</a></nav><p>Page 1 of 9</p><a href="/docs">Learn more</a></footer>',
      "https://example.com/a/",
    )[0]!;
    const pageB = run(
      '<footer class="site-footer"><nav><a class="nav-link" href="/a">Home</a><a class="nav-link is-active" aria-current="page" href="/b">Docs</a></nav><p>Page 7 of 9</p><a href="/docs">Learn more</a></footer>',
      "https://example.com/b/",
    )[0]!;
    const a = pageA.componentOccurrences!.at(-1)!;
    const b = pageB.componentOccurrences!.at(-1)!;
    expect(a.groupable).toBe(true);
    expect(a.family.key).toBe(b.family.key);
    expect(a.variant.key).toBe(b.variant.key);
    // The text still differs, and is still reported — it just no longer decides
    // whether these are the same component.
    expect(a.variant.contentHash).not.toBe(b.variant.contentHash);
    expect(componentFixGroups("a11y/link-text", [pageA, pageB])).toHaveLength(1);
  });

  test("family is stricter than a bare tag match", () => {
    const plain = run('<footer><a href="/docs">Learn more</a></footer>', "https://example.com/a/")[0]!;
    const different = run(
      '<footer><nav><span></span></nav><a href="/docs">Learn more</a></footer>',
      "https://example.com/b/",
    )[0]!;
    expect(plain.componentOccurrences![0]!.family.key).not.toBe(
      different.componentOccurrences!.at(-1)!.family.key,
    );
  });

  test("a component does not span two origins", () => {
    const a = run('<footer><a href="/docs">Learn more</a></footer>', "https://example.com/a/")[0]!;
    const b = run('<footer><a href="/docs">Learn more</a></footer>', "https://other.example/a/")[0]!;
    expect(a.componentOccurrences![0]!.family.key).not.toBe(b.componentOccurrences![0]!.family.key);
    expect(componentFixGroups("a11y/link-text", [a, b])).toHaveLength(2);
  });

  test("uses the first valid HTTP(S) base to hash the actual link destination", () => {
    const pageA = run(
      '<base href="https://example.com/docs/"><base href="https://ignored.example/"><footer><a href="guide">Learn more</a></footer>',
    )[0]!;
    const pageB = run(
      '<base href="https://example.com/pricing/"><footer><a href="guide">Learn more</a></footer>',
    )[0]!;
    const equivalent = run(
      '<base href="/docs/"><footer><a href="guide">Learn more</a></footer>',
      "https://example.com/another-page/",
    )[0]!;
    expect(pageA.componentOccurrences?.[0]?.defect.valueHashes.destination).not.toBe(
      pageB.componentOccurrences?.[0]?.defect.valueHashes.destination,
    );
    expect(pageA.componentOccurrences?.[0]?.defect.valueHashes.destination).toBe(
      equivalent.componentOccurrences?.[0]?.defect.valueHashes.destination,
    );
  });

  test("keeps responsive, locale, and semantic region variants separate", () => {
    const desktop = run(
      '<footer class="desktop-only"><a href="/docs">Learn more</a></footer>',
      "https://example.com/desktop/",
    )[0]!.componentOccurrences![0]!;
    const mobile = run(
      '<footer class="mobile-only"><a href="/docs">Learn more</a></footer>',
      "https://example.com/mobile/",
    )[0]!.componentOccurrences![0]!;
    const localized = run(
      '<footer class="desktop-only" lang="fr" dir="ltr"><a href="/docs">Learn more</a></footer>',
      "https://example.com/fr/",
    )[0]!.componentOccurrences![0]!;
    const semantic = run(
      '<footer class="desktop-only" aria-label="Secondary footer"><a href="/docs">Learn more</a></footer>',
      "https://example.com/secondary/",
    )[0]!.componentOccurrences![0]!;
    for (const variant of [mobile, localized, semantic]) {
      expect(variant.variant.key).not.toBe(desktop.variant.key);
      expect(variant.region.structuralSignature).not.toBe(desktop.region.structuralSignature);
    }
    expect(JSON.stringify([desktop, mobile, localized, semantic])).not.toContain("desktop-only");
    expect(JSON.stringify([desktop, mobile, localized, semantic])).not.toContain(
      "Secondary footer",
    );
  });

  test("folding and unfolding retain each page's component evidence", () => {
    const check = run('<footer><a href="/docs">Learn more</a></footer>')[0]!;
    const secondPage = "https://example.com/pricing/";
    const folded = foldOverflowChecks(
      [
        { ...check, pageUrl: "https://example.com/docs/" },
        {
          ...check,
          pageUrl: secondPage,
          componentOccurrences: check.componentOccurrences?.map((occurrence) => ({
            ...occurrence,
            pageUrl: secondPage,
          })),
        },
      ],
      { maxChecks: 1, maxItemsPerCheck: 10, maxPagesPerCheck: 10, maxSourcePagesPerItem: 10 },
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]?.componentOccurrences).toHaveLength(2);
    expect(
      unfoldAggregateCheck(folded[0]!).map((item) => item.componentOccurrences?.[0]?.pageUrl),
    ).toEqual(["https://example.com/docs/", secondPage]);
  });

  test("unfolding never invents a row for a page outside the bounded page sample", () => {
    const check = run('<footer><a href="/docs">Learn more</a></footer>')[0]!;
    const pages = ["https://example.com/a/", "https://example.com/b/", "https://example.com/c/"];
    const folded = foldOverflowChecks(
      pages.map((pageUrl) => ({
        ...check,
        pageUrl,
        componentOccurrences: check.componentOccurrences?.map((occurrence) => ({
          ...occurrence,
          pageUrl,
        })),
      })),
      { maxChecks: 1, maxItemsPerCheck: 10, maxPagesPerCheck: 1, maxSourcePagesPerItem: 10 },
    )[0]!;
    expect(folded.pages).toHaveLength(1);
    expect(folded.componentOccurrences).toHaveLength(3);

    const unfolded = unfoldAggregateCheck(folded);
    // The fold recorded ONE page, so unfolding rebuilds exactly one row. A row
    // for b/ or c/ would be a finding this audit never recorded, and the scorer
    // keys its density penalty on (name,pageUrl).
    expect(unfolded.map((item) => item.pageUrl)).toEqual(folded.pages);
    expect(unfolded[0]!.componentOccurrences?.map((o) => o.pageUrl)).toEqual([pages[0]]);
    // The two unplaceable observations are reported, not dropped in silence.
    expect(unfolded[0]!.componentEvidence).toEqual({
      state: "omitted",
      reason: "page-sample-limit",
      occurrenceCount: 2,
    });
    expect(folded.details?.occurrences).toBe(3);
  });

  test("unfolding preserves row order, count and the first-page `additional` stamp", () => {
    const check = run('<footer><a href="/docs">Learn more</a></footer>')[0]!;
    // Deliberately NOT alphabetical: a sort would move both the rows and the
    // `additional` stamp that the scorer reads off the first one.
    const pages = ["https://example.com/z/", "https://example.com/a/", "https://example.com/m/"];
    const folded: CheckResult = {
      ...check,
      pageUrl: undefined,
      pages,
      details: { ...check.details, aggregated: true, additional: 7 },
      componentOccurrences: pages.map((pageUrl) => ({
        ...check.componentOccurrences![0]!,
        pageUrl,
      })),
    };
    const unfolded = unfoldAggregateCheck(folded);
    expect(unfolded.map((item) => item.pageUrl)).toEqual(pages);
    expect(unfolded[0]!.details?.additional).toBe(7);
    expect(unfolded.slice(1).every((item) => item.details?.additional === undefined)).toBe(true);
    expect(unfolded.every((item) => item.componentEvidence === undefined)).toBe(true);
    expect(unfolded.map((item) => item.componentOccurrences?.[0]?.pageUrl)).toEqual(pages);
  });

  test("caches shared-region traversal for repeated bad links within one rule run", () => {
    const { document } = parseHTML(
      `<html><body><footer>${Array.from({ length: 50 }, (_, i) => `<a href="/${i}">Learn more</a>`).join("")}</footer></body></html>`,
    );
    const cache = new ComponentOccurrenceCache();
    const links = [...document.querySelectorAll("a")] as Element[];
    const occurrences = links.map((element) =>
      componentOccurrence(
        {
          pageUrl: "https://example.com/",
          rendered: false,
          element,
          kind: "link-text-generic",
          values: { nameSource: "text", normalizedText: "learn more" },
          sensitiveValues: { destination: element.getAttribute("href")! },
        },
        cache,
      ),
    );
    expect(cache.regionBuilds).toBe(1);
    expect(new Set(occurrences.map((occurrence) => occurrence.family.key)).size).toBe(1);
  });

  test("keeps locator identities while indexing a wide sibling list once", () => {
    const { document } = parseHTML(
      `<html><body><footer>${Array.from({ length: 1_000 }, (_, i) => `<a href="/${i}">Learn more</a>`).join("")}</footer></body></html>`,
    );
    const cache = new ComponentOccurrenceCache();
    const occurrences = ([...document.querySelectorAll("a")] as Element[]).map((element) =>
      componentOccurrence(
        {
          pageUrl: "https://example.com/",
          rendered: false,
          element,
          kind: "link-text-generic",
          values: { nameSource: "text", normalizedText: "learn more" },
          sensitiveValues: { destination: element.getAttribute("href")! },
        },
        cache,
      ),
    );
    expect(occurrences).toHaveLength(1_000);
    expect(occurrences[0]?.element.locator).toBe("footer:1>footer>a:1");
    expect(occurrences.at(-1)?.element.locator).toBe("footer:1>footer>a:1000");
    expect(cache.regionBuilds).toBe(1);
    expect(cache.siblingTagIndexBuilds).toBe(1);
  });

  test("uses the final observed origin for component identity while retaining source membership", () => {
    const occurrenceFor = (observedUrl: string) => {
      const { document } = parseHTML(
        '<html><body><footer><a href="/docs">Learn more</a></footer></body></html>',
      );
      return componentOccurrence({
        pageUrl: "https://source.example/redirect",
        observedUrl,
        rendered: false,
        element: document.querySelector("a")!,
        kind: "link-text-generic",
        values: { nameSource: "text", normalizedText: "learn more" },
        sensitiveValues: { destination: "https://source.example/docs" },
      });
    };
    const first = occurrenceFor("https://first-final.example/page");
    const second = occurrenceFor("https://second-final.example/page");
    expect(first.pageUrl).toBe("https://source.example/redirect");
    expect(second.pageUrl).toBe("https://source.example/redirect");
    expect(first.family.key).not.toBe(second.family.key);
  });

  test("scopes navigation identity and slots to enclosing header or footer composition", () => {
    const headerA = run(
      '<header><nav><a href="/docs">Learn more</a></nav></header>',
      "https://example.com/header-a/",
    )[0]!;
    const headerB = run(
      '<header><nav><a href="/docs">Learn more</a></nav></header>',
      "https://example.com/header-b/",
    )[0]!;
    const footerOnly = run(
      '<footer><nav><a href="/docs">Learn more</a></nav></footer>',
      "https://example.com/footer/",
    )[0]!;
    const footerAfterHeader = run(
      '<header><nav><a href="/account">Learn more</a></nav></header><footer><nav><a href="/docs">Learn more</a></nav></footer>',
      "https://example.com/layout/",
    )[0]!;
    const footerOccurrence = footerOnly.componentOccurrences![0]!;
    const footerAfterHeaderOccurrence = footerAfterHeader.componentOccurrences![1]!;

    expect(componentFixGroups(linkTextRule.meta.id, [headerA, headerB])).toHaveLength(1);
    expect(componentFixGroups(linkTextRule.meta.id, [headerA, footerOnly])).toHaveLength(2);
    expect(footerAfterHeaderOccurrence.family.key).toBe(footerOccurrence.family.key);
    expect(footerAfterHeaderOccurrence.element.locator).toBe(footerOccurrence.element.locator);
  });
});
