// pub#2024 review: a run narrowed by --wcag-level or [rules] wcag_level goes through the same
// publish guard as a --rule-include/--rule-exclude run. `squirrel audit` decides whether the run
// is partial with `isPartialRun`, the predicate that also decides whether the run carries the
// `partialAudit` marker, and `squirrel report --publish` reads that marker. One guard, both paths.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "@/types";

import { publishSkipReason } from "@/audit/exit-code";
import { buildPartialAudit, isPartialRun } from "@/audit/rule-filter";
import {
  RULE_FILTER_PUBLISH_SKIP_LINE,
  auditPublishSkipLine,
  resolvePublishDecision,
} from "@/cli/commands/audit";
import { reportPublishDecision } from "@/cli/commands/report";

const NONE = { enable: [], disable: [] };

const autoPublish = (partial: boolean, explicitPublish = false) =>
  resolvePublishDecision({
    signedIn: true,
    offline: false,
    explicitPublish,
    noPublish: false,
    configPublish: true,
    ruleFilterActive: partial,
  });

const skipReason = (partial: boolean) =>
  publishSkipReason({
    nonPublicHost: false,
    serverIgnoredEphemeral: false,
    offline: false,
    ephemeral: false,
    explicitPublish: false,
    ruleFilterActive: partial,
    noPublish: false,
    configPublish: true,
  });

describe("audit publish guard for a WCAG-level run (pub#2024)", () => {
  test("--wcag-level or [rules] wcag_level alone makes the run partial", () => {
    expect(isPartialRun(NONE, "AA")).toBe(true);
    expect(isPartialRun(NONE, "AAA")).toBe(true);
    expect(isPartialRun(NONE, undefined)).toBe(false);
    expect(isPartialRun({ enable: ["core/*"], disable: [] }, undefined)).toBe(
      true
    );
  });

  test("a WCAG-level run is not auto-published and is skipped as rule-filter", () => {
    const partial = isPartialRun(NONE, "A");
    expect(autoPublish(partial)).toBe(false);
    expect(autoPublish(partial, true)).toBe(true);
    expect(skipReason(partial)).toBe("rule-filter");
    expect(
      skipReason(isPartialRun({ enable: [], disable: ["a11y/*"] }, undefined))
    ).toBe("rule-filter");
  });

  test("it prints the rule-filter skip line, the same one a --rule-include run prints", () => {
    const partial = isPartialRun(NONE, "AA");
    expect(
      auditPublishSkipLine({
        shouldPublish: autoPublish(partial),
        wouldPublishWithoutFilter: autoPublish(false),
        partialRun: partial,
      })
    ).toBe(RULE_FILTER_PUBLISH_SKIP_LINE);
    expect(
      auditPublishSkipLine({
        shouldPublish: autoPublish(false),
        wouldPublishWithoutFilter: autoPublish(false),
        partialRun: false,
      })
    ).toBeNull();
  });

  test("the marker exists exactly when the audit treats the run as partial", () => {
    expect(buildPartialAudit(NONE, [], "AA")).toBeDefined();
    expect(buildPartialAudit(NONE, [], undefined)).toBeUndefined();
  });

  test("report --publish of the stored WCAG-level run gets the audit's explicit answer", () => {
    const partialAudit = buildPartialAudit(NONE, [], "AA");
    const report = {
      baseUrl: "https://example.com",
      partialAudit,
    } as AuditReport;
    expect(reportPublishDecision(report)).toBe(
      autoPublish(isPartialRun(NONE, "AA"), true)
    );
  });
});
