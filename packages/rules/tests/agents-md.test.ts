// ax/agents-md — AGENTS.md discovery across conventional path variants.

import { describe, expect, test } from "bun:test";

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

// The fixed probe list always includes all 18 well-known paths, one entry
// each (even on error) — build a minimal set including the ones this rule cares about.
function wellKnown(probes: WellKnownProbe[]): WellKnownProbeData {
  return { probes };
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
  test("data unavailable → info, no crash", () => {
    const checks = run(undefined);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("not available");
  });

  test("no hit anywhere → absent (quiet info without llms.txt)", () => {
    const checks = run(wellKnown([probe({ path: "/AGENTS.md" }), probe({ path: "/agents.md" })]));
    expect(checks[0]?.value).toBe("absent");
    expect(checks[0]?.status).toBe("info");
  });

  test("absent on a site publishing llms.txt → warn-status recommendation", () => {
    const checks = run(wellKnown([probe({ path: "/AGENTS.md" })]), true);
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
