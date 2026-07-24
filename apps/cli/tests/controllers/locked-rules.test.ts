// Tests for computeLockedRules — cloud-gated rules that produced no real result
// this run become the report's "locked" Pro upsell (#336/#341).

import { humanizeCloudSkip, type Rule } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import type { AuditReport, CheckResult } from "../../src/types";

import { computeLockedRules } from "../../src/controllers/report/publish";

// Minimal stub — computeLockedRules only reads meta.{id,name,cloud}.
function rule(
  id: string,
  name: string,
  cloud: boolean,
  service?: string
): Rule {
  return {
    meta: { id, name, cloud: cloud ? { service } : undefined },
  } as unknown as Rule;
}

// Report carrying only the ruleResults checks the function inspects.
function reportWith(
  ruleResults: Record<
    string,
    {
      checks: Array<{ status: CheckResult["status"]; skipReason?: string }>;
    }
  >
): AuditReport {
  return { ruleResults } as unknown as AuditReport;
}

describe("computeLockedRules", () => {
  test("locks a cloud rule absent from ruleResults", () => {
    // free/offline run never ran the credited cloud service
    const rules = [rule("cloud/a", "Cloud A", true)];
    expect(computeLockedRules(reportWith({}), rules)).toEqual([
      { id: "cloud/a", name: "Cloud A" },
    ]);
  });

  test("locks a cloud rule whose every check is skipped", () => {
    const rules = [rule("cloud/a", "Cloud A", true)];
    const allSkipped = reportWith({
      "cloud/a": { checks: [{ status: "skipped" }, { status: "skipped" }] },
    });
    expect(computeLockedRules(allSkipped, rules)).toEqual([
      { id: "cloud/a", name: "Cloud A" },
    ]);
  });

  test("does not lock a cloud rule that produced a non-skipped check", () => {
    const rules = [rule("cloud/a", "Cloud A", true)];
    const ran = reportWith({
      "cloud/a": { checks: [{ status: "skipped" }, { status: "fail" }] },
    });
    expect(computeLockedRules(ran, rules)).toEqual([]);
  });

  test("never locks a non-cloud rule, even with no checks", () => {
    const rules = [rule("core/title", "Meta Title", false)];
    expect(computeLockedRules(reportWith({}), rules)).toEqual([]);
  });

  test("returns an empty array for an empty rule set", () => {
    expect(computeLockedRules(reportWith({}), [])).toEqual([]);
  });

  test("accumulates every absent cloud rule", () => {
    const rules = [
      rule("cloud/a", "Cloud A", true),
      rule("cloud/b", "Cloud B", true),
    ];
    expect(computeLockedRules(reportWith({}), rules)).toEqual([
      { id: "cloud/a", name: "Cloud A" },
      { id: "cloud/b", name: "Cloud B" },
    ]);
  });

  test("returns only the unrun cloud rules from a mixed set", () => {
    const rules = [
      rule("cloud/ran", "Cloud Ran", true),
      rule("cloud/idle", "Cloud Idle", true),
      rule("core/title", "Meta Title", false),
    ];
    const report = reportWith({
      "cloud/ran": { checks: [{ status: "pass" }] },
      // cloud/idle absent → locked; core/title non-cloud → ignored
    });
    expect(computeLockedRules(report, rules)).toEqual([
      { id: "cloud/idle", name: "Cloud Idle" },
    ]);
  });

  // #656: the list is an upsell — only advertise rules a paid run would produce.

  test("locks the render rule now that render is wired (#673 — reappears in the upsell)", () => {
    // render was wired into cloud-prefetch (#673) and left UNWIRED_CLOUD_SERVICES, so ax/content-without-js
    // is again a real paid-run capability and belongs in the locked-rules upsell for a free run.
    const rules = [
      rule(
        "ax/content-without-js",
        "Content Without JavaScript",
        true,
        "render"
      ),
    ];
    const locked = [
      { id: "ax/content-without-js", name: "Content Without JavaScript" },
    ];
    expect(computeLockedRules(reportWith({}), rules)).toEqual(locked);
    const allSkipped = reportWith({
      "ax/content-without-js": {
        checks: [
          {
            status: "skipped",
            skipReason: humanizeCloudSkip("not-prefetched"),
          },
        ],
      },
    });
    expect(computeLockedRules(allSkipped, rules)).toEqual(locked);
  });

  test("does not lock a rule whose every check skipped as not-applicable", () => {
    const rules = [
      rule(
        "eeat/authority-signals",
        "Authority Signals",
        true,
        "authority-signals"
      ),
    ];
    const gatedOut = reportWith({
      "eeat/authority-signals": {
        checks: [
          {
            status: "skipped",
            skipReason: humanizeCloudSkip("not-applicable"),
          },
          {
            status: "skipped",
            skipReason: humanizeCloudSkip("not-applicable"),
          },
        ],
      },
    });
    expect(computeLockedRules(gatedOut, rules)).toEqual([]);
  });

  test("still locks when skip reasons are mixed or lockable", () => {
    const rules = [
      rule(
        "eeat/authority-signals",
        "Authority Signals",
        true,
        "authority-signals"
      ),
    ];
    const mixed = reportWith({
      "eeat/authority-signals": {
        checks: [
          {
            status: "skipped",
            skipReason: humanizeCloudSkip("not-applicable"),
          },
          {
            status: "skipped",
            skipReason: humanizeCloudSkip("service-unavailable"),
          },
        ],
      },
    });
    expect(computeLockedRules(mixed, rules)).toEqual([
      { id: "eeat/authority-signals", name: "Authority Signals" },
    ]);
    const loggedOut = reportWith({
      "eeat/authority-signals": {
        checks: [
          {
            status: "skipped",
            skipReason: humanizeCloudSkip("not-authenticated"),
          },
        ],
      },
    });
    expect(computeLockedRules(loggedOut, rules)).toEqual([
      { id: "eeat/authority-signals", name: "Authority Signals" },
    ]);
  });
});
