// ax/rsl-license — robots.txt License: directive + RSL document validation.

import { describe, expect, test } from "bun:test";

import type { CheckResult, RslData, RslLicenseDoc } from "@squirrelscan/core-contracts";

import { rslLicenseRule } from "../src/ax/rsl-license";
import type { ParsedPage, RuleContext } from "../src/types";

function doc(over: Partial<RslLicenseDoc> = {}): RslLicenseDoc {
  return {
    url: "https://example.com/license.xml",
    status: 200,
    contentType: "application/rsl+xml",
    xmlValid: true,
    looksRsl: true,
    excerpt: "<rsl/>",
    error: null,
    ...over,
  };
}

function rsl(over: Partial<RslData> = {}): RslData {
  return {
    licenseUrls: [],
    robotsHasLicense: false,
    linkHeaderPresent: false,
    documents: [],
    ...over,
  };
}

function ctx(data: RslData | null | undefined): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, rsl: data },
    options: {},
  };
}

function run(data: RslData | null | undefined): CheckResult[] {
  return rslLicenseRule.run(ctx(data)).checks;
}

describe("ax/rsl-license", () => {
  test("data unavailable → info, no crash", () => {
    const checks = run(undefined);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("not available");
  });

  test("no signal at all → single absent info", () => {
    const checks = run(rsl());
    expect(checks).toHaveLength(1);
    expect(checks[0]?.value).toBe("absent");
    expect(checks[0]?.status).toBe("info");
  });

  test("valid RSL document → present + valid, both info", () => {
    const checks = run(
      rsl({
        robotsHasLicense: true,
        licenseUrls: ["https://example.com/license.xml"],
        documents: [doc()],
      }),
    );
    expect(checks.find((c) => c.name === "rsl-license-present")?.value).toBe("present");
    const valid = checks.find((c) => c.name === "rsl-license-valid");
    expect(valid?.status).toBe("info");
    expect(valid?.value).toBe("valid");
  });

  test("License: declared but document unfetchable → warn", () => {
    const checks = run(
      rsl({
        robotsHasLicense: true,
        licenseUrls: ["https://example.com/license.xml"],
        documents: [doc({ status: 0, xmlValid: false, looksRsl: false, error: "network error" })],
      }),
    );
    const valid = checks.find((c) => c.name === "rsl-license-valid");
    expect(valid?.status).toBe("warn");
    expect(valid?.value).toBe("broken");
    expect(valid?.message).toContain("network error");
  });

  test("License: declared but document doesn't parse as RSL → warn", () => {
    const checks = run(
      rsl({
        robotsHasLicense: true,
        licenseUrls: ["https://example.com/license.xml"],
        documents: [doc({ xmlValid: true, looksRsl: false })],
      }),
    );
    const valid = checks.find((c) => c.name === "rsl-license-valid");
    expect(valid?.status).toBe("warn");
  });

  test("Link: rel=license header alone counts as a signal", () => {
    const checks = run(rsl({ linkHeaderPresent: true, licenseUrls: ["https://example.com/l.xml"] }));
    expect(checks.find((c) => c.name === "rsl-license-present")?.value).toBe("present");
  });
});
