// pub#726: the internal link "Not checked" hint told every reader to raise
// internal_links.max_targets, whatever left the targets unfetched. It now
// follows the rule's breakdown (`details.notFetched`): turn the checks back on
// only when they were off, raise the limit only when it left targets out.

import { describe, expect, test } from "bun:test";

import { LINK_TARGETS_NOT_FETCHED_SKIP_REASON } from "@squirrelscan/core-contracts";

import { notCheckedLines } from "../src/not-checked";
import type { ReportRuleResult } from "../src/types";

const MESSAGE = "2 of 7 internal link target(s) were not fetched because of a reason";

function lineFor(details?: Record<string, unknown>): string {
  const brokenLinks: ReportRuleResult = {
    meta: {
      id: "links/broken-links",
      name: "Broken Links",
      description: "Detects links returning 404 or 5xx errors",
      category: "links",
      scope: "site",
      severity: "error",
      weight: 7,
    },
    checks: [
      {
        name: "broken-links",
        status: "skipped",
        message: MESSAGE,
        skipReason: LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
        ...(details ? { details } : {}),
      },
    ],
  };
  const lines = notCheckedLines({ ruleResults: { "links/broken-links": brokenLinks } });
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

describe("the internal link Not checked hint follows the causes (pub#726)", () => {
  test("targets skipped, none over the limit: no max_targets, no 'turn back on'", () => {
    // A crawl keeps to the same scope and robots.txt, so it says which it can reach.
    expect(lineFor({ notFetched: { skipped: 2 } })).toBe(
      `Not checked: Broken Links. ${MESSAGE}. A Surface or Full audit, which follows links, fetches the ones inside the crawl scope and allowed by robots.txt.`,
    );
  });

  test("no answer, not trusted, or those with skipped targets: run an audit that follows links", () => {
    for (const notFetched of [{ noAnswer: 2 }, { untrusted: 2 }, { skipped: 1, noAnswer: 1 }]) {
      expect(lineFor({ notFetched })).toBe(
        `Not checked: Broken Links. ${MESSAGE}. Run a Surface or Full audit, which follows links, to check them.`,
      );
    }
  });

  test("targets over the limit: raise internal_links.max_targets", () => {
    expect(lineFor({ notFetched: { overLimit: 1, skipped: 1 } })).toBe(
      `Not checked: Broken Links. ${MESSAGE}. Raise internal_links.max_targets, or run a Surface or Full audit, which follows links, to check them.`,
    );
  });

  test("internal link checks off: turn them back on, and nothing about the limit", () => {
    expect(lineFor({ notFetched: { off: 2 } })).toBe(
      `Not checked: Broken Links. ${MESSAGE}. Turn internal link checks back on (they are off with --no-internal-links or internal_links.enabled = false), or run a Surface or Full audit, which follows links, to check them.`,
    );
  });

  test("a check from an engine before the breakdown keeps the full hint", () => {
    expect(lineFor({ linkTargets: 7, unfetchedTargets: 2 })).toContain(
      "Turn internal link checks back on (they are off with --no-internal-links or internal_links.enabled = false), raise internal_links.max_targets, or run a Surface or Full audit",
    );
    expect(lineFor()).toContain("raise internal_links.max_targets");
  });
});
