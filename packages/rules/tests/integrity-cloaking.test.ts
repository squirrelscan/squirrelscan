// integrity Phase 3 (#118) — integrity/cloaking rule. The rule reads the opt-in
// `ctx.site.cloakingProbes` array (assembled by audit-engine's differential
// probe; covered in packages/audit-engine/tests/cloaking-probe.test.ts). This file
// proves the WIRING + rule verdict logic across divergent vs identical fixtures.

import { describe, expect, test } from "bun:test";

import type { CheckResult, CloakingProbeData } from "@squirrelscan/core-contracts";

import { cloakingRule } from "../src/integrity/cloaking";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const SITE = "https://example.com";

function probe(over: Partial<CloakingProbeData>): CloakingProbeData {
  return {
    url: `${SITE}/page`,
    reason: "orphan",
    defaultStatus: 200,
    defaultBytes: 1000,
    googlebotStatus: 200,
    googlebotBytes: 1000,
    uaSimilarity: 1,
    uaCloaking: false,
    queryUrl: null,
    queryStatus: null,
    queryBytes: null,
    querySimilarity: null,
    tokenGated: false,
    error: null,
    ...over,
  };
}

function siteCtx(cloakingProbes: CloakingProbeData[] | undefined): RuleContext {
  const site: SiteData = {
    baseUrl: SITE,
    pages: [],
    robotsTxt: null,
    sitemaps: null,
    cloakingProbes,
  };
  return {
    page: { url: SITE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site,
    options: {},
  };
}

function run(probes: CloakingProbeData[] | undefined): CheckResult[] {
  return cloakingRule.run(siteCtx(probes)).checks;
}

describe("integrity/cloaking", () => {
  test("no-op when probe is off (cloakingProbes undefined)", () => {
    expect(run(undefined)).toEqual([]);
  });

  test("pass when probe ran but found no suspicious paths (empty array)", () => {
    const checks = run([]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("pass");
  });

  test("fail on UA cloaking (status flip)", () => {
    const checks = run([
      probe({
        url: `${SITE}/hidden`,
        defaultStatus: 403,
        googlebotStatus: 200,
        uaSimilarity: 0,
        uaCloaking: true,
      }),
    ]);
    const fail = checks.find((c) => c.status === "fail");
    expect(fail).toBeDefined();
    expect(fail!.name).toBe("cloaking");
    expect(fail!.items?.[0]?.id).toBe(`${SITE}/hidden`);
    expect(fail!.value).toContain("googlebot got 200");
  });

  test("fail on UA cloaking (low text similarity)", () => {
    const checks = run([probe({ url: `${SITE}/x`, uaSimilarity: 0.21, uaCloaking: true })]);
    const fail = checks.find((c) => c.status === "fail");
    expect(fail).toBeDefined();
    expect(fail!.value).toContain("21% similar");
  });

  test("warn on token-gating (no UA cloaking)", () => {
    const checks = run([
      probe({
        url: `${SITE}/g`,
        tokenGated: true,
        queryUrl: `${SITE}/g?ss_cloak_probe=1`,
        queryStatus: 200,
        querySimilarity: 0.1,
      }),
    ]);
    expect(checks.find((c) => c.status === "fail")).toBeUndefined();
    const warn = checks.find((c) => c.status === "warn");
    expect(warn).toBeDefined();
    expect(warn!.name).toBe("cloaking-token-gated");
  });

  test("token-gating not double-reported when page also UA-cloaks", () => {
    const checks = run([probe({ url: `${SITE}/both`, uaCloaking: true, tokenGated: true })]);
    expect(checks.find((c) => c.status === "fail")).toBeDefined();
    expect(checks.find((c) => c.status === "warn")).toBeUndefined();
  });

  test("pass when probed paths are all clean", () => {
    const checks = run([
      probe({ url: `${SITE}/a` }),
      probe({ url: `${SITE}/b`, reason: "recent-lastmod" }),
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("pass");
    expect(checks[0]!.message).toContain("2 suspicious path");
  });

  test("reports both fail and warn when distinct pages diverge differently", () => {
    const checks = run([
      probe({ url: `${SITE}/cloaked`, uaCloaking: true }),
      probe({ url: `${SITE}/gated`, tokenGated: true }),
    ]);
    expect(checks.find((c) => c.status === "fail")).toBeDefined();
    expect(checks.find((c) => c.status === "warn")).toBeDefined();
  });
});
