// Rule-side half of "repeated subtree as component" (#2307).
//
// Rules run one page at a time, so they cannot know whether a block repeats.
// They emit an ancestor LADDER and stay uncertain; the report stage promotes.
// This file pins the ladder and the fact that the occurrence is unchanged.
// Promotion itself is pinned in packages/report/tests/repeated-subtree-promotion.test.ts.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";
import type { Element } from "linkedom";

import { ComponentOccurrenceCache, componentOccurrence } from "../src/shared/component-occurrence";
import type { ComponentOccurrence } from "@squirrelscan/core-contracts";

const ORIGIN = "https://example.test";

/**
 * The real shared block: a heading plus one row per platform, each row ending
 * in a generic "Download" link. Only the surrounding page content changes.
 */
function downloadBlock(version: string): string {
  const platforms = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "windows-x64"];
  const rows = platforms
    .map(
      (platform) =>
        `<div class="flex items-center justify-between p-3">` +
        `<div><div class="font-medium">${platform}</div>` +
        `<div class="text-sm text-muted-foreground">squirrel-${version}-${platform}</div></div>` +
        `<a class="inline-flex items-center px-4 py-2 bg-primary" ` +
        `href="https://downloads.example.test/v${version}/squirrel-${version}-${platform}">Download</a>` +
        `</div>`,
    )
    .join("");
  return `<div class="space-y-4"><h2 class="text-lg">Downloads</h2><div class="grid">${rows}</div></div>`;
}

/** A page whose primary content differs while the shared block stays put. */
function releasePage(version: string, prose: string): string {
  return (
    `<main><section class="py-10"><div class="container">` +
    `<h1>Release ${version}</h1><p>${prose}</p>` +
    downloadBlock(version) +
    `</div></section></main>`
  );
}

function occurrencesFor(pages: Array<{ url: string; body: string }>): ComponentOccurrence[] {
  const out: ComponentOccurrence[] = [];
  for (const page of pages) {
    const { document } = parseHTML(`<html><body>${page.body}</body></html>`);
    const cache = new ComponentOccurrenceCache();
    const links = Array.from(document.querySelectorAll("a")) as unknown as Element[];
    for (const link of links) {
      if ((link.textContent ?? "").trim().toLowerCase() !== "download") continue;
      out.push(
        componentOccurrence(
          {
            pageUrl: page.url,
            rendered: false,
            element: link,
            kind: "link-text-generic",
            values: { normalizedText: "download" },
          },
          cache,
        ),
      );
    }
  }
  return out;
}

/**
 * Family keys that span two or more distinct pages. This is the property the
 * fix must create for a shared block and must not create for per-page content:
 * it is what turns N page-shaped findings into one fix group.
 */
function crossPageFamilies(occurrences: ComponentOccurrence[]): Map<string, Set<string>> {
  const pagesByFamily = new Map<string, Set<string>>();
  for (const occurrence of occurrences) {
    const pages = pagesByFamily.get(occurrence.family.key) ?? new Set<string>();
    pages.add(occurrence.pageUrl);
    pagesByFamily.set(occurrence.family.key, pages);
  }
  return new Map([...pagesByFamily].filter(([, pages]) => pages.size >= 2));
}

describe("a block repeated inside <main> across pages is one component", () => {
  const pages = [
    { url: `${ORIGIN}/releases/1.0.1`, body: releasePage("1.0.1", "Signing fixes for macOS.") },
    { url: `${ORIGIN}/releases/1.0.2`, body: releasePage("1.0.2", "Crawler retries are bounded now.") },
    { url: `${ORIGIN}/releases/1.0.3`, body: releasePage("1.0.3", "Report output gained a summary.") },
    { url: `${ORIGIN}/releases/1.0.4`, body: releasePage("1.0.4", "Nothing but dependency bumps.") },
  ];

  test("the four pages really do differ outside the block", () => {
    // Guards the fixture: if the pages were identical the grouping below would
    // prove nothing, because any page-scoped key would already collapse.
    const mains = pages.map((page) => page.body.slice(0, page.body.indexOf("<div class=\"space-y-4\">")));
    expect(new Set(mains).size).toBe(4);
  });

  test("today every page becomes its own family, which is the defect", () => {
    const occurrences = occurrencesFor(pages);
    expect(occurrences).toHaveLength(20);
    expect(occurrences.every((occurrence) => occurrence.uncertainReason === "region-main")).toBe(true);
    // The structure IS recognised as the same; only the KEY is page-scoped.
    expect(new Set(occurrences.map((o) => o.family.structuralSignature)).size).toBe(1);
    expect(new Set(occurrences.map((o) => o.family.key)).size).toBe(4);
  });

  test("each occurrence carries an ancestor ladder the report stage can promote", () => {
    const occurrences = occurrencesFor(pages);
    const ladders = occurrences.map((occurrence) => occurrence.subtreeCandidates ?? []);
    expect(ladders.every((ladder) => ladder.length > 0)).toBe(true);
    // Level 1 is the parent; level 0 (the element) is deliberately absent,
    // because a candidate rooted at the faulty element can never match a
    // sibling defect in the same block.
    expect(ladders.every((ladder) => ladder[0]?.level === 1)).toBe(true);
    expect(ladders.every((ladder) => ladder.length <= 8)).toBe(true);
    for (const ladder of ladders) {
      expect(ladder.map((rung) => rung.level)).toEqual(
        Array.from({ length: ladder.length }, (_, index) => index + 1),
      );
      for (const rung of ladder) {
        expect(rung.textShareOfRegion).toBeGreaterThanOrEqual(0);
        expect(rung.textShareOfRegion).toBeLessThanOrEqual(1);
        // Two decimal places, so a rounding difference cannot split a rung.
        expect(Math.round(rung.textShareOfRegion * 100) / 100).toBe(rung.textShareOfRegion);
        expect(rung.locatorFromRoot.endsWith("a:1")).toBe(true);
      }
    }
  });

  test("the block's own rung has the same skeleton and slot on every page", () => {
    const occurrences = occurrencesFor(pages);
    // The block root is the highest rung shared by all four pages.
    const perPage = new Map<string, Set<string>>();
    for (const occurrence of occurrences)
      for (const rung of occurrence.subtreeCandidates ?? []) {
        const pagesFor = perPage.get(rung.skeletonSignature) ?? new Set<string>();
        pagesFor.add(occurrence.pageUrl);
        perPage.set(rung.skeletonSignature, pagesFor);
      }
    const shared = [...perPage.values()].filter((pagesFor) => pagesFor.size === 4);
    expect(shared.length).toBeGreaterThan(0);

    // The first button's slot is identical across pages, which is what lets the
    // report stage line up the same repair target on each one.
    const firsts = pages.map(
      (page) =>
        occurrences.find((occurrence) => occurrence.pageUrl === page.url)!.subtreeCandidates!,
    );
    const topSlots = firsts.map((ladder) => ladder[ladder.length - 1]!.locatorFromRoot);
    expect(new Set(topSlots).size).toBe(1);
  });

  test("the ladder is emitted only for the region-main case", () => {
    // A footer link is a landmark component the rule can already judge; adding a
    // ladder there would be a second, weaker identity for the same element.
    const { document } = parseHTML(
      `<html><body><footer><a href="/x">Download</a></footer></body></html>`,
    );
    const link = document.querySelector("a") as unknown as Element;
    const occurrence = componentOccurrence(
      {
        pageUrl: `${ORIGIN}/p`,
        rendered: false,
        element: link,
        kind: "link-text-generic",
        values: { normalizedText: "download" },
      },
      new ComponentOccurrenceCache(),
    );
    expect(occurrence.groupable).toBe(true);
    expect(occurrence.subtreeCandidates).toBeUndefined();
  });
});

describe("repetition that is data, not a shared component, must not group", () => {
  test("a card grid on one page stays one page's problem", () => {
    // Six cards, one page. A component candidate must recur across PAGES; a
    // subtree repeated only within a page is a list, and its link texts are
    // authored per card, so there is no single template fix.
    const cards = Array.from(
      { length: 6 },
      (_, index) =>
        `<article class="card"><h3>Item ${index}</h3>` +
        `<a class="card-link" href="/item/${index}">Download</a></article>`,
    ).join("");
    const occurrences = occurrencesFor([
      { url: `${ORIGIN}/catalogue`, body: `<main><section class="grid">${cards}</section></main>` },
    ]);
    expect(occurrences).toHaveLength(6);
    expect(crossPageFamilies(occurrences).size).toBe(0);
  });

  test("a blog index's article list is the page's primary content, not a component", () => {
    // The list skeleton recurs on three pages, so a "recurs on >= 3 pages" rule
    // alone would merge it. It must be excluded because it covers essentially
    // all of <main>: the defect is in each post's link text, not in a template.
    const listPage = (posts: string[]) =>
      `<main><section class="posts">` +
      posts
        .map((post) => `<article class="post"><h3>${post}</h3><a href="/p/${post}">Download</a></article>`)
        .join("") +
      `</section></main>`;
    const occurrences = occurrencesFor([
      { url: `${ORIGIN}/blog`, body: listPage(["alpha", "beta", "gamma"]) },
      { url: `${ORIGIN}/blog/page/2`, body: listPage(["delta", "epsilon", "zeta"]) },
      { url: `${ORIGIN}/blog/page/3`, body: listPage(["eta", "theta", "iota"]) },
    ]);
    expect(occurrences).toHaveLength(9);
    expect(crossPageFamilies(occurrences).size).toBe(0);
  });

  test("a block seen on only two pages is below the recurrence floor", () => {
    const pages = [
      { url: `${ORIGIN}/releases/2.0.1`, body: releasePage("2.0.1", "First of two.") },
      { url: `${ORIGIN}/releases/2.0.2`, body: releasePage("2.0.2", "Second of two.") },
    ];
    // Two pages is a coincidence budget, not evidence of a shared template.
    expect(crossPageFamilies(occurrencesFor(pages)).size).toBe(0);
  });
});

describe("depth inside a block does not decide which component it belongs to", () => {
  /**
   * One menu, two links, nested three levels apart. A ladder that only walked
   * upward from the element ran out of budget for the deeper link and promoted
   * it at an inner wrapper, so one menu became two components with two root
   * keys (observed on a real theme: 6 groups at `div.main`, 2 at its parent).
   */
  function menuPage(page: string): string {
    const shallow = `<div class="col"><a href="/a-${page}"></a></div>`;
    const deep = `<div class="col"><div><div><div><a href="/b-${page}"></a></div></div></div></div>`;
    return `<body><div class="wrap"><div class="main"><nav-block class="menu">${shallow}${deep}</nav-block></div></div><p>${page}</p></body>`;
  }

  test("two links three levels apart share one promoted root", () => {
    const pages = ["p1", "p2", "p3", "p4"].map((page) => ({
      url: `${ORIGIN}/${page}`,
      body: menuPage(page),
    }));
    const occurrences = pages.flatMap((page) => {
      const { document } = parseHTML(`<html>${page.body}</html>`);
      const cache = new ComponentOccurrenceCache();
      return (Array.from(document.querySelectorAll("a")) as unknown as Element[]).map((link) =>
        componentOccurrence(
          {
            pageUrl: page.url,
            rendered: false,
            element: link,
            kind: "link-text-empty",
            values: { normalizedText: "" },
            },
          cache,
        ),
      );
    });
    expect(occurrences).toHaveLength(8);
    // Both depths reach the same outer rungs, so they share a skeleton.
    const shared = new Set(
      occurrences
        .filter((occurrence) => occurrence.pageUrl === `${ORIGIN}/p1`)
        .map((occurrence) =>
          (occurrence.subtreeCandidates ?? []).map((rung) => rung.skeletonSignature).join("|"),
        ),
    );
    expect(shared.size).toBe(2);
    const [first, second] = [...shared].map((value) => new Set(value.split("|")));
    const overlap = [...first!].filter((value) => second!.has(value));
    expect(overlap.length).toBeGreaterThan(0);
  });
});

describe("a component root says what it is, or says nothing", () => {
  function hintFor(body: string): Record<string, unknown> | undefined {
    const { document } = parseHTML(`<html>${body}</html>`);
    const link = document.querySelector("a") as unknown as Element;
    const occurrence = componentOccurrence(
      {
        pageUrl: `${ORIGIN}/p`,
        rendered: false,
        element: link,
        kind: "link-text-generic",
        values: { normalizedText: "download" },
      },
      new ComponentOccurrenceCache(),
    );
    const rungs = occurrence.subtreeCandidates ?? [];
    return rungs.map((rung) => rung.rootHint).find(Boolean) as Record<string, unknown> | undefined;
  }

  test("uses a heading inside the root", () => {
    expect(hintFor(`<body><main><section><h2>Install squirrel</h2><div><a href="/d">Download</a></div></section></main></body>`))
      .toMatchObject({ heading: "Install squirrel" });
  });

  test("uses aria-label and a word-shaped id when there is no heading", () => {
    const hint = hintFor(`<body><main><section id="install-panel" aria-label="Install options"><div><a href="/d">Download</a></div></section></main></body>`);
    expect(hint).toMatchObject({ ariaLabel: "Install options", id: "install-panel" });
  });

  test("drops a generated id rather than showing it", () => {
    // `sp-ppork3` is a real theme's id: a digit-count rule accepted it and it
    // tells a reader nothing.
    const hint = hintFor(`<body><main><section id="sp-ppork3"><div><a href="/d">Download</a></div></section></main></body>`);
    expect(hint?.id).toBeUndefined();
  });

  test("never borrows a heading from outside the root", () => {
    // The fallback to a PRECEDING heading labelled a sticky product bar
    // "Recent post" on a real storefront. A wrong label is worse than none.
    const hint = hintFor(`<body><main><h2>Recent post</h2><section><div><a href="/d">Download</a></div></section></main></body>`);
    expect(hint).toBeUndefined();
  });

  test("drops text that carries an address, a number or a link", () => {
    for (const heading of ["Mail us at sales@example.test", "Call +1 555 0134 now", "See https://example.test/x"])
      expect(hintFor(`<body><main><section><h2>${heading}</h2><div><a href="/d">Download</a></div></section></main></body>`))
        .toBeUndefined();
  });

  test("bounds a long heading", () => {
    const hint = hintFor(`<body><main><section><h2>${"word ".repeat(40)}</h2><div><a href="/d">Download</a></div></section></main></body>`);
    expect(String(hint?.heading).length).toBeLessThanOrEqual(60);
  });
});
