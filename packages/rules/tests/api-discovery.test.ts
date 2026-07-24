// ax/api-discovery — api-catalog, OpenAPI, and OAuth (DCR/CIMD self-onboarding) discovery.

import { describe, expect, test } from "bun:test";

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
  return apiDiscoveryRule.run(ctx(probes)).checks;
}

describe("ax/api-discovery", () => {
  test("data unavailable → info, no crash", () => {
    const checks = run(undefined);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("not available");
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
