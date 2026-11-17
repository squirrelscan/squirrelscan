// repo#1082: `squirrel report --publish` decides through the audit's own publish guard
// (`resolvePublishDecision`), so a rule-filtered (marked) or targeted report gets the
// same answer an explicit `squirrel audit --publish` of that run gets.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "@/types";

import { resolvePublishDecision } from "@/cli/commands/audit";
import { reportPublishDecision } from "@/cli/commands/report";

const report = (over: Partial<AuditReport> = {}) =>
  ({ baseUrl: "https://example.com", ...over }) as AuditReport;

const auditExplicit = (over: {
  ruleFilterActive?: boolean;
  targeted?: boolean;
  nonPublicHost?: boolean;
}) =>
  resolvePublishDecision({
    signedIn: true,
    offline: false,
    explicitPublish: true,
    noPublish: false,
    configPublish: true,
    ...over,
  });

const MARKER = {
  include: ["core/*"],
  exclude: [],
  includedCategories: ["core"],
};

describe("report --publish uses the audit publish guard (repo#1082)", () => {
  test("a marked report gets the audit's explicit --publish answer for a filtered run", () => {
    expect(reportPublishDecision(report({ partialAudit: MARKER }))).toBe(
      auditExplicit({ ruleFilterActive: true })
    );
  });

  test("a targeted report gets the audit's answer for a targeted run", () => {
    // The CLI's own scanScope type does not declare `targeted`; the audit stamps it (#1777).
    const targeted = report({
      scanScope: {
        origin: "cli",
        pagesCrawled: 1,
        capped: false,
        targeted: { requested: 1, audited: 1, unaudited: [] },
      } as AuditReport["scanScope"],
    });
    expect(reportPublishDecision(targeted)).toBe(
      auditExplicit({ targeted: true })
    );
  });

  test("an unmarked report gets the audit's answer for an unfiltered run", () => {
    expect(reportPublishDecision(report())).toBe(auditExplicit({}));
  });

  test("a local host is refused on both paths", () => {
    const local = report({ baseUrl: "http://localhost:3000/" });
    expect(reportPublishDecision(local)).toBe(false);
    expect(auditExplicit({ nonPublicHost: true })).toBe(false);
  });
});
