// schema/local-business — array-wrapped address completeness, issue #711.
//
// Some JSON-LD generators emit `"address": [{...PostalAddress...}]` (a single
// PostalAddress wrapped in a one-element array). The completeness check used to
// index subfields directly on the array, so a fully-populated wrapped address
// reported streetAddress/addressLocality/postalCode as missing. These lock in:
// a wrapped complete address passes, multi-entry arrays pass if any entry is
// complete (matching the sibling areaServed `.some()` semantics), and plain
// object handling is unchanged.

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

const COMPLETE = {
  "@type": "PostalAddress",
  streetAddress: "123 Main St",
  addressLocality: "Sydney",
  postalCode: "2000",
};

describe("schema/local-business — array-wrapped address (#711)", () => {
  test("array-wrapped fully-populated address → no address-completeness warning", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Wrapped Address Co",
      address: [COMPLETE],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));

    expect(check(checks, "local-business-address")).toBeUndefined();
    // Address IS present (wrapped), so the SAB location check must not fire.
    expect(check(checks, "local-business-location")).toBeUndefined();
    expect(checks.some((c) => c.status === "warn")).toBe(false);
  });

  test("array with multiple addresses, one complete → passes (any-complete)", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Two Locations",
      address: [{ "@type": "PostalAddress", streetAddress: "1 Small Ln" }, COMPLETE],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));

    expect(check(checks, "local-business-address")).toBeUndefined();
  });

  test("array with multiple addresses, none complete → warns on first entry's missing fields", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Two Bad Locations",
      address: [
        { "@type": "PostalAddress", streetAddress: "1 Small Ln" },
        { "@type": "PostalAddress", addressLocality: "Perth" },
      ],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    const addressCheck = check(checks, "local-business-address");

    expect(addressCheck?.status).toBe("warn");
    expect(addressCheck?.items?.map((i) => i.id)).toEqual(["addressLocality", "postalCode"]);
  });

  test("single-element array with incomplete address → warns with that entry's missing fields", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Wrapped Half Store",
      address: [{ "@type": "PostalAddress", streetAddress: "123 Main St" }],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    const addressCheck = check(checks, "local-business-address");

    expect(addressCheck?.status).toBe("warn");
    expect(addressCheck?.items?.map((i) => i.id)).toEqual(["addressLocality", "postalCode"]);
  });

  test("array with null entry plus complete address → passes without crashing", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Null Then Complete",
      address: [null, COMPLETE],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));

    expect(check(checks, "local-business-address")).toBeUndefined();
  });

  test("array of only null → warns with all subfields missing, no crash", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Null Address Co",
      address: [null],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    const addressCheck = check(checks, "local-business-address");

    expect(addressCheck?.status).toBe("warn");
    expect(addressCheck?.items?.map((i) => i.id)).toEqual([
      "streetAddress",
      "addressLocality",
      "postalCode",
    ]);
  });

  test("empty address array → treated as no address, SAB location check warns (#724)", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Empty Address Co",
      address: [],
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));

    // No "Address incomplete" warning — falls through to the location guidance.
    expect(check(checks, "local-business-address")).toBeUndefined();
    const locationCheck = check(checks, "local-business-location");
    expect(locationCheck?.status).toBe("warn");
    expect(locationCheck?.message).toBe("LocalBusiness schema has no address or service area");
  });

  test("empty address array with areaServed → SAB path passes (#724)", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Empty Address SAB",
      address: [],
      areaServed: "Sydney NSW",
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));

    expect(check(checks, "local-business-address")).toBeUndefined();
    expect(check(checks, "local-business-location")?.status).toBe("pass");
  });

  test("plain object full PostalAddress → still passes (regression)", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Corner Store",
      address: COMPLETE,
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));

    expect(check(checks, "local-business-address")).toBeUndefined();
    expect(check(checks, "local-business-location")).toBeUndefined();
  });

  test("plain object incomplete PostalAddress → still warns with correct missing fields (regression)", () => {
    const html = withSchema({
      "@type": "LocalBusiness",
      name: "Half Store",
      address: { "@type": "PostalAddress", streetAddress: "123 Main St" },
    });
    const checks = run(localBusinessSchemaRule, pageCtx(html));
    const addressCheck = check(checks, "local-business-address");

    expect(addressCheck?.status).toBe("warn");
    expect(addressCheck?.items?.map((i) => i.id)).toEqual(["addressLocality", "postalCode"]);
  });
});
