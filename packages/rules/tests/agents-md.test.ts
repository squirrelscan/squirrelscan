// ax/agents-md — AGENTS.md discovery across conventional path variants.

import { describe, expect, test } from "bun:test";

import { PROBE_NOT_ATTEMPTED_ERROR, WELL_KNOWN_PATHS } from "@squirrelscan/core-contracts/storage";

import type { CheckResult, LlmsTxtData, WellKnownProbe, WellKnownProbeData } from "@squirrelscan/core-contracts";

import { agentsMdRule } from "../src/ax/agents-md";
import type { ParsedPage, RuleContext } from "../src/types";

function probe(over: Partial<WellKnownProbe> = {}): WellKnownProbe {
  return {
    path: "/AGENTS.md",
    url: "https://example.com/AGENTS.md",
    status: 0,
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

// The crawler's default sweep stores one row per well-known path (even on
// error), so a path the test does not set is one that was requested and 404'd.
function wellKnown(probes: WellKnownProbe[]): WellKnownProbeData {
  return {
    probes: WELL_KNOWN_PATHS.map(
      (path) =>
        probes.find((p) => p.path === path) ??
        probe({ path, url: `https://example.com${path}`, status: 404 }),
    ),
  };
}

function ctx(wk: WellKnownProbeData | null | undefined, publishesLlmsTxt = false): RuleContext {
  const llmsTxt = publishesLlmsTxt
    ? ({ llmsTxt: { exists: true }, llmsFullTxt: { exists: false } } as LlmsTxtData)
    : undefined;
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, wellKnown: wk, llmsTxt },
    options: {},
  };
}

function run(wk: WellKnownProbeData | null | undefined, publishesLlmsTxt = false): CheckResult[] {
  return agentsMdRule.run(ctx(wk, publishesLlmsTxt)).checks;
}

describe("ax/agents-md", () => {
  test("data unavailable → not checked info, no crash", () => {
    const checks = run(undefined);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.message).toContain("not checked");
  });

  // #409: never "No AGENTS.md found" for a path that was not requested, even on
  // a site publishing llms.txt, where absence would otherwise warn.
  test("AGENTS.md paths missing from the sweep → not checked, not a warning", () => {
    const checks = run({ probes: [probe({ path: "/swagger.json", status: 404 })] }, true);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.value).toBe("not-checked");
  });

  // A refused connection (a firewall that just banned the audit) or a timeout
  // is no answer, and no answer is not "missing".
  test("an AGENTS.md path that got no answer → not checked, not absent", () => {
    const wk = wellKnown([probe({ path: "/AGENTS.md", status: 0, error: "connect ECONNREFUSED" })]);
    const checks = run(wk, true);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.message).toContain("got no answer");
    expect(checks[0]?.details?.notChecked).toEqual(["/AGENTS.md"]);
  });

  test("an AGENTS.md path skipped by the preamble budget → not checked", () => {
    const wk = wellKnown([probe({ path: "/docs/AGENTS.md", error: PROBE_NOT_ATTEMPTED_ERROR })]);
    const checks = run(wk, true);
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.details?.notChecked).toEqual(["/docs/AGENTS.md"]);
  });

  test("no hit anywhere → absent (quiet info without llms.txt)", () => {
    const checks = run(
      wellKnown([probe({ path: "/AGENTS.md", status: 404 }), probe({ path: "/agents.md", status: 404 })]),
    );
    expect(checks[0]?.value).toBe("absent");
    expect(checks[0]?.status).toBe("info");
  });

  test("absent on a site publishing llms.txt → warn-status recommendation", () => {
    const checks = run(wellKnown([probe({ path: "/AGENTS.md", status: 404 })]), true);
    expect(checks[0]?.value).toBe("absent");
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.message).toContain("llms.txt");
  });

  test("real hit at /AGENTS.md → present", () => {
    const checks = run(
      wellKnown([
        probe({
          path: "/AGENTS.md",
          status: 200,
          markdownLike: true,
          looksHtml: false,
          bodySize: 120,
          excerpt: "# Agent Instructions",
        }),
      ]),
    );
    expect(checks[0]?.value).toBe("present");
    expect(checks[0]?.message).toContain("/AGENTS.md");
  });

  test("real hit at lowercase /agents.md variant → present", () => {
    const checks = run(
      wellKnown([
        probe({ path: "/AGENTS.md", status: 404 }),
        probe({ path: "/agents.md", status: 200, markdownLike: true }),
      ]),
    );
    expect(checks[0]?.value).toBe("present");
    expect(checks[0]?.message).toContain("/agents.md");
  });

  test("SPA-fallback 200 HTML → explicitly flagged, not present", () => {
    const checks = run(
      wellKnown([probe({ path: "/AGENTS.md", status: 200, looksHtml: true, markdownLike: false })]),
    );
    expect(checks[0]?.value).toBe("spa-fallback");
    expect(checks[0]?.message).toContain("not a real AGENTS.md");
  });

  test("only info status is ever produced (recommendation-only)", () => {
    expect(run(wellKnown([])).every((c) => c.status === "info")).toBe(true);
  });
});
