#!/usr/bin/env bun
/** Reproducible synthetic evaluation for #2307; exits non-zero on any mismatch. */
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import { parseHTML } from "../../packages/parser/src/dom.ts";
import { groupIssuesByCategory } from "../../packages/report/src/grouping.ts";
import {
  componentFixGroups,
  componentOccurrenceIdentity,
} from "../../packages/report/src/component-fix-groups.ts";
import { renderJson } from "../../packages/report/src/output/json.ts";
import { packComponentOccurrences } from "../../packages/core-contracts/src/component-evidence.ts";
import { staleCopyrightRule } from "../../packages/rules/src/content/stale-copyright.ts";
import { linkTextRule } from "../../packages/rules/src/a11y/link-text.ts";
import { foldOverflowChecks, unfoldAggregateCheck } from "../../packages/rules/src/fold.ts";
import { calculateHealthScore } from "../../packages/audit-engine/src/scoring.ts";
import type { CheckResult, ParsedPage, Rule, RuleContext } from "../../packages/rules/src/types.ts";

const BASELINE = "be239e8c3e1795ceeb7a79af1959d31abcd42643"; // pragma: allowlist secret
const root = resolve(import.meta.dir, "../..");
const WARMUPS = 2;
const REPEATS = 7;
type Page = { url: string; html: string };
type RuleName = "stale" | "link";
type ElementKey = `${string}#${string}:${string}`;
type Case = {
  id: string;
  rule: RuleName;
  pages: Page[];
  /** Exact groups, including singletons, keyed as pathname#locator:kind. */
  expectedGroups: ElementKey[][];
  /** Exact retained raw evidence which must not become an actionable group. */
  expectedUncertain: ElementKey[];
};

const cases: Case[] = [
  {
    id: "shared-footer-across-layouts",
    rule: "stale",
    pages: [
      {
        url: "https://example.invalid/home",
        html: "<main><h1>Home</h1></main><footer><p>© 2025 Example</p></footer>",
      },
      {
        url: "https://example.invalid/pricing",
        html: "<main><article><h1>Pricing</h1></article></main><footer><p>© 2025 Example</p></footer>",
      },
      {
        // A third, structurally different layout: enough pages that the
        // permutation check exercises more than just the reversed order.
        url: "https://example.invalid/docs",
        html: "<header><nav><a href='/'>Home</a></nav></header><main><section><h1>Docs</h1></section></main><footer><p>© 2025 Example</p></footer>",
      },
    ],
    expectedGroups: [
      [
        "/docs#footer:1>footer>p:1:stale-copyright",
        "/home#footer:1>footer>p:1:stale-copyright",
        "/pricing#footer:1>footer>p:1:stale-copyright",
      ],
    ],
    expectedUncertain: [],
  },
  {
    id: "class-and-language-footer-variants",
    rule: "stale",
    pages: [
      {
        url: "https://example.invalid/en",
        html: "<footer class='site-footer' lang='en'><p>© 2025 Example</p></footer>",
      },
      {
        url: "https://example.invalid/fr",
        html: "<footer class='pied-de-page' lang='fr'><p>© 2025 Example</p></footer>",
      },
    ],
    expectedGroups: [
      ["/en#footer:1>footer>p:1:stale-copyright"],
      ["/fr#footer:1>footer>p:1:stale-copyright"],
    ],
    expectedUncertain: [],
  },
  {
    id: "same-href-generic-text-different-elements",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/two-slots",
        html: "<footer><section><a href='/pricing'>Read more</a></section><div><a href='/pricing'>Read more</a></div></footer>",
      },
    ],
    expectedGroups: [
      ["/two-slots#footer:1>footer>div:1>a:1:link-text-generic"],
      ["/two-slots#footer:1>footer>section:1>a:1:link-text-generic"],
    ],
    expectedUncertain: [],
  },
  {
    id: "base-href-target-split-across-pages",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/base-a",
        html: "<base href='https://example.invalid/docs/'><footer><a href='pricing'>Read more</a></footer>",
      },
      {
        url: "https://example.invalid/base-b",
        html: "<base href='https://example.invalid/support/'><footer><a href='pricing'>Read more</a></footer>",
      },
    ],
    expectedGroups: [
      ["/base-a#footer:1>footer>a:1:link-text-generic"],
      ["/base-b#footer:1>footer>a:1:link-text-generic"],
    ],
    expectedUncertain: [],
  },
  {
    id: "base-href-equivalent-target-merge-across-pages",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/equivalent-relative",
        html: "<base href='https://example.invalid/docs/'><footer><a href='pricing'>Read more</a></footer>",
      },
      {
        url: "https://example.invalid/equivalent-absolute",
        html: "<footer><a href='https://example.invalid/docs/pricing'>Read more</a></footer>",
      },
    ],
    expectedGroups: [
      [
        "/equivalent-absolute#footer:1>footer>a:1:link-text-generic",
        "/equivalent-relative#footer:1>footer>a:1:link-text-generic",
      ],
    ],
    expectedUncertain: [],
  },
  {
    id: "article-footer-before-shared-site-footer",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/post",
        html: "<main><article><footer><nav><a href='/related'>Read more</a></nav></footer></article></main><footer><a href='/pricing'>Read more</a></footer>",
      },
      {
        url: "https://example.invalid/index",
        html: "<main><h1>Index</h1></main><footer><a href='/pricing'>Read more</a></footer>",
      },
    ],
    expectedGroups: [
      [
        "/index#footer:1>footer>a:1:link-text-generic",
        "/post#footer:1>footer>a:1:link-text-generic",
      ],
    ],
    expectedUncertain: ["/post#navigation:1>nav>a:1:link-text-generic"],
  },
  {
    id: "one-page-current-year-exception",
    rule: "stale",
    pages: [
      { url: "https://example.invalid/old", html: "<footer><p>© 2025 Example</p></footer>" },
      { url: "https://example.invalid/current", html: "<footer><p>© 2026 Example</p></footer>" },
    ],
    expectedGroups: [["/old#footer:1>footer>p:1:stale-copyright"]],
    expectedUncertain: [],
  },
  {
    id: "repeated-cards-different-data-abstain",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/cards",
        html: "<main><article><a href='/alpha'>Read more</a></article><article><a href='/beta'>Read more</a></article></main>",
      },
    ],
    expectedGroups: [],
    expectedUncertain: [
      "/cards#main:1>main>article:1>a:1:link-text-generic",
      "/cards#main:1>main>article:2>a:1:link-text-generic",
    ],
  },
  {
    id: "unknown-region-abstain",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/plain",
        html: "<div><a href='/a'>Read more</a><a href='/b'>Read more</a></div>",
      },
    ],
    expectedGroups: [],
    expectedUncertain: [
      "/plain#html>body:1>div:1>a:1:link-text-generic",
      "/plain#html>body:1>div:1>a:2:link-text-generic",
    ],
  },
  {
    // The same site footer across two layouts, where each page marks a
    // different nav link active and prints a per-page string. Before the
    // structural-signature fix these split into one group per page, which is
    // the failure mode this whole feature exists to avoid.
    id: "shared-footer-with-per-page-state-and-text",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/state-a",
        html: "<main><h1>A</h1></main><footer class='site-footer'><nav><a class='nav-link is-active' aria-current='page' href='/state-a'>Home</a><a class='nav-link' href='/state-b'>Docs</a></nav><p>Page 1 of 9</p><a href='/pricing'>Read more</a></footer>",
      },
      {
        url: "https://example.invalid/state-b",
        html: "<main><article><h1>B</h1></article></main><footer class='site-footer'><nav><a class='nav-link' href='/state-a'>Home</a><a class='nav-link is-active' aria-current='page' href='/state-b'>Docs</a></nav><p>Page 7 of 9</p><a href='/pricing'>Read more</a></footer>",
      },
    ],
    expectedGroups: [
      [
        "/state-a#footer:1>footer>a:1:link-text-generic",
        "/state-b#footer:1>footer>a:1:link-text-generic",
      ],
    ],
    expectedUncertain: [],
  },
  {
    // Detection parity trap: this element matches BOTH `footer` and `.footer`,
    // and the baseline concatenates per-selector matches, so its text appears
    // twice and only the seam reads "&copy; 2025". Deduping the selector
    // matches silently deleted the finding. No element's own text asserts the
    // year, so the finding correctly carries no component evidence.
    id: "dual-selector-footer-detection-parity",
    rule: "stale",
    pages: [
      {
        url: "https://example.invalid/dual",
        html: "<footer class='footer'>2025 &copy;</footer>",
      },
    ],
    expectedGroups: [],
    expectedUncertain: [],
  },
  {
    // A faulty element nested in an article INSIDE the footer is content, not
    // site chrome: ancestry above the region cannot tell it from the real one.
    id: "article-inside-footer-is-content",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/nested-a",
        html: "<footer><article><a href='/related'>Read more</a></article><a href='/pricing'>Read more</a></footer>",
      },
      {
        url: "https://example.invalid/nested-b",
        html: "<footer><article><a href='/other'>Read more</a></article><a href='/pricing'>Read more</a></footer>",
      },
    ],
    expectedGroups: [
      [
        "/nested-a#footer:1>footer>a:1:link-text-generic",
        "/nested-b#footer:1>footer>a:1:link-text-generic",
      ],
    ],
    expectedUncertain: [
      "/nested-a#footer:1>footer>article:1>a:1:link-text-generic",
      "/nested-b#footer:1>footer>article:1>a:1:link-text-generic",
    ],
  },
  {
    // Identical markup on two origins must never share a repair target. Paired
    // with `shared-footer-across-layouts` (same origin, different paths, ONE
    // group) this isolates the origin as the separator rather than the path.
    id: "cross-origin-identical-footer-separate",
    rule: "stale",
    pages: [
      { url: "https://example.invalid/a", html: "<footer><p>© 2025 Example</p></footer>" },
      { url: "https://other.invalid/b", html: "<footer><p>© 2025 Example</p></footer>" },
    ],
    expectedGroups: [
      ["/a#footer:1>footer>p:1:stale-copyright"],
      ["/b#footer:1>footer>p:1:stale-copyright"],
    ],
    expectedUncertain: [],
  },
  {
    // A region past the structural budget is still observed, but it cannot be
    // matched structurally, so it abstains and records why.
    id: "oversized-region-structure-abstain",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/huge",
        html: `<footer>${Array.from({ length: 400 }, (_, i) => `<span>${i}</span>`).join("")}<a href='/pricing'>Read more</a></footer>`,
      },
    ],
    expectedGroups: [],
    expectedUncertain: ["/huge#footer:1>footer>a:1:link-text-generic"],
  },
  {
    id: "nested-article-header-not-site-header",
    rule: "link",
    pages: [
      {
        url: "https://example.invalid/header",
        html: "<header><a href='/pricing'>Read more</a></header><main><article><header><nav><a href='/related'>Read more</a></nav></header></article></main>",
      },
    ],
    expectedGroups: [["/header#header:1>header>a:1:link-text-generic"]],
    expectedUncertain: ["/header#navigation:1>nav>a:1:link-text-generic"],
  },
];

function ctx(page: Page): RuleContext {
  return {
    page: { url: page.url, html: page.html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: {
      document: parseHTML(`<html><body>${page.html}</body></html>`).document,
    } as unknown as ParsedPage,
    options: { current_year: 2026 },
  };
}
function run(rule: Rule, pages: Page[]): CheckResult[] {
  return pages.flatMap((page) =>
    rule.run(ctx(page)).checks.map((check) => ({ ...check, pageUrl: check.pageUrl ?? page.url })),
  );
}
function stripEvidence(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry) => (key === "componentOccurrences" ? undefined : entry)),
  );
}
/** Codepoint order: `localeCompare` would make this artifact machine-dependent. */
function sorted<T>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Up to `limit` distinct orderings of `pages`, always including the reverse. */
function permutations<T>(items: T[], limit = 6): T[][] {
  if (items.length < 2) return [items];
  const out: T[][] = [items, [...items].reverse()];
  const seed = items.length;
  for (let shift = 1; shift < seed && out.length < limit; shift++) {
    out.push([...items.slice(shift), ...items.slice(0, shift)]);
  }
  const seen = new Set<string>();
  return out.filter((order) => {
    const signature = JSON.stringify(order);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}
function key(pageUrl: string, locator: string, kind: string): ElementKey {
  return `${new URL(pageUrl).pathname}#${locator}:${kind}`;
}
function groupMembers(groups: ReturnType<typeof componentFixGroups>): ElementKey[][] {
  return sorted(
    groups.map((group) =>
      sorted(
        group.occurrences.map((occurrence) =>
          key(occurrence.pageUrl, occurrence.element.locator, occurrence.defect.kind),
        ),
      ),
    ),
  );
}
function observationKeys(checks: CheckResult[]): ElementKey[] {
  return sorted(
    checks.flatMap((check) =>
      (check.componentOccurrences ?? []).map((occurrence) =>
        key(occurrence.pageUrl, occurrence.element.locator, occurrence.defect.kind),
      ),
    ),
  );
}
function groupsEqual(left: ElementKey[][], right: ElementKey[][]): boolean {
  return JSON.stringify(sorted(left.map(sorted))) === JSON.stringify(sorted(right.map(sorted)));
}
/** Every eligible observation pair is scored; false merges and missed merges are distinct. */
function pairwise(expected: ElementKey[][], actual: ElementKey[][]) {
  const expectedIndex = new Map<ElementKey, number>();
  const actualIndex = new Map<ElementKey, number>();
  expected.forEach((group, index) => group.forEach((member) => expectedIndex.set(member, index)));
  actual.forEach((group, index) => group.forEach((member) => actualIndex.set(member, index)));
  const members = sorted([...expectedIndex.keys()]);
  let falseMergePairs = 0,
    missedMergePairs = 0,
    correctSameGroupPairs = 0,
    correctSeparatePairs = 0;
  for (let left = 0; left < members.length; left++)
    for (let right = left + 1; right < members.length; right++) {
      const expectedSame = expectedIndex.get(members[left]!) === expectedIndex.get(members[right]!);
      const actualSame = actualIndex.get(members[left]!) === actualIndex.get(members[right]!);
      if (expectedSame && actualSame) correctSameGroupPairs++;
      else if (!expectedSame && !actualSame) correctSeparatePairs++;
      else if (actualSame) falseMergePairs++;
      else missedMergePairs++;
    }
  return {
    eligibleObservationCount: members.length,
    pairsCompared: (members.length * (members.length - 1)) / 2,
    correctSameGroupPairs,
    correctSeparatePairs,
    falseMergePairs,
    missedMergePairs,
  };
}
const GROUP_ID = /^component-fix:[0-9a-f]{32}(-\d+)?$/;

/**
 * Invariants of the evidence contract itself, independent of any one case:
 * every observation names the site it was scoped to, an abstention always says
 * why, and a group id is a short digest rather than the canonical identity.
 */
function evidenceShape(checks: CheckResult[], groups: ReturnType<typeof componentFixGroups>) {
  const occurrences = checks.flatMap((check) => check.componentOccurrences ?? []);
  const identityBytes = occurrences.map((o) => componentOccurrenceIdentity(o).length);
  return {
    occurrenceCount: occurrences.length,
    allCarrySiteOrigin: occurrences.every((o) => typeof o.siteOrigin === "string" && o.siteOrigin !== ""),
    siteOrigins: sorted([...new Set(occurrences.map((o) => o.siteOrigin))]),
    everyAbstentionRecordsAReason: occurrences.every((o) =>
      o.groupable ? o.uncertainReason === undefined : typeof o.uncertainReason === "string",
    ),
    uncertainReasons: sorted([
      ...new Set(occurrences.filter((o) => !o.groupable).map((o) => o.uncertainReason!)),
    ]),
    // No groupable observation may come from an unknown or content-nested region.
    noGroupableUnknownRegion: occurrences.every(
      (o) => !o.groupable || (o.region.role !== "unknown" && o.region.nestedIn === "none"),
    ),
    groupIdsAreShortDigests: groups.every((g) => GROUP_ID.test(g.id)),
    groupIdBytes: groups.reduce((sum, g) => sum + g.id.length, 0),
    // What the id WOULD have cost while it carried the whole canonical identity.
    canonicalIdentityBytesAvoided: identityBytes.reduce((sum, n) => sum + n, 0),
  };
}

/** Exact observed affected-page coverage per group, as the AC words it. */
function affectedPageCoverage(groups: ReturnType<typeof componentFixGroups>) {
  return groups.map((group) => ({
    id: group.id,
    affectedPageCount: group.affectedPageCount,
    distinctOccurrencePages: new Set(group.occurrences.map((o) => o.pageUrl)).size,
    occurrenceCount: group.occurrences.length,
    countMatchesMembership:
      group.affectedPageCount === new Set(group.occurrences.map((o) => o.pageUrl)).size &&
      group.affectedPages.length === group.affectedPageCount,
  }));
}

async function loadBaseline(): Promise<Record<RuleName, Rule>> {
  const loaded: Partial<Record<RuleName, Rule>> = {};
  const temporary: string[] = [];
  try {
    for (const file of ["content/stale-copyright.ts", "a11y/link-text.ts"]) {
      const target = resolve(root, "packages/rules/src", file.replace(".ts", ".baseline-2307.ts"));
      await Bun.write(target, await $`git show ${BASELINE}:packages/rules/src/${file}`.text());
      temporary.push(target);
      const mod = await import(`${target}?baseline=${Date.now()}`);
      loaded[file.startsWith("content") ? "stale" : "link"] =
        mod.staleCopyrightRule ?? mod.linkTextRule;
    }
  } finally {
    for (const file of temporary) unlinkSync(file);
  }
  return loaded as Record<RuleName, Rule>;
}
function health(rule: Rule, checks: CheckResult[]) {
  return calculateHealthScore({ results: new Map([[rule.meta.id, { meta: rule.meta, checks }]]) });
}
function originalFindingStats(checks: CheckResult[]) {
  const findings = checks.filter((check) => check.status === "warn" || check.status === "fail");
  const affectedPageUrls = sorted([
    ...new Set(findings.map((check) => check.pageUrl).filter(Boolean)),
  ]);
  return {
    checkCount: findings.length,
    affectedPageUnionCount: affectedPageUrls.length,
    affectedPageUrls,
  };
}
/** Minimal AuditReport envelope so a rule's checks can go through renderJson. */
function reportFor(rule: Rule, checks: CheckResult[]): Parameters<typeof renderJson>[0] {
  return {
    baseUrl: "https://example.invalid",
    timestamp: "2026-09-19T00:00:00.000Z",
    totalPages: new Set(checks.map((check) => check.pageUrl)).size,
    passed: 0,
    warnings: checks.length,
    failed: 0,
    ruleResults: { [rule.meta.id]: { meta: rule.meta, checks } },
    healthScore: {
      overall: 80,
      categories: [],
      groups: [],
      errorCount: 0,
      warningCount: checks.length,
      passedCount: 0,
    },
  } as unknown as Parameters<typeof renderJson>[0];
}

function benchmark(rule: Rule, pages: Page[]) {
  for (let index = 0; index < WARMUPS; index++) run(rule, pages);
  const gcBeforeMeasurement = typeof Bun.gc === "function";
  if (gcBeforeMeasurement) Bun.gc(true);
  const beforeBytes = process.memoryUsage().heapUsed;
  let checks: CheckResult[] = [],
    report: unknown;
  const samples: number[] = [];
  for (let index = 0; index < REPEATS; index++) {
    const started = performance.now();
    checks = run(rule, pages);
    report = {
      legacy: groupIssuesByCategory({ [rule.meta.id]: { meta: rule.meta, checks } }),
      componentFixGroups: componentFixGroups(rule.meta.id, checks),
    };
    samples.push(performance.now() - started);
  }
  const ordered = [...samples].sort((a, b) => a - b);
  const afterBytes = process.memoryUsage().heapUsed;
  return {
    warmups: WARMUPS,
    repeats: REPEATS,
    milliseconds: {
      min: Number(ordered[0]!.toFixed(3)),
      median: Number(ordered[Math.floor(ordered.length / 2)]!.toFixed(3)),
      max: Number(ordered.at(-1)!.toFixed(3)),
    },
    rawReportViewSerializedBytes: {
      checks: Buffer.byteLength(JSON.stringify(checks)),
      report: Buffer.byteLength(JSON.stringify(report)),
    },
    // What actually ships: the CLI JSON renderer, where a fix group references
    // the check's evidence instead of repeating it. The raw view above is an
    // in-memory structure that holds both, so it is NOT the wire size.
    renderedJsonBytes: Buffer.byteLength(renderJson(reportFor(rule, checks))),
    // Signature width is the dominant term in evidence size: six per occurrence.
    // `componentHash` emits SHA-256 truncated to 128 bits (`s128:` + 32 hex);
    // this reports what the same report would weigh at the original full 64-hex
    // width, by re-expanding every signature-shaped value in place.
    // Evidence size with and without the serialization hoist, over the same
    // occurrence set: `shapes` holds each region/family/variant triple once.
    evidenceBytes: (() => {
      const occurrences = checks.flatMap((check) => check.componentOccurrences ?? []);
      if (occurrences.length === 0) return { hoisted: 0, unhoisted: 0, occurrences: 0, shapes: 0 };
      const packed = packComponentOccurrences(occurrences);
      return {
        hoisted: Buffer.byteLength(JSON.stringify(packed)),
        unhoisted: Buffer.byteLength(JSON.stringify(occurrences)),
        occurrences: occurrences.length,
        shapes: packed.shapes.length,
      };
    })(),
    renderedJsonBytesAtFullWidthSignatures: Buffer.byteLength(
      renderJson(reportFor(rule, checks)).replace(/s128:[0-9a-f]{32}/g, (m) => `sha256:${m.slice(5)}${"0".repeat(32)}`),
    ),
    heap: { beforeBytes, afterBytes, deltaBytes: afterBytes - beforeBytes, gcBeforeMeasurement },
  };
}

const baseline = await loadBaseline();
const current: Record<RuleName, Rule> = { stale: staleCopyrightRule, link: linkTextRule };
const evaluated = cases.map((entry) => {
  const before = run(baseline[entry.rule], entry.pages);
  const after = run(current[entry.rule], entry.pages);
  const groups = componentFixGroups(current[entry.rule].meta.id, after);
  // Determinism across EVERY ordering we try, not just the reverse: ids and
  // memberships must both be stable, since a stable id over a drifting
  // membership would still be a different report.
  const orderings = permutations(entry.pages).map((order) => {
    const ordered = componentFixGroups(current[entry.rule].meta.id, run(current[entry.rule], order));
    return {
      ids: ordered.map((group) => group.id).sort(),
      members: groupMembers(ordered),
    };
  });
  const expectedGroups = sorted(entry.expectedGroups.map(sorted));
  const actualGroups = groupMembers(groups);
  const expectedObservationKeys = sorted([...expectedGroups.flat(), ...entry.expectedUncertain]);
  const actualObservationKeys = observationKeys(after);
  const pairResults = pairwise(expectedGroups, actualGroups);
  const originalDetections = {
    baseline: originalFindingStats(before),
    current: originalFindingStats(after),
  };
  const baselineUnchanged =
    JSON.stringify(stripEvidence(before)) === JSON.stringify(stripEvidence(after));
  const healthScoreEqual =
    JSON.stringify(health(baseline[entry.rule], before)) ===
    JSON.stringify(health(current[entry.rule], after));
  const orderInvariant = orderings.every(
    (ordering) =>
      JSON.stringify(ordering.ids) === JSON.stringify(groups.map((group) => group.id).sort()) &&
      groupsEqual(actualGroups, ordering.members),
  );
  const shape = evidenceShape(after, groups);
  const coverage = affectedPageCoverage(groups);
  const observationsExactlyPreserved =
    JSON.stringify(actualObservationKeys) === JSON.stringify(expectedObservationKeys);
  const membershipExact = groupsEqual(expectedGroups, actualGroups);
  const legacyMessageGroups =
    groupIssuesByCategory({
      [current[entry.rule].meta.id]: {
        meta: current[entry.rule].meta,
        checks: stripEvidence(after) as CheckResult[],
      },
    })[0]?.rules[0]?.checks.length ?? 0;
  return {
    id: entry.id,
    baselineCheckJsonEqualsCurrentWithoutEvidence: baselineUnchanged,
    healthScoreEqual,
    originalDetections,
    orderInvariant,
    orderingsCompared: orderings.length,
    evidenceShape: shape,
    affectedPageCoverage: coverage,
    legacyMessageGroups,
    actionableGroups: actualGroups.length,
    rawObservationCount: actualObservationKeys.length,
    rawUncertainObservationCount: entry.expectedUncertain.length,
    expectedGroups,
    actualGroups,
    expectedUncertain: sorted(entry.expectedUncertain),
    actualObservationKeys,
    observationsExactlyPreserved,
    pairwise: pairResults,
    pass:
      baselineUnchanged &&
      healthScoreEqual &&
      orderInvariant &&
      observationsExactlyPreserved &&
      membershipExact &&
      shape.allCarrySiteOrigin &&
      shape.everyAbstentionRecordsAReason &&
      shape.noGroupableUnknownRegion &&
      shape.groupIdsAreShortDigests &&
      coverage.every((group) => group.countMatchesMembership) &&
      pairResults.falseMergePairs === 0 &&
      pairResults.missedMergePairs === 0,
  };
});
const legacyChecks: CheckResult[] = [
  {
    pageUrl: "https://example.invalid/legacy-a",
    name: "footer-copyright-year",
    status: "warn",
    message: "Footer copyright year is 2025, behind the current year 2026",
  },
  {
    pageUrl: "https://example.invalid/legacy-b",
    name: "footer-copyright-year",
    status: "warn",
    message: "Footer copyright year is 2025, behind the current year 2026",
  },
];
const legacyReportGroups =
  groupIssuesByCategory({
    [staleCopyrightRule.meta.id]: { meta: staleCopyrightRule.meta, checks: legacyChecks },
  })[0]?.rules[0]?.checks.length ?? 0;
const legacy = {
  id: "legacy-no-component-evidence",
  inputCheckCount: legacyChecks.length,
  componentFixGroupCount: componentFixGroups(staleCopyrightRule.meta.id, legacyChecks).length,
  legacyMessageGroups: legacyReportGroups,
  readable: legacyReportGroups === 1,
  conservative: componentFixGroups(staleCopyrightRule.meta.id, legacyChecks).length === 0,
};
/**
 * The serialized CLI JSON must carry each observation exactly once. Fix groups
 * reference the check's evidence by position instead of repeating it, so the
 * check with references resolves back to a real occurrence every time.
 */
function jsonSerialization() {
  const entry = cases.find((c) => c.id === "shared-footer-across-layouts")!;
  const checks = run(current.stale, entry.pages);
  const rule = current.stale;
  const report = {
    baseUrl: "https://example.invalid",
    timestamp: "2026-09-19T00:00:00.000Z",
    totalPages: entry.pages.length,
    passed: 0,
    warnings: checks.length,
    failed: 0,
    ruleResults: { [rule.meta.id]: { meta: rule.meta, checks } },
    healthScore: {
      overall: 80,
      categories: [],
      groups: [],
      errorCount: 0,
      warningCount: checks.length,
      passedCount: 0,
    },
  } as unknown as Parameters<typeof renderJson>[0];
  const serialized = renderJson(report);
  const issue = JSON.parse(serialized).issues[0];
  const groups = issue?.componentFixGroups ?? [];
  const checkOccurrenceCount = (issue?.checks ?? []).reduce(
    (sum: number, check: { componentOccurrences?: unknown[] }) =>
      sum + (check.componentOccurrences?.length ?? 0),
    0,
  );
  const shapeCount = (issue?.checks ?? []).reduce(
    (sum: number, check: { componentShapes?: { shapes: unknown[] } }) =>
      sum + (check.componentShapes?.shapes.length ?? 0),
    0,
  );
  const refs = groups.flatMap(
    (group: { occurrenceRefs: Array<{ checkIndex: number; occurrenceIndex: number }> }) =>
      group.occurrenceRefs,
  );
  return {
    bytes: Buffer.byteLength(serialized),
    checkOccurrenceCount,
    groupCount: groups.length,
    groupOccurrenceRefCount: refs.length,
    // A group that still inlined its occurrences would fail this.
    noGroupRepeatsOccurrences: groups.every(
      (group: { occurrences?: unknown }) => group.occurrences === undefined,
    ),
    everyRefResolves: refs.every(
      (ref: { checkIndex: number; occurrenceIndex: number }) =>
        issue.checks[ref.checkIndex]?.componentOccurrences?.[ref.occurrenceIndex] !== undefined,
    ),
    // Signatures are HOISTED: the region/family/variant triple is stored once per
    // SHAPE, so the count scales with distinct shapes, not with occurrences.
    // Per occurrence only `element.structuralSignature` remains, plus the 2 a
    // group carries for its representative repair target.
    shapeCount,
    signatureFieldOccurrences: serialized.split('"structuralSignature"').length - 1,
    signatureFieldsExpected: shapeCount * 3 + checkOccurrenceCount + groups.length * 2,
    signatureFieldsIfNotHoisted: checkOccurrenceCount * 4 + groups.length * 2,
    everyGroupLabelsItsPageSample: groups.every(
      (group: { affectedPagesHasMore?: unknown; affectedPageCount?: unknown }) =>
        typeof group.affectedPagesHasMore === "boolean" &&
        typeof group.affectedPageCount === "number",
    ),
  };
}

/**
 * A fold caps the page sample. Unfolding must rebuild exactly the rows the fold
 * recorded — never a row for a page the audit never counted — and must say how
 * much evidence it could not place.
 */
function foldRoundTrip() {
  const pages = [
    { url: "https://example.invalid/fold-a", html: "<footer><p>© 2025 Example</p></footer>" },
    { url: "https://example.invalid/fold-b", html: "<footer><p>© 2025 Example</p></footer>" },
    { url: "https://example.invalid/fold-c", html: "<footer><p>© 2025 Example</p></footer>" },
  ];
  const checks = run(current.stale, pages);
  const folded = foldOverflowChecks(checks, {
    maxChecks: 1,
    maxItemsPerCheck: 10,
    maxPagesPerCheck: 1,
    maxSourcePagesPerItem: 10,
  })[0]!;
  const unfolded = unfoldAggregateCheck(folded);
  return {
    inputPages: pages.length,
    foldedPageSample: folded.pages?.length ?? 0,
    foldedOccurrences: folded.componentOccurrences?.length ?? 0,
    unfoldedRows: unfolded.length,
    rowsMatchRecordedPages: unfolded.length === (folded.pages?.length ?? 0),
    unfoldedPageUrls: unfolded.map((check) => check.pageUrl),
    marker: unfolded[0]?.componentEvidence,
    // The two observations outside the sample are reported, not dropped.
    unplaceableEvidenceReported:
      unfolded[0]?.componentEvidence?.reason === "page-sample-limit" &&
      unfolded[0]?.componentEvidence?.occurrenceCount ===
        (folded.componentOccurrences?.length ?? 0) - (folded.pages?.length ?? 0),
  };
}

const serialization = jsonSerialization();
const foldEvidence = foldRoundTrip();
const linkPages = cases.filter((entry) => entry.rule === "link").flatMap((entry) => entry.pages);
const stalePages = cases.filter((entry) => entry.rule === "stale").flatMap((entry) => entry.pages);
const thousandLinks = [
  {
    url: "https://example.invalid/1000-links",
    html: `<footer>${Array.from({ length: 1000 }, (_, index) => `<a href='/target-${index}'>Read more</a>`).join("")}</footer>`,
  },
];
const runtime = {
  method:
    "Independent baseline/current parser and rule runs after warmups; same-machine observations only.",
  inputs: [
    {
      name: "link-evaluation-corpus",
      pages: linkPages.length,
      baseline: benchmark(baseline.link, linkPages),
      current: benchmark(current.link, linkPages),
    },
    {
      name: "stale-copyright-evaluation-corpus",
      pages: stalePages.length,
      baseline: benchmark(baseline.stale, stalePages),
      current: benchmark(current.stale, stalePages),
    },
    {
      name: "1000-generic-footer-links",
      pages: 1,
      baseline: benchmark(baseline.link, thousandLinks),
      current: benchmark(current.link, thousandLinks),
    },
  ],
  caveats: [
    "Heap deltas are process-local snapshots and include allocator/GC effects; they are not retained-memory measurements.",
    "Raw report-view bytes include legacy grouping plus component fix groups and are not JSON wire payload measurements.",
    "Synthetic DOMs do not establish performance or grouping outcomes for the historic Product Hunt crawl; retained project hashes can resolve shared HTML, but linkage to the frozen reports used here is unestablished.",
  ],
};
const totals = {
  originalDetections: {
    baseline: {
      checkCount: evaluated.reduce(
        (sum, entry) => sum + entry.originalDetections.baseline.checkCount,
        0,
      ),
      affectedPageUnionCount: new Set(
        evaluated.flatMap((entry) => entry.originalDetections.baseline.affectedPageUrls),
      ).size,
    },
    current: {
      checkCount: evaluated.reduce(
        (sum, entry) => sum + entry.originalDetections.current.checkCount,
        0,
      ),
      affectedPageUnionCount: new Set(
        evaluated.flatMap((entry) => entry.originalDetections.current.affectedPageUrls),
      ).size,
    },
  },
  rawObservations: evaluated.reduce((sum, entry) => sum + entry.rawObservationCount, 0),
  rawUncertainObservations: evaluated.reduce(
    (sum, entry) => sum + entry.rawUncertainObservationCount,
    0,
  ),
  actionableGroups: evaluated.reduce((sum, entry) => sum + entry.actionableGroups, 0),
  affectedPageMemberships: evaluated.reduce(
    (sum, entry) =>
      sum +
      entry.actualGroups.reduce(
        (count, group) => count + new Set(group.map((member) => member.split("#")[0])).size,
        0,
      ),
    0,
  ),
  pairsCompared: evaluated.reduce((sum, entry) => sum + entry.pairwise.pairsCompared, 0),
  falseMergePairs: evaluated.reduce((sum, entry) => sum + entry.pairwise.falseMergePairs, 0),
  missedMergePairs: evaluated.reduce((sum, entry) => sum + entry.pairwise.missedMergePairs, 0),
};
const output = {
  // Emitted with a `git:` prefix so the value is not a bare 40-char hex string:
  // the public `Secret scan` gate flags those, and JSON cannot carry the
  // `pragma: allowlist secret` comment that silences it in source.
  baselineCommit: `git:${BASELINE}`,
  provenance: {
    corpus: "hand-authored synthetic HTML parsed through public baseline and current rules",
    historicDom:
      "project-database pages rows have no inline HTML; retained content_hash values can resolve shared HTML, but linkage to the frozen September 17 selected sites/reports was not established and no historic replay was used",
    sourceSafety: "example.invalid URLs only; no crawl bodies, credentials, or private reports",
  },
  cases: evaluated,
  legacy,
  jsonSerialization: serialization,
  foldPageSample: foldEvidence,
  totals,
  runtime,
  limitations: [
    "Public local selected-rule/report paths only; cloud/dashboard consumers remain unverified.",
    "Unknown, main-content, and article-nested observations remain raw evidence without a cross-page actionable target.",
    "The expected memberships are an authored corpus oracle, not labels recovered from historic reports.",
  ],
  allPass:
    evaluated.every((entry) => entry.pass) &&
    legacy.readable &&
    legacy.conservative &&
    serialization.noGroupRepeatsOccurrences &&
    serialization.everyRefResolves &&
    serialization.everyGroupLabelsItsPageSample &&
    serialization.signatureFieldOccurrences === serialization.signatureFieldsExpected &&
    foldEvidence.rowsMatchRecordedPages &&
    foldEvidence.unplaceableEvidenceReported,
};
await Bun.write(
  resolve(import.meta.dir, "evaluation-result.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));
if (!output.allPass) process.exitCode = 1;
