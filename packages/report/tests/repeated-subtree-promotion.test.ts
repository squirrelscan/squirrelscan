// Report-side half of "repeated subtree as component" (#2307).
//
// Rules emit an ancestor ladder for elements inside <main> and stay uncertain.
// This stage sees every page and promotes the highest ancestor level whose
// skeleton recurs on enough pages, with a text-share guard that keeps a page's
// own content out. Everything here is about what must NOT be promoted as much
// as what must.

import { describe, expect, test } from "bun:test";
import type { ComponentOccurrence, SubtreeCandidate } from "@squirrelscan/core-contracts";

import { componentFixGroups } from "../src/component-fix-groups";
import type { CheckResult } from "../src/types";

const ORIGIN = "https://example.test";
const RULE = "a11y/link-text";

/** A region-main occurrence exactly as the rule emits it: never groupable. */
function occurrence(options: {
  page: string;
  slot: string;
  destination?: string;
  text?: string;
  ladder: Array<[level: number, skeleton: string, share: number]>;
}): ComponentOccurrence {
  const subtreeCandidates: SubtreeCandidate[] = options.ladder.map(([level, skeleton, share]) => ({
    level,
    skeletonSignature: `s128:${skeleton}`,
    locatorFromRoot: options.slot,
    textShareOfRegion: share,
  }));
  return {
    version: 1,
    pageUrl: `${ORIGIN}${options.page}`,
    siteOrigin: ORIGIN,
    provenance: { source: "page-dom", rendered: false },
    groupable: false,
    confidence: "uncertain",
    uncertainReason: "region-main",
    region: { role: "main", nestedIn: "none", structuralSignature: `s128:region-${options.page}` },
    family: { key: `page:${options.page}`, structuralSignature: "s128:family" },
    variant: {
      key: `page:${options.page}`,
      structuralSignature: "s128:variant",
      contentHash: `s128:content-${options.page}`,
    },
    element: { locator: `main>${options.slot}`, structuralSignature: "s128:element" },
    defect: {
      kind: "link-text-generic",
      values: { nameSource: "text", normalizedText: options.text ?? "download" },
      valueHashes: { destination: `s128:${options.destination ?? options.page}` },
    },
    subtreeCandidates,
  };
}

function check(occurrences: ComponentOccurrence[]): CheckResult {
  return {
    name: "link-text-generic",
    status: "warn",
    message: "generic link text",
    componentOccurrences: occurrences,
  } as CheckResult;
}

function groupsFor(occurrences: ComponentOccurrence[]) {
  return componentFixGroups(RULE, [check(occurrences)]);
}

/** The real shape: a block whose rungs repeat, below half of main's text. */
function blockLadder(slot: string, page: string) {
  return occurrence({
    page,
    slot,
    ladder: [
      [1, "row", 0.05],
      [2, "grid", 0.2],
      [3, "block", 0.31],
    ],
  });
}

/**
 * The same block on a page that is essentially nothing else — squirrelscan.com's
 * /download, where it measured 0.64 of main. Every rung breaches, because a page
 * that IS the block is mostly the block at each level. Breaching only the top
 * rung would leave a lower one eligible and the page would still join.
 */
function guardedBlockLadder(slot: string, page: string) {
  return occurrence({
    page,
    slot,
    ladder: [
      [1, "row", 0.55],
      [2, "grid", 0.62],
      [3, "block", 0.64],
    ],
  });
}

describe("a block repeated inside <main> is promoted to one component", () => {
  const pages = ["/releases/1.0.1", "/releases/1.0.2", "/releases/1.0.3", "/releases/1.0.4"];

  test("the same slot across four pages becomes one repeated-subtree group", () => {
    const groups = groupsFor(pages.map((page) => blockLadder("div:1>a:1", page)));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.attribution).toBe("repeated-subtree");
    expect(groups[0]?.affectedPageCount).toBe(4);
    expect(groups[0]?.affectedPages).toEqual(pages.map((page) => `${ORIGIN}${page}`));
  });

  test("the highest recurring level wins, so the repair target is the whole block", () => {
    const groups = groupsFor(pages.map((page) => blockLadder("div:1>a:1", page)));
    // Level 3 ("block") recurs on all four pages and is the highest such rung.
    expect(groups[0]?.semanticSlot).toBe("div:1>a:1");
    expect(groups[0]?.occurrences).toHaveLength(4);
  });

  test("distinct slots in the same block stay distinct repair targets", () => {
    // Seven buttons in one block are seven things to fix, not one.
    const occurrences = pages.flatMap((page) => [
      blockLadder("div:1>a:1", page),
      blockLadder("div:2>a:1", page),
    ]);
    const groups = groupsFor(occurrences);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.attribution === "repeated-subtree")).toBe(true);
    expect(groups.every((group) => group.affectedPageCount === 4)).toBe(true);
  });

  test("per-page data on the same slot does not split the group", () => {
    // The download button's href changes on every release page. That is what a
    // shared block is expected to vary, so it must not be part of identity.
    const occurrences = pages.map((page) =>
      occurrence({
        page,
        slot: "div:1>a:1",
        destination: `href-${page}`,
        ladder: [
          [1, "row", 0.05],
          [2, "block", 0.31],
        ],
      }),
    );
    expect(groupsFor(occurrences)).toHaveLength(1);
  });

  test("the promoted occurrences are still the uncertain evidence the rule emitted", () => {
    const groups = groupsFor(pages.map((page) => blockLadder("div:1>a:1", page)));
    expect(groups[0]?.occurrences.every((item) => item.groupable === false)).toBe(true);
    expect(groups[0]?.occurrences.every((item) => item.confidence === "uncertain")).toBe(true);
    expect(groups[0]?.occurrences.every((item) => item.uncertainReason === "region-main")).toBe(true);
    // The region is still main, which is what a renderer phrases as a repeated
    // block in main content rather than a landmark component.
    expect(groups[0]?.region.role).toBe("main");
  });

  test("the result does not depend on the order pages arrive in", () => {
    const forward = pages.map((page) => blockLadder("div:1>a:1", page));
    const reversed = [...forward].reverse();
    const shuffled = [forward[2]!, forward[0]!, forward[3]!, forward[1]!];
    const ids = [forward, reversed, shuffled].map((order) =>
      groupsFor(order).map((group) => `${group.id}|${group.affectedPages.join(",")}`),
    );
    expect(ids[1]).toEqual(ids[0]!);
    expect(ids[2]).toEqual(ids[0]!);
  });
});

describe("repetition that is data, not a shared component, is not promoted", () => {
  test("a card grid on one page never reaches the page floor", () => {
    const occurrences = Array.from({ length: 6 }, (_, index) =>
      occurrence({
        page: "/catalogue",
        slot: `article:${index + 1}>a:1`,
        ladder: [
          [1, "card", 0.1],
          [2, "grid", 0.4],
        ],
      }),
    );
    expect(groupsFor(occurrences)).toHaveLength(0);
  });

  test("a card grid repeated across pages keeps its per-card slots apart", () => {
    // Same skeleton on four pages, but each card is a different slot AND a
    // different link text: the defect is the data, so nothing merges.
    const occurrences = ["/shop/1", "/shop/2", "/shop/3", "/shop/4"].flatMap((page, pageIndex) =>
      Array.from({ length: 3 }, (_, index) =>
        occurrence({
          page,
          slot: `article:${index + 1}>a:1`,
          text: `download item ${pageIndex}-${index}`,
          ladder: [
            [1, "card", 0.1],
            [2, "grid", 0.4],
          ],
        }),
      ),
    );
    expect(groupsFor(occurrences)).toHaveLength(0);
  });

  test("a blog index's article list is the page's own content", () => {
    // Two things keep it out, and the test pins both. The list rung recurs on
    // every index page but IS the page content, so the guard rejects it; the
    // post rung passes the guard but is a different post on each page, so its
    // defect text differs and the scopes never meet.
    const occurrences = ["/blog", "/blog/page/2", "/blog/page/3"].map((page, index) =>
      occurrence({
        page,
        slot: "article:1>a:1",
        text: `download the ${index} report`,
        ladder: [
          [1, "post", 0.3],
          [2, "list", 0.98],
        ],
      }),
    );
    expect(groupsFor(occurrences)).toHaveLength(0);
  });

  test("the guard is what rejects the list rung, not the page count", () => {
    // Same three pages and the same repeated text; only the list's share moves.
    const ladderFor = (share: number) =>
      ["/blog", "/blog/page/2", "/blog/page/3"].map((page) =>
        occurrence({
          page,
          slot: "article:1>a:1",
          ladder: [
            [1, "post", 0.3],
            [2, "list", share],
          ],
        }),
      );
    // Below the guard the list rung wins, because it is the highest that recurs.
    expect(groupsFor(ladderFor(0.4))).toHaveLength(1);
    // Above it the list rung is rejected and the smaller post rung is left.
    const guarded = groupsFor(ladderFor(0.98));
    expect(guarded).toHaveLength(1);
    expect(guarded[0]?.semanticSlot).toBe("article:1>a:1");
  });

  test("pagination controls repeated on every index page are not a fix-once claim", () => {
    // Each page's pager links to different numbers, so the slots differ even
    // though the strip's skeleton recurs.
    const occurrences = ["/blog", "/blog/page/2", "/blog/page/3", "/blog/page/4"].map(
      (page, index) =>
        occurrence({
          page,
          slot: `a:${index + 1}`,
          text: "next",
          ladder: [
            [1, "pager", 0.04],
            [2, "list", 0.97],
          ],
        }),
    );
    expect(groupsFor(occurrences)).toHaveLength(0);
  });

  test("a block on exactly two pages is below the recurrence floor", () => {
    const occurrences = ["/releases/2.0.1", "/releases/2.0.2"].map((page) =>
      blockLadder("div:1>a:1", page),
    );
    expect(groupsFor(occurrences)).toHaveLength(0);
  });

  test("three pages where one breaches the text-share guard leaves only two", () => {
    // /download renders the same block as its whole page. It fails the guard,
    // so it does not join and the remaining two are below the floor.
    const occurrences = [
      blockLadder("div:1>a:1", "/releases/3.0.1"),
      blockLadder("div:1>a:1", "/releases/3.0.2"),
      guardedBlockLadder("div:1>a:1", "/download"),
    ];
    expect(groupsFor(occurrences)).toHaveLength(0);
  });

  test("a guarded page does not join a group that forms without it", () => {
    const occurrences = [
      blockLadder("div:1>a:1", "/releases/4.0.1"),
      blockLadder("div:1>a:1", "/releases/4.0.2"),
      blockLadder("div:1>a:1", "/releases/4.0.3"),
      guardedBlockLadder("div:1>a:1", "/download"),
    ];
    const groups = groupsFor(occurrences);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.affectedPages).not.toContain(`${ORIGIN}/download`);
    expect(groups[0]?.affectedPageCount).toBe(3);
  });
});

describe("evidence written before the ladder existed still reads", () => {
  test("region-main rows with no candidates are left page-scoped", () => {
    const legacy = ["/a", "/b", "/c", "/d"].map((page) => {
      const row = blockLadder("div:1>a:1", page);
      delete (row as { subtreeCandidates?: unknown }).subtreeCandidates;
      return row;
    });
    expect(groupsFor(legacy)).toHaveLength(0);
  });

  test("an empty candidate list is treated as no candidates", () => {
    const empty = ["/a", "/b", "/c"].map((page) => ({
      ...blockLadder("div:1>a:1", page),
      subtreeCandidates: [],
    }));
    expect(groupsFor(empty)).toHaveLength(0);
  });
});

describe("componentRootKey identifies the block, not the slot inside it", () => {
  const pages = ["/releases/1.0.1", "/releases/1.0.2", "/releases/1.0.3", "/releases/1.0.4"];

  /** One block, `slots` broken links inside it, on every page. */
  function installBlock(slots: number, skeleton = "block") {
    return pages.flatMap((page) =>
      Array.from({ length: slots }, (_, index) =>
        occurrence({
          page,
          slot: `div:${index + 1}>a:1`,
          ladder: [
            [1, `row-${skeleton}`, 0.05],
            [2, skeleton, 0.31],
          ],
        }),
      ),
    );
  }

  test("seven links in one install block are seven groups with ONE root key", () => {
    const groups = groupsFor(installBlock(7));
    expect(groups).toHaveLength(7);
    // Seven repair targets, because each link is separately wrong...
    expect(new Set(groups.map((group) => group.semanticSlot)).size).toBe(7);
    // ...but one thing to go and look at.
    expect(new Set(groups.map((group) => group.componentRootKey)).size).toBe(1);
    expect(groups.every((group) => group.componentRootKey.startsWith("component-root:"))).toBe(true);
    expect(groups.every((group) => group.affectedPageCount === 4)).toBe(true);
  });

  test("two different blocks on the same pages keep two root keys", () => {
    const groups = groupsFor([...installBlock(2, "install"), ...installBlock(2, "support")]);
    expect(groups).toHaveLength(4);
    const keys = new Set(groups.map((group) => group.componentRootKey));
    expect(keys.size).toBe(2);
    // Each block keeps its own slots; the key does not merge them.
    for (const key of keys) {
      const members = groups.filter((group) => group.componentRootKey === key);
      expect(members).toHaveLength(2);
    }
  });

  test("the key is stable under page order", () => {
    const forward = installBlock(3);
    const reversed = [...forward].reverse();
    const shuffled = forward.filter((_, index) => index % 2 === 0).concat(
      forward.filter((_, index) => index % 2 === 1),
    );
    const keysFor = (order: typeof forward) =>
      groupsFor(order)
        .map((group) => `${group.componentRootKey}|${group.semanticSlot}`)
        .sort();
    expect(keysFor(reversed)).toEqual(keysFor(forward));
    expect(keysFor(shuffled)).toEqual(keysFor(forward));
  });

  test("an observed landmark group is rooted on its region, not on a subtree", () => {
    // Two slots in one footer: the rule already judged them, so the root key
    // comes from the landmark identity and still collapses to one block.
    const footer = (page: string, slot: string): ComponentOccurrence => ({
      // One constant destination: an observed group's identity includes the
      // defect hashes, so a per-page href would split it for the wrong reason.
      ...occurrence({ page, slot, destination: "footer-legal", ladder: [[1, "row", 0.05]] }),
      groupable: true,
      confidence: "observed",
      uncertainReason: undefined,
      region: { role: "footer", nestedIn: "none", structuralSignature: "s128:footer" },
      family: { key: "s128:footer-family", structuralSignature: "s128:ff" },
      variant: { key: "s128:footer-variant", structuralSignature: "s128:fv", contentHash: "s128:fc" },
      element: { locator: `footer>${slot}`, structuralSignature: `s128:el-${slot}` },
      subtreeCandidates: undefined,
    });
    const groups = groupsFor(
      pages.flatMap((page) => [footer(page, "a:1"), footer(page, "a:2")]),
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.attribution === "observed-component-evidence")).toBe(true);
    expect(new Set(groups.map((group) => group.componentRootKey)).size).toBe(1);
  });

  test("a promoted block and an observed footer never share a root key", () => {
    const groups = groupsFor(installBlock(2));
    const observed = groupsFor([]);
    expect(groups.length).toBeGreaterThan(0);
    expect(observed).toHaveLength(0);
    // Attribution is part of what a caller keys on, but the root keys are
    // derived from disjoint identities and must not collide by construction.
    const promotedKey = groups[0]!.componentRootKey;
    expect(promotedKey).toMatch(/^component-root:[0-9a-f]{32}$/);
  });
});

describe("componentFamilyKey rolls variants of one landmark together", () => {
  const pages = ["/a", "/b", "/c", "/d"];

  /** The same nav, rendered in two variants across page templates. */
  function navLink(page: string, variant: string, slot: string): ComponentOccurrence {
    return {
      ...occurrence({ page, slot, destination: "login", text: "log in", ladder: [[1, "row", 0.05]] }),
      groupable: true,
      confidence: "observed",
      uncertainReason: undefined,
      region: { role: "navigation", nestedIn: "none", structuralSignature: `s128:region-${variant}` },
      family: { key: "s128:nav-family", structuralSignature: "s128:nf" },
      variant: { key: `s128:nav-variant-${variant}`, structuralSignature: `s128:nv-${variant}`, contentHash: `s128:nc-${variant}` },
      element: { locator: `nav>${slot}`, structuralSignature: "s128:el" },
      subtreeCandidates: undefined,
    };
  }

  test("two variants of one nav are two groups with one family key", () => {
    const groups = componentFixGroups(RULE, [
      check([
        ...pages.slice(0, 2).map((page) => navLink(page, "wide", "a:1")),
        ...pages.slice(2).map((page) => navLink(page, "narrow", "a:1")),
      ]),
    ]);
    expect(groups).toHaveLength(2);
    // Two variants: two root keys, because the region structure really differs.
    expect(new Set(groups.map((group) => group.componentRootKey)).size).toBe(2);
    // One nav: one family key, which is what a "(2 variants)" line keys on.
    expect(new Set(groups.map((group) => group.componentFamilyKey)).size).toBe(1);
    expect(groups.every((group) => group.componentFamilyKey.startsWith("component-family:"))).toBe(true);
  });

  test("a different landmark keeps a different family key", () => {
    const groups = componentFixGroups(RULE, [
      check([
        ...pages.map((page) => navLink(page, "wide", "a:1")),
        ...pages.map((page) => ({
          ...navLink(page, "wide", "a:1"),
          region: { role: "footer" as const, nestedIn: "none" as const, structuralSignature: "s128:foot" },
          family: { key: "s128:footer-family", structuralSignature: "s128:ff" },
          element: { locator: "footer>a:1", structuralSignature: "s128:el2" },
        })),
      ]),
    ]);
    expect(new Set(groups.map((group) => group.componentFamilyKey)).size).toBe(2);
  });

  test("a promoted group's family key is its root key", () => {
    const groups = groupsFor(pages.map((page) => blockLadder("div:1>a:1", page)));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.componentFamilyKey).toBe(groups[0]?.componentRootKey);
  });
});
