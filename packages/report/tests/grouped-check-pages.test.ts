// #910 — folded aggregate checks (and site-scope checks like the WAF banner)
// carry their affected pages in `pages` instead of a per-check pageUrl.
// groupIssuesByCategory must union that list into GroupedCheck.pages or the
// renderers show "0 pages affected" for exactly the link-heavy sites the fold
// exists for.

import { describe, expect, test } from "bun:test";
import type { ReportRuleResult } from "@squirrelscan/core-contracts";

import { groupIssuesByCategory } from "../src/grouping";

function rule(id: string, checks: ReportRuleResult["checks"]): ReportRuleResult {
  return {
    meta: {
      id,
      name: id,
      description: "",
      category: "images",
      scope: "page",
      severity: "warning",
      weight: 5,
    },
    checks,
  };
}

describe("groupIssuesByCategory check.pages union (#910)", () => {
  test("an aggregate check's pages land in GroupedCheck.pages and its occurrences in count", () => {
    const grouped = groupIssuesByCategory({
      "images/alt-text": rule("images/alt-text", [
        {
          name: "alt-text-missing",
          status: "fail",
          message: "3 image(s) missing alt text (+599 more pages)",
          pages: ["https://e.com/b", "https://e.com/a"],
          details: { aggregated: true, occurrences: 600 },
        },
      ]),
    });
    const check = grouped[0].rules[0].checks[0];
    expect(check.pages).toEqual(["https://e.com/a", "https://e.com/b"]);
    // The fold replaced 600 per-page checks; the badge count must not read 1.
    expect(check.count).toBe(600);
    expect(grouped[0].rules[0].failCount).toBe(600);
  });

  test("pages merge with per-check pageUrls without duplicates when checks group together", () => {
    const grouped = groupIssuesByCategory({
      "images/alt-text": rule("images/alt-text", [
        {
          name: "alt-text-missing",
          status: "fail",
          message: "1 image(s) missing alt text",
          pageUrl: "https://e.com/a",
        },
        {
          // Groups with the check above: same name/status and the message
          // normalizes to the same digit-stripped form.
          name: "alt-text-missing",
          status: "fail",
          message: "2 image(s) missing alt text",
          pages: ["https://e.com/a", "https://e.com/b"],
        },
      ]),
    });
    expect(grouped[0].rules[0].checks[0].pages).toEqual(["https://e.com/a", "https://e.com/b"]);
  });
});
