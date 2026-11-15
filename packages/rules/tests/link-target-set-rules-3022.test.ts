// repo#3022: LINK_TARGET_SET_RULES (core-contracts) names the checks of the two link rules that list broken
// targets and the ones they could not verify. The cloud's broken link alerts read a previous audit's target
// sets as its whole list of both. The names are emitted at runtime and declared nowhere else, so a new
// check on either rule that is not added to the map reads a link that sat in it as newly broken.
//
// Two pins: every check name literal in a link rule's source must be in the map (this catches a check no
// fixture below reaches), and a run over inputs that make each rule emit every kind of row must emit
// nothing that lists targets outside the map.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { LINK_TARGET_SET_RULES } from "@squirrelscan/core-contracts";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import { brokenLinksRule } from "../src/links/broken-links";
import type { CheckResult, ExternalLinkCheckData, ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";

const SOURCE_FILES: Record<string, string> = {
  "links/broken-links": "broken-links.ts",
  "links/broken-external-links": "broken-external-links.ts",
};

function mapped(ruleId: string): Set<string> {
  const rows = LINK_TARGET_SET_RULES[ruleId]!;
  return new Set([rows.broken, rows.sitewide, ...rows.unverified]);
}

describe("LINK_TARGET_SET_RULES covers the link rules' check names (repo#3022)", () => {
  test("the map has exactly the two link rules", () => {
    expect(Object.keys(LINK_TARGET_SET_RULES).sort()).toEqual(Object.keys(SOURCE_FILES).sort());
  });

  for (const [ruleId, file] of Object.entries(SOURCE_FILES)) {
    test(`${ruleId}: every check name in the source is in the map`, () => {
      const src = readFileSync(join(import.meta.dir, "..", "src", "links", file), "utf8");
      // A check name is a kebab-case `name:` literal; the rule's own display name has spaces.
      const names = new Set(
        [...src.matchAll(/\bname:\s*"([a-z]+(?:-[a-z]+)+)"/g)].map((m) => m[1]!),
      );
      expect(names.size, "found no check names: the pattern is stale").toBeGreaterThan(0);
      const missing = [...names].filter((n) => !mapped(ruleId).has(n));
      expect(
        missing,
        `add these to LINK_TARGET_SET_RULES["${ruleId}"] (broken, sitewide or unverified)`,
      ).toEqual([]);
    });
  }

  test("links/broken-links: a run that emits every row lists targets only under mapped checks", async () => {
    const page = (url: string, links: string[]) => ({
      url,
      statusCode: 200,
      parsed: {
        links: links.map((u) => ({ url: u, isInternal: true, text: "", rel: null })),
      } as unknown as ParsedPage,
    });
    const ctx = {
      page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: {
        baseUrl: BASE,
        robotsTxt: null,
        sitemaps: null,
        pages: [page(`${BASE}/`, [`${BASE}/gone`, `${BASE}/walled`, `${BASE}/slow`])],
        linkTargetStatuses: [
          { url: `${BASE}/gone`, status: 404, error: null },
          { url: `${BASE}/walled`, status: 403, error: null },
          { url: `${BASE}/slow`, status: 429, error: null, rateLimited: true },
        ],
      },
      options: {},
    } as unknown as RuleContext;
    const checks = (await brokenLinksRule.run(ctx)).checks;
    const emitted = new Set(checks.map((c) => c.name));
    for (const name of ["broken-links", "refused-links", "rate-limited-links"]) {
      expect(emitted.has(name), `fixture no longer emits ${name}`).toBe(true);
    }
    expectListedChecksMapped("links/broken-links", checks);
  });

  test("links/broken-external-links: a run that emits every row lists targets only under mapped checks", async () => {
    const link = (over: Partial<ExternalLinkCheckData>): ExternalLinkCheckData => ({
      href: "https://other.example/",
      status: 200,
      error: null,
      sourcePages: [`${BASE}/`],
      ...over,
    });
    const ctx = {
      page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: {
        baseUrl: BASE,
        pages: [],
        robotsTxt: null,
        sitemaps: null,
        externalLinks: [
          link({ href: "https://a.example/gone", status: 404 }),
          link({ href: "https://b.example/flaky", status: 503 }),
          link({
            href: "https://c.example/walled",
            status: 403,
            wafBlocked: true,
            wafProvider: "cloudflare",
          }),
          link({
            href: "https://d.example/first",
            status: 404,
            wafBlocked: true,
            unverifiedReason: "awaiting-confirmation",
          }),
          link({ href: "https://e.example/slow", status: 429, rateLimited: true }),
        ],
        externalLinkCheck: {
          found: 7,
          checked: 5,
          cap: 100,
          notRequested: 1,
          notRequestedLinks: [{ href: "https://f.example/logout", sourcePages: [`${BASE}/`] }],
          refused: 1,
          refusedLinks: [{ href: "http://10.0.0.1/", sourcePages: [`${BASE}/`] }],
        },
      },
      options: {},
    } as unknown as RuleContext;
    const checks = (await brokenExternalLinksRule.run(ctx)).checks;
    const emitted = new Set(checks.map((c) => c.name));
    for (const name of [
      "broken-external-links",
      "possibly-broken-external-links",
      "awaiting-confirmation-external-links",
      "waf-blocked-external-links",
      "rate-limited-external-links",
      "not-requested-external-links",
      "refused-external-links",
    ]) {
      expect(emitted.has(name), `fixture no longer emits ${name}`).toBe(true);
    }
    expectListedChecksMapped("links/broken-external-links", checks);
  });
});

/** Every emitted check that lists targets (non-empty items) must be a mapped check. */
function expectListedChecksMapped(ruleId: string, checks: CheckResult[]): void {
  const listing = checks.filter((c) => (c.items?.length ?? 0) > 0).map((c) => c.name);
  const unmapped = [...new Set(listing)].filter((n) => !mapped(ruleId).has(n));
  expect(
    unmapped,
    `${ruleId} lists targets under checks missing from LINK_TARGET_SET_RULES`,
  ).toEqual([]);
}
