// A strict `Accept: text/markdown` probe that got no answer must keep a stored
// `markdown-negotiation-error` finding open (repo#1322, planning's finding on
// pub#1932). Audit 1 sees a strict 500 and opens the finding; audit 2 is
// throttled (429) on that request. Before the fix audit 2's report said nothing
// about the check, so a complete crawl read the rule's silence as "fixed".
//
// Every consumer that decides whether a site finding is gone reads the published
// report: the row has to survive the publish capper, be classified as a coverage
// gap by the one outcome table, and be listed as not checked. This drives the
// real rule into the real capper and asserts all three.

import type { ParsedPage, RuleContext } from "@squirrelscan/rules/types";

import {
  STRICT_PROBE_UNANSWERED_SKIP_REASON,
  type CheckResult,
  type MarkdownProbeData,
} from "@squirrelscan/core-contracts";
import { classifyRuleOutcome } from "@squirrelscan/core-contracts/rule-outcome";
import { notCheckedRules } from "@squirrelscan/report/not-checked";
import { loadAllRules } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import { capReportForPublish } from "../src/publish-cap";

const RULE_ID = "ax/markdown-response";
const rule = loadAllRules().get(RULE_ID)!;

function probe(over: Partial<MarkdownProbeData>): MarkdownProbeData {
  return {
    negotiatedUrl: "https://example.com/",
    negotiatedContentType: "text/html",
    servesMarkdown: false,
    mdVariantUrl: "https://example.com/index.md",
    mdVariantExists: false,
    mdVariantContentType: null,
    negotiatedStatus: 200,
    mdVariantAnswered: true,
    ...over,
  };
}

async function publishedChecks(
  markdownResponse: MarkdownProbeData
): Promise<CheckResult[]> {
  const ctx: RuleContext = {
    page: {
      url: "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      markdownResponse,
    },
    options: {},
  };
  const { checks } = await rule.run(ctx);
  const capped = capReportForPublish({
    ruleResults: { [RULE_ID]: { meta: rule.meta, checks } },
    pages: [{ url: "https://example.com/", statusCode: 200 }],
  });
  return capped.ruleResults[RULE_ID]?.checks ?? [];
}

const negotiation = (checks: CheckResult[]) =>
  checks.find((c) => c.name === "markdown-negotiation-error");

describe("strict probe unanswered keeps the finding open (repo#1322)", () => {
  test("audit 1: a strict 500 publishes the failing finding", async () => {
    const checks = await publishedChecks(
      probe({ strictNegotiatedStatus: 500, strictNegotiationAnswered: true })
    );
    expect(negotiation(checks)?.status).toBe("fail");
  });

  // The crawler records a 429, a 403 and a timeout alike as strictNegotiationAnswered false
  // (crawler/tests/markdown-strict-negotiation-1322.test.ts), so one state covers all three.
  test("audit 2: strict unanswered (429, 403, timeout) publishes a not-checked gap, never a silence", async () => {
    const checks = await publishedChecks(
      probe({ strictNegotiatedStatus: null, strictNegotiationAnswered: false })
    );
    const row = negotiation(checks);
    // The capper kept it: a missing row is what read as "fixed".
    expect(row).toBeDefined();
    expect(row?.status).toBe("skipped");
    expect(row?.skipReason).toBe(STRICT_PROBE_UNANSWERED_SKIP_REASON);
    expect(classifyRuleOutcome(row!)).toBe("coverage_gap");
    const listed = notCheckedRules({
      ruleResults: { [RULE_ID]: { meta: rule.meta, checks } },
    }).find((r) => r.ruleId === RULE_ID);
    expect(listed?.reason).toBe(STRICT_PROBE_UNANSWERED_SKIP_REASON);
    expect(listed?.outcome).toBe("coverage_gap");
  });

  test("a healthy strict answer publishes a verdict, so the finding can resolve", async () => {
    const checks = await publishedChecks(
      probe({ strictNegotiatedStatus: 200, strictNegotiationAnswered: true })
    );
    const row = negotiation(checks);
    expect(row === undefined || classifyRuleOutcome(row) === "ran").toBe(true);
    expect(
      notCheckedRules({
        ruleResults: { [RULE_ID]: { meta: rule.meta, checks } },
      })
    ).toEqual([]);
  });
});
