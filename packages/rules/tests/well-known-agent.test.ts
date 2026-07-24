// ax/well-known-agent — MCP server card, A2A agent card, agent-skills, deprecated ai-plugin.json.

import { describe, expect, test } from "bun:test";

import type { CheckResult, WellKnownProbe, WellKnownProbeData } from "@squirrelscan/core-contracts";

import { wellKnownAgentRule } from "../src/ax/well-known-agent";
import type { ParsedPage, RuleContext } from "../src/types";

function probe(over: Partial<WellKnownProbe> = {}): WellKnownProbe {
  return {
    path: "/.well-known/mcp/server-card.json",
    url: "https://example.com/.well-known/mcp/server-card.json",
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

function ctx(probes: WellKnownProbe[] | null | undefined): RuleContext {
  const wk: WellKnownProbeData | null = probes ? { probes } : null;
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, wellKnown: wk },
    options: {},
  };
}

function run(probes: WellKnownProbe[] | null | undefined): CheckResult[] {
  return wellKnownAgentRule.run(ctx(probes)).checks;
}

describe("ax/well-known-agent", () => {
  test("data unavailable → info, no crash", () => {
    const checks = run(undefined);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("not available");
  });

  test("nothing found → single quiet absent info (never warn)", () => {
    const checks = run([]);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.value).toBe("absent");
    expect(checks[0]?.status).toBe("info");
  });

  test("MCP server card hit → present with plausible fields", () => {
    const checks = run([
      probe({
        path: "/.well-known/mcp/server-card.json",
        status: 200,
        jsonValid: true,
        jsonKeys: ["name", "url", "transport"],
      }),
    ]);
    const hit = checks.find((c) => c.name === "well-known-agent-present");
    expect(hit?.value).toBe("present");
    expect(hit?.message).toContain("MCP server card");
    expect(hit?.details?.plausible).toBe(true);
  });

  test("A2A agent card + agent-skills manifest both reported", () => {
    const checks = run([
      probe({ path: "/.well-known/agent-card.json", status: 200, jsonValid: true, jsonKeys: ["name"] }),
      probe({
        path: "/.well-known/agent-skills/index.json",
        status: 200,
        jsonValid: true,
        jsonKeys: ["skills"],
      }),
    ]);
    const hits = checks.filter((c) => c.name === "well-known-agent-present");
    expect(hits).toHaveLength(2);
    expect(hits.some((c) => c.message.includes("A2A agent card"))).toBe(true);
    expect(hits.some((c) => c.message.includes("agent-skills manifest"))).toBe(true);
  });

  test("SPA-fallback 200 HTML at MCP path is not a hit", () => {
    const checks = run([probe({ path: "/.well-known/mcp.json", status: 200, looksHtml: true })]);
    expect(checks[0]?.value).toBe("absent");
  });

  test("deprecated ai-plugin.json → warn, alongside absence of real manifests", () => {
    const checks = run([
      probe({
        path: "/.well-known/ai-plugin.json",
        status: 200,
        jsonValid: true,
        jsonKeys: ["schema_version"],
      }),
    ]);
    const absent = checks.find((c) => c.name === "well-known-agent");
    expect(absent?.value).toBe("absent");
    const deprecated = checks.find((c) => c.name === "well-known-agent-deprecated");
    expect(deprecated?.status).toBe("warn");
    expect(deprecated?.message).toContain("deprecated");
  });
});
