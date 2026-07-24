// schema/local-business — service-area business (SAB) support, issue #700.
//
// LocalBusiness previously required a streetAddress unconditionally, forcing
// service-area businesses (mobile tradies, etc. — no public storefront) to
// either fabricate an address or eat a warning. Google's own guidance is that
// an SAB should omit the address and declare areaServed/serviceArea instead.
// This file locks in: SAB passes with areaServed + no address, a storefront
// with neither still flags (with dual-path messaging), a full PostalAddress
// is unaffected, and @graph-wrapped (Yoast-style) LocalBusiness nodes parse.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { localBusinessSchemaRule } from "../src/schema/local-business";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

function pageCtx(html: string, url = "https://example.com/"): RuleContext {
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
}

function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  return rule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

function withSchema(schema: unknown): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(
    schema,
  )}</script></head><body><p>content</p></body></html>`;
}

describe("schema/local-business — SAB support (#700)", () => {
  test("SAB with areaServed (plain text), no address → passes, no warning", () => {
    const html = withSchema({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Bob's Mobile Carpentry",
      areaServed: "Sydney, NSW",
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));

    expect(check(checks, "local-business-location")?.status).toBe("pass");
    expect(check(checks, "local-business-required")?.status).toBe("pass");
    expect(check(checks, "local-business-address")).toBeUndefined();
    expect(checks.some((c) => c.status === "warn")).toBe(false);
  });

  test("SAB with areaServed as an array of strings → passes", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Roving Repairs",
      areaServed: ["Sydney", "Parramatta", "Newcastle"],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")?.status).toBe("pass");
  });

  test("SAB with structured GeoShape areaServed → passes", () => {
    const html = withSchema({
      "@type": "Plumber",
      name: "Acme Plumbing",
      areaServed: {
        "@type": "GeoShape",
        geoRadius: "50000",
        address: { "@type": "PostalAddress", addressLocality: "Sydney" },
      },
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")?.status).toBe("pass");
  });

  test("SAB with bare-geometry GeoShape areaServed (polygon only) → passes", () => {
    const html = withSchema({
      "@type": "Electrician",
      name: "Sparky South Coast",
      areaServed: {
        "@type": "GeoShape",
        polygon: "-34.4 150.8 -34.5 150.9 -34.6 150.7",
      },
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")?.status).toBe("pass");
  });

  test("SAB with structured AdministrativeArea areaServed → passes", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Acme Electrical",
      areaServed: { "@type": "AdministrativeArea", name: "Greater Sydney" },
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")?.status).toBe("pass");
  });

  test("SAB using legacy serviceArea property (instead of areaServed) → passes", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Legacy Landscaping",
      serviceArea: { "@type": "AdministrativeArea", name: "Melbourne" },
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")?.status).toBe("pass");
  });

  test("empty areaServed object → does NOT count as a service area", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Vague Business",
      areaServed: {},
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")?.status).toBe("warn");
  });

  test("areaServed as an @id reference resolved to a real Place node → passes", () => {
    const html = withSchema({
      "@graph": [
        {
          "@type": "LocalBusiness",
          name: "Referencing Business",
          areaServed: { "@id": "#servicearea" },
        },
        { "@id": "#servicearea", "@type": "AdministrativeArea", name: "Greater Sydney" },
      ],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")?.status).toBe("pass");
  });

  test("areaServed as a dangling @id reference (no matching node) → still warns", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Broken Reference Business",
      areaServed: { "@id": "#nowhere" },
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")?.status).toBe("warn");
  });

  test("string address (informal, no structure) → still warns on completeness, unchanged from before #700", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Informal Address Co",
      address: "123 Main St, Sydney NSW 2000",
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    const addressCheck = check(checks, "local-business-address");

    expect(addressCheck?.status).toBe("warn");
    // Address IS present (even if informal) — the SAB location check must not fire.
    expect(check(checks, "local-business-location")).toBeUndefined();
  });

  test("storefront with neither address nor areaServed → still flags, dual-path message", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Mystery Shop",
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    const location = check(checks, "local-business-location");

    expect(location?.status).toBe("warn");
    expect(location?.value).toContain("PostalAddress");
    expect(location?.value).toContain("areaServed");
  });

  test("full PostalAddress → passes unchanged (no location check, no warnings)", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Corner Store",
      address: {
        "@type": "PostalAddress",
        streetAddress: "123 Main St",
        addressLocality: "Sydney",
        postalCode: "2000",
      },
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));

    expect(check(checks, "local-business-required")?.status).toBe("pass");
    expect(check(checks, "local-business-location")).toBeUndefined();
    expect(check(checks, "local-business-address")).toBeUndefined();
  });

  test("incomplete PostalAddress (present but missing fields) → still warns on completeness", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Half Store",
      address: { "@type": "PostalAddress", streetAddress: "123 Main St" },
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    const addressCheck = check(checks, "local-business-address");

    expect(addressCheck?.status).toBe("warn");
    expect(addressCheck?.items?.map((i) => i.id)).toEqual(["addressLocality", "postalCode"]);
    // Address IS present, so the SAB location check must not also fire.
    expect(check(checks, "local-business-location")).toBeUndefined();
  });

  test("@graph-wrapped LocalBusiness (Yoast-style) with areaServed → detected and passes", () => {
    const html = withSchema({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Example" },
        {
          "@type": "LocalBusiness",
          name: "Graph Business",
          areaServed: "Brisbane, QLD",
        },
      ],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));

    expect(check(checks, "local-business-location")?.status).toBe("pass");
    expect(check(checks, "local-business-schema")).toBeUndefined();
  });

  test("@graph-wrapped LocalBusiness with neither address nor areaServed → still flags", () => {
    const html = withSchema({
      "@graph": [{ "@type": "LocalBusiness", name: "Graph Shop" }],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")?.status).toBe("warn");
  });

  test("@graph-wrapped LocalBusiness subtype with full PostalAddress → passes unchanged", () => {
    const html = withSchema({
      "@graph": [
        {
          "@type": "Restaurant",
          name: "Graph Diner",
          address: {
            "@type": "PostalAddress",
            streetAddress: "1 Food St",
            addressLocality: "Perth",
            postalCode: "6000",
          },
        },
      ],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-location")).toBeUndefined();
    expect(check(checks, "local-business-address")).toBeUndefined();
  });

  test("no LocalBusiness schema at all → info, no location check", () => {
    const html = "<html><body><p>No schema here.</p></body></html>";
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    expect(check(checks, "local-business-schema")?.status).toBe("info");
    expect(check(checks, "local-business-location")).toBeUndefined();
  });
});
