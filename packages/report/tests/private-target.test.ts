// pub#629: transport and delivery rules skipped for a local or private-network
// host are reported ONCE per report, never as issues and never per rule or page.

import { describe, expect, test } from "bun:test";

import { PRIVATE_TARGET_SKIP_REASON } from "@squirrelscan/core-contracts";

import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { privateTargetLine, privateTargetSkippedRules } from "../src/private-target";
import type { AuditReport, ReportRuleResult } from "../src/types";

function rule(id: string, name: string, checks: ReportRuleResult["checks"]): ReportRuleResult {
  return {
    meta: {
      id,
      name,
      description: `${name} description`,
      category: id.split("/")[0] ?? "other",
      scope: "page",
      severity: "warning",
      weight: 1,
    },
    checks,
  };
}

function privateSkip(id: string, pageUrl?: string): ReportRuleResult["checks"][number] {
  return {
    name: id,
    status: "skipped",
    message: "Not applicable: local or private-network host",
    skipReason: PRIVATE_TARGET_SKIP_REASON,
    details: { foldKey: PRIVATE_TARGET_SKIP_REASON },
    ...(pageUrl ? { pageUrl } : {}),
  };
}

const PAGES = ["http://localhost:3000/", "http://localhost:3000/about"];

function localReport(): AuditReport {
  return {
    baseUrl: "http://localhost:3000",
    timestamp: "2026-10-10T10:00:00.000Z",
    totalPages: 2,
    passed: 4,
    warnings: 0,
    failed: 0,
    ruleResults: {
      // A page rule skips once per page; a site rule once.
      "security/https": rule(
        "security/https",
        "HTTPS",
        PAGES.map((p) => privateSkip("security/https", p)),
      ),
      "perf/compression": rule(
        "perf/compression",
        "Compression",
        PAGES.map((p) => privateSkip("perf/compression", p)),
      ),
      "security/hsts": rule("security/hsts", "HSTS Header", [privateSkip("security/hsts")]),
      "core/meta-title": rule(
        "core/meta-title",
        "Meta Title",
        PAGES.map((p) => ({ name: "meta-title", status: "pass", message: "Title OK", pageUrl: p })),
      ),
    },
  };
}

const LINE =
  "Local or private-network host: 3 transport and delivery rules do not apply here and are not scored (Compression, HSTS Header, HTTPS).";

describe("privateTargetSkippedRules / privateTargetLine", () => {
  test("lists each skipped rule once, by name, however many pages it skipped", () => {
    expect(privateTargetSkippedRules(localReport())).toEqual([
      { id: "perf/compression", name: "Compression" },
      { id: "security/hsts", name: "HSTS Header" },
      { id: "security/https", name: "HTTPS" },
    ]);
    expect(privateTargetLine(localReport())).toBe(LINE);
  });

  test("singular wording for one rule", () => {
    const report = localReport();
    report.ruleResults = { "security/hsts": report.ruleResults["security/hsts"]! };
    expect(privateTargetLine(report)).toBe(
      "Local or private-network host: 1 transport and delivery rule does not apply here and is not scored (HSTS Header).",
    );
  });

  test("null for a public host and for other skip reasons", () => {
    const report = localReport();
    report.ruleResults = {
      "content/hidden-text": rule("content/hidden-text", "Hidden text", [
        { name: "hidden-text", status: "skipped", message: "x", skipReason: "scan-truncated" },
      ]),
      "core/meta-title": report.ruleResults["core/meta-title"]!,
    };
    expect(privateTargetSkippedRules(report)).toEqual([]);
    expect(privateTargetLine(report)).toBeNull();
  });

  test("no em-dash in the copy", () => {
    expect(LINE).not.toContain("—");
  });
});

describe("every renderer says it once and never as an issue", () => {
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  test("text", () => {
    const out = renderText(localReport());
    expect(count(out, LINE)).toBe(1);
  });

  test("markdown", () => {
    const out = renderMarkdown(localReport());
    expect(count(out, LINE)).toBe(1);
  });

  test("html", () => {
    const out = renderHtml(localReport());
    expect(count(out, LINE)).toBe(1);
  });

  test("llm: one not-applicable element listing the rules, and no issues", () => {
    const out = renderLlm(localReport());
    expect(count(out, '<not-applicable reason="private-target" count="3">')).toBe(1);
    expect(count(out, LINE)).toBe(1);
    expect(count(out, '<rule id="security/https" name="HTTPS"/>')).toBe(1);
    expect(out).toContain("<issues/>");
  });

  test("json: a notApplicable block, no issues, and not counted as skipped gaps", () => {
    const parsed = JSON.parse(renderJson(localReport()));
    expect(parsed.notApplicable).toEqual({
      reason: "private-target",
      message: LINE,
      rules: [
        { ruleId: "perf/compression", name: "Compression" },
        { ruleId: "security/hsts", name: "HSTS Header" },
        { ruleId: "security/https", name: "HTTPS" },
      ],
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.skippedChecks).toBeUndefined();
    expect(parsed.summary.skipped).toBe(0);
  });

  test("a public report carries none of it", () => {
    const report = localReport();
    report.baseUrl = "https://example.com";
    report.ruleResults = { "core/meta-title": report.ruleResults["core/meta-title"]! };
    expect(renderText(report)).not.toContain("Local or private-network host");
    expect(renderLlm(report)).not.toContain("not-applicable");
    expect(JSON.parse(renderJson(report)).notApplicable).toBeUndefined();
  });
});
