// Test fixtures for report tests

import type { AuditReport, ReportRuleResult, SiteMetadata } from "@/types";

/**
 * Minimal valid AuditReport for testing
 */
export function createMinimalReport(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2024-01-15T10:30:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 3,
    failed: 2,
    siteChecks: [],
    pages: [],
    summary: {
      missingTitles: [],
      missingDescriptions: [],
      missingOgTags: [],
      missingTwitterCards: [],
      missingSchemas: [],
      missingAltText: [],
      multipleH1s: [],
      thinContentPages: [],
      urlIssues: [],
      redirectChains: [],
      securityIssues: [],
    },
    healthScore: {
      overall: 85,
      categories: [
        {
          category: "core",
          name: "Core SEO",
          score: 80,
          passed: 8,
          warnings: 1,
          failed: 1,
          total: 10,
        },
        {
          category: "content",
          name: "Content",
          score: 90,
          passed: 9,
          warnings: 1,
          failed: 0,
          total: 10,
        },
      ],
      errorCount: 2,
      warningCount: 3,
      passedCount: 10,
    },
    ruleResults: {},
  };
}

/**
 * Report with issues for testing output
 */
export function createReportWithIssues(): AuditReport {
  const report = createMinimalReport();

  const ruleResult: ReportRuleResult = {
    meta: {
      id: "core/meta-title",
      name: "Meta Title",
      description: "Every page should have a unique meta title",
      solution: "Add a <title> tag to your HTML",
      category: "core",
      scope: "page",
      severity: "error",
      weight: 10,
    },
    checks: [
      {
        name: "missing-title",
        status: "fail",
        message: "Missing page title",
        items: [
          {
            id: "https://example.com/about",
            label: "/about",
            sourcePages: ["https://example.com/"],
          },
          {
            id: "https://example.com/contact",
            label: "/contact",
          },
        ],
      },
      {
        name: "duplicate-title",
        status: "warn",
        message: "Duplicate title found",
        pageUrl: "https://example.com/blog",
      },
    ],
  };

  report.ruleResults = {
    "core/meta-title": ruleResult,
  };

  return report;
}

/**
 * Report with XSS test content
 */
export function createReportWithXssContent(): AuditReport {
  const report = createMinimalReport();

  const ruleResult: ReportRuleResult = {
    meta: {
      id: "test/xss",
      name: '<script>alert("xss")</script>',
      description: "Test <b>HTML</b> & special chars",
      solution: 'Use "escaping" for <tags>',
      category: "core",
      scope: "site",
      severity: "warning",
      weight: 5,
    },
    checks: [
      {
        name: "xss-check",
        status: "warn",
        message: 'Contains <script> & "quotes"',
      },
    ],
  };

  report.ruleResults = {
    "test/xss": ruleResult,
  };

  return report;
}

/**
 * A representative resolved site profile (mirrors the docs example).
 */
export function createSiteMetadata(): SiteMetadata {
  return {
    siteType: "smb_local",
    businessCategory: "auto_repair",
    primaryCountry: "US",
    audienceScope: "local",
    languages: ["en"],
    title: "Riverside Auto Care",
    entityName: "Riverside Auto Care",
    entityType: "organization",
    entityUrl: "https://riversideauto.example/about",
    contacts: [
      { kind: "phone", value: "+1 555-0100" },
      { kind: "email", value: "hello@riversideauto.example" },
    ],
    socials: [
      { platform: "facebook", url: "https://facebook.com/riversideauto" },
      { platform: "instagram", url: "https://instagram.com/riversideauto" },
    ],
    isYMYL: false,
    isLocalBusiness: true,
    hasOwnershipVerified: false,
    confidence: "high",
    registrar: "Example Registrar, Inc.",
    registeredAt: "2017-04-02T00:00:00.000Z",
    domainAgeDays: 2900,
  };
}

/**
 * Minimal report with a resolved site profile (and otherwise no issues).
 */
export function createReportWithSiteMetadata(): AuditReport {
  const report = createMinimalReport();
  report.siteMetadata = createSiteMetadata();
  return report;
}

/**
 * Report with legacy check.value (deprecated field)
 */
export function createReportWithLegacyValue(): AuditReport {
  const report = createMinimalReport();

  const ruleResult: ReportRuleResult = {
    meta: {
      id: "test/legacy",
      name: "Legacy Rule",
      description: "Tests legacy value field",
      category: "core",
      scope: "site",
      severity: "info",
      weight: 1,
    },
    checks: [
      {
        name: "legacy-check",
        status: "warn",
        message: "Has legacy value",
        value: "Line 1\n  Subline 1\n  Subline 2\nLine 2",
      },
    ],
  };

  report.ruleResults = {
    "test/legacy": ruleResult,
  };

  return report;
}
