// squirrelscan/repo#1733 — a probe that never got an answer is UNKNOWN, and
// must never be reported as a confirmed absence.
//
// `exists: false` / `discovered: []` each conflate two different worlds: the
// origin answered 404 (evidence of absence) and we never got an answer at all —
// a timeout, a 5xx, or a fetch the crawl cut short. Reporting the second as
// "No robots.txt found" or "No XML sitemap found" turns a check the audit never
// completed into a definite, high-weight defect on a site that may well have
// the file. Same rule as the content-encoding probes in public #9: a failed
// confirmation degrades to unknown, never to a negative.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  RobotsTxtData,
  RslData,
  RslLicenseDoc,
  SitemapDiscovery,
} from "@squirrelscan/core-contracts";

import { robotsTxtRule } from "../src/crawl/robots-txt";
import { sitemapExistsRule } from "../src/crawl/sitemap-exists";
import { rslLicenseRule } from "../src/ax/rsl-license";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(site: Partial<RuleContext["site"]>): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      ...site,
    } as RuleContext["site"],
    options: {},
  };
}

function robots(over: Partial<RobotsTxtData> = {}): RobotsTxtData {
  return {
    exists: false,
    url: "https://example.com/robots.txt",
    content: null,
    sizeBytes: 0,
    sitemaps: [],
    rules: [],
    errors: [],
    ...over,
  };
}

function sitemaps(over: Partial<SitemapDiscovery> = {}): SitemapDiscovery {
  return {
    discovered: [],
    sources: { robotsTxt: [], commonLocations: [] },
    totalUrls: 0,
    orphanPages: [],
    missingPages: [],
    failed: [],
    ...over,
  };
}

const byName = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

describe("crawl/robots-txt does not report a missing file it never confirmed", () => {
  test("a probe that never completed reports unknown, not a failure", () => {
    // Anything the crawler records a reason for: a budget-skipped fetch, a
    // timeout, a 5xx. None of them establish that robots.txt is absent.
    for (const reason of ["crawl phase budget exhausted", "The operation timed out", "HTTP 503"]) {
      const checks = robotsTxtRule.run(ctx({ robotsTxt: robots({ errors: [reason] }) })).checks;
      const check = byName(checks, "robots-txt-exists");

      expect(check?.status).toBe("info");
      expect(check?.message).not.toContain("No robots.txt found");
      // The internal skip marker must never reach user-facing copy.
      expect(JSON.stringify(check)).not.toContain("budget exhausted");
    }
  });

  test("a confirmed 404 still fails — this must not blanket-suppress the finding", () => {
    // The crawler records NO error for a clean 404, which is the whole
    // discriminator. Losing this case would trade a false positive for a false
    // negative and make the rule useless.
    const checks = robotsTxtRule.run(ctx({ robotsTxt: robots({ errors: [] }) })).checks;
    const check = byName(checks, "robots-txt-exists");

    expect(check?.status).toBe("fail");
    expect(check?.message).toBe("No robots.txt found");
  });
});

describe("crawl/sitemap-exists does not report a missing sitemap it never looked for", () => {
  test("a truncated discovery reports unknown, not a failure", () => {
    const checks = sitemapExistsRule.run(
      ctx({ sitemaps: sitemaps({ truncated: true }), robotsTxt: robots() }),
    ).checks;
    const check = byName(checks, "sitemap-exists");

    expect(check?.status).toBe("info");
    expect(check?.message).not.toContain("No XML sitemap found");
  });

  test("a completed discovery that found nothing still fails", () => {
    const checks = sitemapExistsRule.run(
      ctx({ sitemaps: sitemaps({ truncated: false }), robotsTxt: robots() }),
    ).checks;
    const check = byName(checks, "sitemap-exists");

    expect(check?.status).toBe("fail");
    expect(check?.message).toBe("No XML sitemap found");
  });

  test("an absent `truncated` (older reports) reads as a completed walk", () => {
    // The field is optional so pre-#1733 persisted reports still score the same.
    const checks = sitemapExistsRule.run(ctx({ sitemaps: sitemaps(), robotsTxt: robots() })).checks;

    expect(byName(checks, "sitemap-exists")?.status).toBe("fail");
  });
});

describe("ax/rsl-license does not call an unreachable document broken", () => {
  const unreachable: RslLicenseDoc = {
    url: "https://example.com/license.xml",
    status: 0,
    contentType: null,
    xmlValid: false,
    looksRsl: false,
    excerpt: "",
    error: "crawl phase budget exhausted",
  };

  function rsl(documents: RslLicenseDoc[]): RslData {
    return {
      licenseUrls: documents.map((d) => d.url),
      robotsHasLicense: true,
      linkHeaderPresent: false,
      documents,
    };
  }

  test("status 0 reports unknown and does not leak the internal reason", () => {
    const checks = rslLicenseRule.run(ctx({ rsl: rsl([unreachable]) } as never)).checks;
    const check = byName(checks, "rsl-license-valid");

    expect(check?.status).toBe("info");
    expect(check?.value).toBe("unknown");
    // "crawl phase budget exhausted" is an internal detail, not user-facing copy.
    expect(JSON.stringify(check)).not.toContain("budget exhausted");
  });

  test("a document that genuinely resolved wrong is still reported broken", () => {
    const notRsl: RslLicenseDoc = { ...unreachable, status: 200, error: null };
    const checks = rslLicenseRule.run(ctx({ rsl: rsl([notRsl]) } as never)).checks;

    expect(byName(checks, "rsl-license-valid")?.status).toBe("warn");
  });
});
