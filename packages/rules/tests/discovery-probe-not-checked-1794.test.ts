// #1794: a rule whose discovery probe was not approved, not sent or refused is skipped with a coded
// `discovery-probe-*` reason (so it lands in `notChecked` as a coverage gap), and a probe that was sent and
// answered, a 404 included, is a verdict.

import { describe, expect, test } from "bun:test";

import { PROBE_NOT_ATTEMPTED_ERROR, PROBE_PATH_NOT_APPROVED_ERROR, WELL_KNOWN_PATHS } from "@squirrelscan/core-contracts/storage";
import { DISCOVERY_PROBE_SKIP_REASONS, NOT_CHECKED_SKIP_REASONS } from "@squirrelscan/core-contracts";
import { classifyRuleOutcome } from "@squirrelscan/core-contracts/rule-outcome";

import type { CheckResult, WellKnownProbe } from "@squirrelscan/core-contracts";

import { agentsMdRule } from "../src/ax/agents-md";
import { securityTxtRule } from "../src/security/security-txt";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

function probe(path: string, over: Partial<WellKnownProbe> = {}): WellKnownProbe {
  return {
    path,
    url: `https://example.com${path}`,
    status: 404,
    contentType: null,
    bodySize: 0,
    looksHtml: false,
    jsonValid: false,
    jsonKeys: [],
    markdownLike: false,
    excerpt: "",
    oauthRegistrationEndpoint: null,
    oauthClientIdMetadataDocumentSupported: null,
    error: null,
    ...over,
  };
}

const notApproved = (path: string) => probe(path, { status: 0, error: PROBE_PATH_NOT_APPROVED_ERROR });

// What the crawler stores with `discovery_probe_paths = [<approved>]`: the approved paths as requested,
// every other probed path as a "path not approved" record.
function sweep(requested: WellKnownProbe[]): WellKnownProbe[] {
  return WELL_KNOWN_PATHS.map((path) => requested.find((p) => p.path === path) ?? notApproved(path));
}

function run(rule: Rule, probes: WellKnownProbe[]): CheckResult[] {
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, wellKnown: { probes } },
    options: {},
  };
  return rule.run(ctx).checks;
}

const gapOf = (check: CheckResult | undefined) => {
  expect(check?.status).toBe("skipped");
  expect(check?.value).toBe("not-checked");
  expect(NOT_CHECKED_SKIP_REASONS.has(check?.skipReason ?? "")).toBe(true);
  expect(classifyRuleOutcome({ status: check!.status, skipReason: check!.skipReason })).toBe("coverage_gap");
  return check?.skipReason;
};

describe("the probe reason codes", () => {
  test("every one is a not-checked coverage gap", () => {
    for (const reason of DISCOVERY_PROBE_SKIP_REASONS) {
      expect(NOT_CHECKED_SKIP_REASONS.has(reason)).toBe(true);
      expect(classifyRuleOutcome({ status: "skipped", skipReason: reason })).toBe("coverage_gap");
    }
  });
});

describe("not approved", () => {
  test("ax/agents-md with no AGENTS.md path approved reports discovery-probe-not-approved", () => {
    const check = run(agentsMdRule, sweep([]))[0];
    expect(gapOf(check)).toBe("discovery-probe-not-approved");
    expect(check?.message).toContain("path not approved");
  });

  test("security/security-txt with no security.txt path approved reports discovery-probe-not-approved", () => {
    expect(gapOf(run(securityTxtRule, sweep([]))[0])).toBe("discovery-probe-not-approved");
  });
});

describe("not sent", () => {
  test("a path the preamble budget skipped reports discovery-probe-not-sent", () => {
    const probes = WELL_KNOWN_PATHS.map((p) => probe(p, { status: 0, error: PROBE_NOT_ATTEMPTED_ERROR }));
    expect(gapOf(run(agentsMdRule, probes)[0])).toBe("discovery-probe-not-sent");
  });
});

describe("refused or throttled", () => {
  test("security.txt answered 429 is a refusal, never a missing file", () => {
    const checks = run(securityTxtRule, sweep([probe("/.well-known/security.txt", { status: 429 })]));
    expect(checks.some((c) => c.status === "warn")).toBe(false);
    expect(gapOf(checks.find((c) => c.name === "security-txt"))).toBe("discovery-probe-refused");
  });
});

describe("approved and answered 404", () => {
  test("an approved /AGENTS.md that answered 404 is absent, not 'path not approved'", () => {
    const checks = run(agentsMdRule, sweep([probe("/AGENTS.md", { status: 404 })]));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.value).toBe("absent");
    expect(checks[0]?.message).not.toContain("not checked");
    // The variants the user left out are listed, not hidden.
    expect(checks[0]?.details?.notChecked).toContain("/agents.md");
  });

  test("an approved security.txt path that answered 404 is missing, even with the legacy path not approved", () => {
    const checks = run(securityTxtRule, sweep([probe("/.well-known/security.txt", { status: 404 })]));
    expect(checks.find((c) => c.name === "security-txt")?.value).toBe("missing");
  });

  test("only the legacy path approved and answered 404 is missing too", () => {
    const checks = run(securityTxtRule, sweep([probe("/security.txt", { status: 404 })]));
    expect(checks.find((c) => c.name === "security-txt")?.value).toBe("missing");
  });

  test("a variant that was never sent still makes AGENTS.md not checked", () => {
    const probes = sweep([probe("/AGENTS.md", { status: 404 })]).map((p) =>
      p.path === "/docs/AGENTS.md" ? probe(p.path, { status: 0, error: PROBE_NOT_ATTEMPTED_ERROR }) : p,
    );
    expect(gapOf(run(agentsMdRule, probes)[0])).toBe("discovery-probe-not-sent");
  });
});
