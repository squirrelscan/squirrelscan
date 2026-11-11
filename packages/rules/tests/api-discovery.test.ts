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

const CATALOG_BODY =
  '{"linkset":[{"anchor":"https://example.invalid/","item":[{"href":"https://example.invalid/api"}]}]}';

function catalog(body: string, over: Partial<WellKnownProbe> = {}): WellKnownProbe {
  return probe({
    status: 200,
    contentType: "application/linkset+json",
    bodySize: body.length,
    jsonValid: true,
    jsonKeys: ["linkset"],
    excerpt: body,
    ...over,
  });
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
    const checks = run([catalog(CATALOG_BODY)]);
    expect(checks.find((c) => c.name === "api-discovery")?.value).toBe("present");
  });

  // #1650: the catalog is validated as a non-empty linkset and each failure has its own state.
  describe("api-catalog states (#1650)", () => {
    const api = (probes: WellKnownProbe[]) => run(probes).find((c) => c.name === "api-discovery");

    test("non-empty linkset → present, media type recorded", () => {
      const c = api([catalog(CATALOG_BODY)]);
      expect(c?.value).toBe("present");
      expect(c?.details).toMatchObject({ apiCatalogState: "present", apiCatalogMediaTypeOk: true });
    });

    test("wrong media type still present, flagged in details", () => {
      const c = api([catalog(CATALOG_BODY, { contentType: "application/json" })]);
      expect(c?.value).toBe("present");
      expect(c?.details).toMatchObject({ apiCatalogMediaTypeOk: false });
    });

    test("truncated excerpt of a large catalog is still present", () => {
      const c = api([catalog(CATALOG_BODY.slice(0, 40))]);
      expect(c?.value).toBe("present");
    });

    test("empty linkset → empty-linkset", () => {
      expect(api([catalog('{"linkset":[]}')])?.value).toBe("empty-linkset");
    });

    test("linkset with no link objects is empty, a non-list is invalid-linkset", () => {
      expect(api([catalog('{"linkset":["x"]}')])?.value).toBe("empty-linkset");
      expect(api([catalog('{"linkset":"x"}')])?.value).toBe("invalid-linkset");
    });

    test("JSON without linkset → not-a-catalog; OpenAPI document is told apart", () => {
      expect(api([catalog('{"a":1}', { jsonKeys: ["a"] })])?.value).toBe("not-a-catalog");
      expect(
        api([catalog('{"openapi":"3.0.0"}', { jsonKeys: ["openapi"] })])?.value,
      ).toBe("openapi-document");
    });

    test("malformed JSON → malformed-json", () => {
      const c = api([catalog('{"linkset":[', { jsonValid: false, jsonKeys: [] })]);
      expect(c?.value).toBe("malformed-json");
    });

    test("200 HTML fallback → html-fallback", () => {
      const c = api([
        catalog("<!doctype html><html></html>", {
          looksHtml: true,
          jsonValid: false,
          jsonKeys: [],
          contentType: "text/html",
        }),
      ]);
      expect(c?.value).toBe("html-fallback");
    });

    test("the six states that are not a catalog are distinct, and none is the present state", () => {
      const values = [
        catalog('{"linkset":[]}'),
        catalog('{"linkset":"x"}'),
        catalog('{"a":1}', { jsonKeys: ["a"] }),
        catalog('{"openapi":"3.0.0"}', { jsonKeys: ["openapi"] }),
        catalog("{", { jsonValid: false, jsonKeys: [] }),
        catalog("<html>", { looksHtml: true, jsonValid: false, jsonKeys: [] }),
      ].map((p) => api([p])?.value);
      expect(values).toEqual([
        "empty-linkset",
        "invalid-linkset",
        "not-a-catalog",
        "openapi-document",
        "malformed-json",
        "html-fallback",
      ]);
      expect(new Set(values).size).toBe(6);
      expect(values).not.toContain("present");
    });

    test.each([401, 403, 429, 503])("HTTP %d → not checked, never absent", (status) => {
      const c = api([probe({ status })]);
      expect(c?.value).toBe("not-checked");
      expect(c?.status).toBe("info");
      expect(c?.details).toMatchObject({ blocked: { "/.well-known/api-catalog": status } });
    });

    test("404 on every API path stays absent", () => {
      expect(api([])?.value).toBe("absent");
    });

    test("a blocked OpenAPI path is not checked even when the catalog was 404", () => {
      const c = api([probe({ path: "/openapi.json", status: 403 })]);
      expect(c?.value).toBe("not-checked");
    });

    test("a catalog hit still wins over a blocked OpenAPI path", () => {
      const c = api([catalog(CATALOG_BODY), probe({ path: "/openapi.json", status: 429 })]);
      expect(c?.value).toBe("present");
    });
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
