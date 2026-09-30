// ax/api-discovery — api-catalog, OpenAPI, and OAuth (DCR/CIMD self-onboarding) discovery.

import { describe, expect, test } from "bun:test";

import { WELL_KNOWN_PATHS } from "@squirrelscan/core-contracts/storage";

import type { CheckResult, WellKnownProbe, WellKnownProbeData } from "@squirrelscan/core-contracts";

import { apiDiscoveryRule } from "../src/ax/api-discovery";
import type { ParsedPage, RuleContext } from "../src/types";

function probe(over: Partial<WellKnownProbe> = {}): WellKnownProbe {
  return {
    path: "/.well-known/api-catalog",
    url: "https://example.com/.well-known/api-catalog",
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
  return apiDiscoveryRule.run(ctx(probes, raw)).checks;
}

describe("ax/api-discovery", () => {
  test("data unavailable → not checked info, no crash", () => {
    const checks = run(undefined);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.message).toContain("not checked");
  });

  // #409: `--rule-exclude` of this rule, or probes off, leaves its paths out of
  // the sweep. That is not evidence the documents are missing.
  test("API and OAuth paths missing from the sweep → both not checked", () => {
    const checks = run([probe({ path: "/AGENTS.md", status: 404 })], true);
    expect(checks.map((c) => [c.name, c.value])).toEqual([
      ["api-discovery", "not-checked"],
      ["api-discovery-oauth", "not-checked"],
    ]);
    expect(checks.every((c) => c.status === "info")).toBe(true);
  });

  test("a hit still counts when another API path was not requested", () => {
    const checks = run(
      [probe({ path: "/openapi.json", status: 200, jsonValid: true, jsonKeys: ["openapi"] })],
      true,
    );
    expect(checks.find((c) => c.name === "api-discovery")?.value).toBe("present");
  });

  test("nothing found → two quiet absent checks (catalog/openapi + oauth)", () => {
    const checks = run([]);
    expect(checks.every((c) => c.status === "info")).toBe(true);
    expect(checks.find((c) => c.name === "api-discovery")?.value).toBe("absent");
    expect(checks.find((c) => c.name === "api-discovery-oauth")?.value).toBe("absent");
  });

  test("api-catalog hit → present", () => {
    const checks = run([
      probe({ path: "/.well-known/api-catalog", status: 200, jsonValid: true, jsonKeys: ["linkset"] }),
    ]);
    expect(checks.find((c) => c.name === "api-discovery")?.value).toBe("present");
  });

  test("openapi.json validated by jsonKeys → present", () => {
    const checks = run([
      probe({ path: "/openapi.json", status: 200, jsonValid: true, jsonKeys: ["openapi", "paths"] }),
    ]);
    expect(checks.find((c) => c.name === "api-discovery")?.value).toBe("present");
  });

  test("swagger.json without a version field is not counted as a hit", () => {
    const checks = run([
      probe({ path: "/swagger.json", status: 200, jsonValid: true, jsonKeys: ["unrelated"], excerpt: "{}" }),
    ]);
    expect(checks.find((c) => c.name === "api-discovery")?.value).toBe("absent");
  });

  test("OAuth AS metadata with registration_endpoint → self-onboarding info", () => {
    const checks = run([
      probe({
        path: "/.well-known/oauth-authorization-server",
        status: 200,
        jsonValid: true,
        jsonKeys: ["issuer"],
        oauthRegistrationEndpoint: "https://auth.example.com/register",
      }),
    ]);
    const oauth = checks.find((c) => c.name === "api-discovery-oauth");
    expect(oauth?.value).toBe("self-onboarding");
    expect(oauth?.status).toBe("info");
  });

  test("OAuth AS metadata with CIMD flag → self-onboarding info", () => {
    const checks = run([
      probe({
        path: "/.well-known/oauth-authorization-server",
        status: 200,
        jsonValid: true,
        jsonKeys: ["issuer"],
        oauthClientIdMetadataDocumentSupported: true,
      }),
    ]);
    expect(checks.find((c) => c.name === "api-discovery-oauth")?.value).toBe("self-onboarding");
  });

  test("OAuth AS metadata with neither DCR nor CIMD → suggests adding one", () => {
    const checks = run([
      probe({
        path: "/.well-known/oauth-authorization-server",
        status: 200,
        jsonValid: true,
        jsonKeys: ["issuer"],
      }),
    ]);
    const oauth = checks.find((c) => c.name === "api-discovery-oauth");
    expect(oauth?.value).toBe("no-self-onboarding");
    expect(oauth?.status).toBe("info");
    expect(oauth?.message).toContain("human still has to register");
  });

  test("every check stays info — never penalizes", () => {
    const checks = run([
      probe({ path: "/.well-known/oauth-authorization-server", status: 200, jsonValid: true, jsonKeys: [] }),
    ]);
    expect(checks.every((c) => c.status === "info")).toBe(true);
  });
});
