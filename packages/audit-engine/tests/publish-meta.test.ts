// Cloud-report publish-prep parity (#368 report regression): runCloudAudit must
// stamp report.homepage + report.lockedRules the way the CLI publish path does,
// or cloud reports render a bare host with no title/description/"didn't run".

import {
  humanizeCloudSkip,
  loadAllRules,
  UNWIRED_CLOUD_SERVICES,
  type Rule,
} from "@squirrelscan/rules";

import { describe, expect, test } from "bun:test";

import { SUPPORTED_SERVICES } from "../src/cloud-prefetch";
import { computeLockedRules, deriveHomepageSummary } from "../src/publish-meta";

// Minimal stub — computeLockedRules only reads meta.{id,name,cloud}.
function rule(id: string, name: string, cloud: boolean, service?: string): Rule {
  return { meta: { id, name, cloud: cloud ? { service } : undefined } } as unknown as Rule;
}

describe("deriveHomepageSummary", () => {
  const meta = (title: string | null, description: string | null) => ({ title, description });

  test("picks the root page's meta title/description", () => {
    const report = {
      baseUrl: "https://example.com",
      pages: [
        { url: "https://example.com/about", meta: meta("About", "About page") },
        { url: "https://example.com/", meta: meta("Home", "Welcome home") },
      ],
    };
    expect(deriveHomepageSummary(report)).toEqual({ title: "Home", description: "Welcome home" });
  });

  test("falls back to og when meta is empty", () => {
    const report = {
      baseUrl: "https://example.com",
      pages: [
        { url: "https://example.com/", meta: meta(null, null), og: meta("OG Title", "OG Desc") },
      ],
    };
    expect(deriveHomepageSummary(report)).toEqual({ title: "OG Title", description: "OG Desc" });
  });

  test("prefers the same-origin root over a sibling-domain root (origin guard)", () => {
    const report = {
      baseUrl: "https://example.com",
      pages: [
        { url: "https://other.com/", meta: meta("Other", "Other site") },
        { url: "https://example.com/", meta: meta("Home", "Welcome") },
      ],
    };
    expect(deriveHomepageSummary(report)).toEqual({ title: "Home", description: "Welcome" });
  });

  test("returns undefined when no pages", () => {
    expect(deriveHomepageSummary({ baseUrl: "https://example.com", pages: [] })).toBeUndefined();
  });

  test("returns undefined when the home page has no title or description", () => {
    const report = {
      baseUrl: "https://example.com",
      pages: [{ url: "https://example.com/", meta: meta(null, null) }],
    };
    expect(deriveHomepageSummary(report)).toBeUndefined();
  });

  test("falls back to the first page when baseUrl is unparseable", () => {
    const report = {
      baseUrl: "not-a-url",
      pages: [{ url: "https://example.com/", meta: meta("Home", "desc") }],
    };
    expect(deriveHomepageSummary(report)).toEqual({ title: "Home", description: "desc" });
  });
});

describe("computeLockedRules", () => {
  const reportWith = (
    ruleResults: Record<string, { checks: Array<{ status: string; skipReason?: string }> }>,
  ) => ({
    ruleResults,
  });

  test("locks a cloud rule that produced no non-skipped check", () => {
    const rules = [rule("ai/a", "Cloud A", true)];
    expect(computeLockedRules(reportWith({}), rules)).toEqual([{ id: "ai/a", name: "Cloud A" }]);
    expect(
      computeLockedRules(reportWith({ "ai/a": { checks: [{ status: "skipped" }] } }), rules),
    ).toEqual([{ id: "ai/a", name: "Cloud A" }]);
  });

  test("does not lock a cloud rule that ran, nor any non-cloud rule", () => {
    const rules = [rule("ai/ran", "Ran", true), rule("core/title", "Title", false)];
    const ran = reportWith({ "ai/ran": { checks: [{ status: "skipped" }, { status: "fail" }] } });
    expect(computeLockedRules(ran, rules)).toEqual([]);
  });

  // #656: the locked list is an upsell — only advertise rules a paid run would produce.

  test("locks the render rule now that render is wired (#673 — reappears in the upsell)", () => {
    // render left UNWIRED_CLOUD_SERVICES when it was wired into cloud-prefetch (#673), so ax/content-without-js
    // is again a real paid-run capability and belongs in the locked-rules upsell for a free run.
    const rules = [rule("ax/content-without-js", "Content Without JavaScript", true, "render")];
    expect(computeLockedRules(reportWith({}), rules)).toEqual([
      { id: "ax/content-without-js", name: "Content Without JavaScript" },
    ]);
  });

  test("does not lock a rule whose every check skipped as not-applicable", () => {
    const rules = [rule("eeat/authority-signals", "Authority Signals", true, "authority-signals")];
    const gatedOut = reportWith({
      "eeat/authority-signals": {
        checks: [{ status: "skipped", skipReason: humanizeCloudSkip("not-applicable") }],
      },
    });
    expect(computeLockedRules(gatedOut, rules)).toEqual([]);
  });

  test("still locks when skips are lockable (logged out) or mixed", () => {
    const rules = [rule("eeat/authority-signals", "Authority Signals", true, "authority-signals")];
    const mixed = reportWith({
      "eeat/authority-signals": {
        checks: [
          { status: "skipped", skipReason: humanizeCloudSkip("not-applicable") },
          { status: "skipped", skipReason: humanizeCloudSkip("not-authenticated") },
        ],
      },
    });
    expect(computeLockedRules(mixed, rules)).toEqual([
      { id: "eeat/authority-signals", name: "Authority Signals" },
    ]);
  });
});

// Cross-check the three places that encode "does this cloud service have an
// execution path" (#656 review): the prefetch's SUPPORTED_SERVICES, the rules
// package's UNWIRED_CLOUD_SERVICES, and the dedicated non-prefetch paths. A new
// cloud rule whose service lands in none of them fails here instead of silently
// skipping `not-prefetched` forever while showing as a locked upsell.
describe("cloud service execution-path coverage", () => {
  // Services fulfilled outside the generic prefetch: dead-links runs through
  // the external-links bulk checker (cloud-runner.ts / apps/cli/src/audit/cloud.ts).
  const EXTERNALLY_WIRED = new Set(["dead-links"]);

  test("UNWIRED_CLOUD_SERVICES never overlaps SUPPORTED_SERVICES", () => {
    for (const service of UNWIRED_CLOUD_SERVICES) {
      expect(SUPPORTED_SERVICES.has(service)).toBe(false);
    }
  });

  test("every rule's cloud service has a declared execution path (or is declared unwired)", () => {
    for (const rule of loadAllRules().values()) {
      const service = rule.meta.cloud?.service;
      if (!service) continue;
      const covered =
        SUPPORTED_SERVICES.has(service) ||
        UNWIRED_CLOUD_SERVICES.has(service) ||
        EXTERNALLY_WIRED.has(service);
      expect(covered, `${rule.meta.id} uses service "${service}" with no execution path`).toBe(
        true,
      );
    }
  });
});
