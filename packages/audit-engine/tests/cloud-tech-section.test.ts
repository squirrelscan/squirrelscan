// #369 — a cloud audit must attach detected technologies to `report.technologies`
// so the report-publish path persists them to the per-website snapshot the
// dashboard reads. Before this, runCloudAudit returned `technologies` only in a
// side field, so cloud audits left websiteTechnologies empty ("0 detected").

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "@squirrelscan/tech-detect";

import {
  buildReportTechnologies,
  detectReportTechnologies,
  detectReportTechnologiesMulti,
} from "../src/technologies";

describe("buildReportTechnologies", () => {
  test("maps the detected stack into a report section (no diff → empty/false)", () => {
    const section = buildReportTechnologies([
      {
        id: "wix",
        name: "Wix",
        category: "cms",
        version: null,
        confidence: "high",
        detectedBy: "html:static.wixstatic.com",
      },
    ]);

    expect(section.items.map((t) => t.id)).toEqual(["wix"]);
    expect(section.added).toEqual([]);
    expect(section.removed).toEqual([]);
    expect(section.firstScan).toBe(false);
    expect(section.advisories).toBeUndefined();
  });

  test("carries the cloud cross-scan diff and non-empty advisories", () => {
    const section = buildReportTechnologies(
      [
        {
          id: "wix",
          name: "Wix",
          category: "cms",
          version: null,
          confidence: "high",
          detectedBy: "meta:generator",
        },
      ],
      {
        added: ["wix"],
        removed: ["squarespace"],
        firstScan: true,
        advisories: [
          {
            techId: "wix",
            techName: "Wix",
            installedVersion: null,
            severity: "low",
            kind: "outdated",
            title: "x",
          },
        ],
      },
    );

    expect(section.added).toEqual(["wix"]);
    expect(section.removed).toEqual(["squarespace"]);
    expect(section.firstScan).toBe(true);
    expect(section.advisories).toHaveLength(1);
  });

  test("omits the advisories key when the diff carries an empty list", () => {
    const section = buildReportTechnologies([], {
      added: [],
      removed: [],
      firstScan: false,
      advisories: [],
    });
    expect("advisories" in section).toBe(false);
  });

  // Ties the fix to real detection: a Wix page (e.g. ovasbuild.com.au) fingerprints
  // to "wix", which the section then carries into report.technologies for publish.
  test("a Wix page fingerprints into the report section", () => {
    const detected = detectTechnologies({
      url: "https://ovasbuild.com.au/",
      headers: { "content-type": "text/html" },
      html: '<html><head><meta name="generator" content="Wix.com Website Builder"></head><body><img src="https://static.wixstatic.com/media/x.jpg"></body></html>',
    });
    const section = buildReportTechnologies(detected);
    expect(section.items.some((t) => t.id === "wix")).toBe(true);
  });
});

// #407 — the CLI base path (and cloud-runner's fallback) call this so quick /
// logged-out audits still surface technologies without a credited cloud call.
describe("detectReportTechnologies (local base scan)", () => {
  test("detects a generator-only CMS + appends the WAF as a security tech", () => {
    const section = detectReportTechnologies({
      url: "https://ovasbuild.com.au/",
      headers: { server: "cloudflare", "cf-ray": "abc123" },
      // No static.wixstatic.com marker → wix can only come from the auto-parsed meta.
      html: `<head><meta name="generator" content="Wix.com Website Builder"></head>`,
      scripts: [],
    });
    const ids = section.items.map((t) => t.id);
    expect(ids).toContain("wix");
    expect(ids).toContain("waf-cloudflare");
    expect(section.items.find((t) => t.id === "waf-cloudflare")?.category).toBe("security");
    expect(section.added).toEqual([]);
    expect(section.firstScan).toBe(false);
  });

  test("a bare page yields no WAF false-positive", () => {
    const section = detectReportTechnologies({
      url: "https://example.com/",
      headers: {},
      html: `<!doctype html><html><body><h1>hi</h1></body></html>`,
      scripts: [],
    });
    expect(section.items.some((t) => t.id === "waf-cloudflare")).toBe(false);
  });

  // Unions across crawled pages so inner-page-only tech isn't dropped as "removed"
  // when the section is published (#407) — a home-only scan would miss it.
  test("unions technologies detected on non-home pages", () => {
    const section = detectReportTechnologiesMulti([
      {
        url: "https://shop.example/",
        headers: {},
        html: `<head><meta name="generator" content="Wix.com Website Builder"></head>`,
        scripts: [],
      },
      {
        // Stripe only appears on an inner page.
        url: "https://shop.example/checkout",
        headers: {},
        html: `<script src="https://js.stripe.com/v3/"></script>`,
        scripts: [],
      },
    ]);
    const ids = section.items.map((t) => t.id);
    expect(ids).toContain("wix");
    expect(ids).toContain("stripe");
  });
});
