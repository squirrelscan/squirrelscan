// ax/well-known-agent — MCP server card, A2A agent card, agent-skills, deprecated ai-plugin.json.

import { describe, expect, test } from "bun:test";

import { PROBE_NOT_ATTEMPTED_ERROR, WELL_KNOWN_PATHS } from "@squirrelscan/core-contracts/storage";

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

// The crawler's default sweep stores one row per well-known path, so a path the
// test does not set is one that was requested and answered 404.
function sweep(probes: WellKnownProbe[]): WellKnownProbe[] {
  return WELL_KNOWN_PATHS.map(
    (path) =>
      probes.find((p) => p.path === path) ??
      probe({ path, url: `https://example.com${path}`, status: 404 }),
  );
}

function ctx(probes: WellKnownProbe[] | null | undefined, raw = false): RuleContext {
  const wk: WellKnownProbeData | null = probes ? { probes: raw ? probes : sweep(probes) } : null;
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, wellKnown: wk },
    options: {},
  };
}

function run(probes: WellKnownProbe[] | null | undefined, raw = false): CheckResult[] {
  return wellKnownAgentRule.run(ctx(probes, raw)).checks;
}

describe("ax/well-known-agent", () => {
  test("data unavailable → not checked info, no crash", () => {
    const checks = run(undefined);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.message).toContain("not checked");
  });

  // #409: a path the sweep never requested says nothing about the site.
  test("manifest paths missing from the sweep → not checked, never absent", () => {
    const checks = run([probe({ path: "/AGENTS.md", status: 404 })], true);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.message).not.toContain("No MCP");
  });

  test("manifest paths skipped by the preamble budget → not checked", () => {
    const skipped = sweep([]).map((p) =>
      p.path === "/.well-known/mcp.json" ? { ...p, status: 0, error: PROBE_NOT_ATTEMPTED_ERROR } : p,
    );
    const checks = run(skipped, true);
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.details?.notChecked).toEqual(["/.well-known/mcp.json"]);
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
