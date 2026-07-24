// #780: llm/markdown/text renderers must surface unrun cloud checks — an agent
// (or a user reading the console/markdown export) must never mistake a
// locked-rules report for a complete audit. Covers the three audiences
// explicitly called out in the acceptance criteria: anonymous, free-no-credits,
// and paid-quick-coverage.

import { describe, expect, test } from "bun:test";
import type { AuditReport } from "../src/types";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";

const LOCKED = [
  { id: "ai/llm-parsability", name: "LLM Parsability" },
  { id: "ai/site-metadata", name: "Site Metadata" },
];

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    lockedRules: LOCKED,
    ...overrides,
  };
}

describe("renderLlm locked rules (#780)", () => {
  test("anonymous: <locked-rules> block with signup CTA and rule ids", () => {
    const xml = renderLlm(baseReport());
    expect(xml).toContain('<locked-rules count="2" audience="anonymous-upsell">');
    expect(xml).toContain("free squirrelscan account");
    expect(xml).toContain(
      '<cta label="Get started to unlock them" url="https://squirrelscan.com"/>',
    );
    expect(xml).toContain('<rule id="ai/llm-parsability" name="LLM Parsability"/>');
    expect(xml).toContain('<rule id="ai/site-metadata" name="Site Metadata"/>');
    expect(xml).toContain("</locked-rules>");
  });

  test("free, no credits: dashboard CTA, no signup copy", () => {
    const xml = renderLlm(baseReport({ cloudPlan: "free" }));
    expect(xml).toContain('audience="free-upsell"');
    expect(xml).not.toContain("free squirrelscan account");
    expect(xml).toContain(
      '<cta label="Add credits in your dashboard" url="https://app.squirrelscan.com"/>',
    );
  });

  test("paid + quick coverage: re-run hint, no CTA element", () => {
    const xml = renderLlm(baseReport({ cloudPlan: "paid", coverageMode: "quick" }));
    expect(xml).toContain('audience="quick-coverage"');
    expect(xml).toContain("-C surface or -C full");
    expect(xml).not.toContain("<cta ");
  });

  test("no locked rules: no <locked-rules> block", () => {
    const xml = renderLlm(baseReport({ lockedRules: [] }));
    expect(xml).not.toContain("<locked-rules");
  });

  // Matches the convention in tests/llm-status.test.ts — agent-facing copy
  // stays em-dash-free.
  test("no em-dashes in the locked-rules block, any audience", () => {
    for (const overrides of [
      {},
      { cloudPlan: "free" as const },
      { cloudPlan: "paid" as const, coverageMode: "quick" as const },
      { cloudPlan: "paid" as const, cloudMode: "http" as const },
      { cloudPlan: "paid" as const },
    ]) {
      const xml = renderLlm(baseReport(overrides));
      const start = xml.indexOf("<locked-rules");
      const notice = xml.slice(start, xml.indexOf("</locked-rules>") + "</locked-rules>".length);
      expect(notice).not.toContain("—");
    }
  });
});

describe("renderMarkdown locked rules (#780)", () => {
  test("anonymous: ## Checks not run section with signup link", () => {
    const md = renderMarkdown(baseReport());
    expect(md).toContain("## Checks not run");
    expect(md).toContain("[Get started to unlock them](https://squirrelscan.com)");
    expect(md).toContain("`ai/llm-parsability` — LLM Parsability");
  });

  test("free, no credits: dashboard link, no signup copy", () => {
    const md = renderMarkdown(baseReport({ cloudPlan: "free" }));
    expect(md).toContain("[Add credits in your dashboard](https://app.squirrelscan.com)");
    expect(md).not.toContain("free squirrelscan account");
  });

  test("paid + quick coverage: re-run hint, no link", () => {
    const md = renderMarkdown(baseReport({ cloudPlan: "paid", coverageMode: "quick" }));
    expect(md).toContain("-C surface or -C full");
    expect(md).not.toContain("[Add credits");
  });

  test("white-label report omits the section entirely", () => {
    const md = renderMarkdown(baseReport(), { branding: { whiteLabel: true } });
    expect(md).not.toContain("## Checks not run");
  });

  test("no locked rules: no section", () => {
    const md = renderMarkdown(baseReport({ lockedRules: [] }));
    expect(md).not.toContain("## Checks not run");
  });
});

describe("renderText locked rules (#780)", () => {
  test("anonymous: CHECKS NOT RUN block with signup link", () => {
    const txt = renderText(baseReport());
    expect(txt).toContain("CHECKS NOT RUN");
    expect(txt).toContain("Get started to unlock them: https://squirrelscan.com");
    expect(txt).toContain("ai/llm-parsability — LLM Parsability");
  });

  test("free, no credits: dashboard link, no signup copy", () => {
    const txt = renderText(baseReport({ cloudPlan: "free" }));
    expect(txt).toContain("Add credits in your dashboard: https://app.squirrelscan.com");
    expect(txt).not.toContain("free squirrelscan account");
  });

  test("paid + quick coverage: re-run hint, no link", () => {
    const txt = renderText(baseReport({ cloudPlan: "paid", coverageMode: "quick" }));
    expect(txt).toContain("-C surface or -C full");
    expect(txt).not.toContain("Add credits");
  });

  test("white-label report omits the section entirely", () => {
    const txt = renderText(baseReport(), { branding: { whiteLabel: true } });
    expect(txt).not.toContain("CHECKS NOT RUN");
  });

  test("no locked rules: no section", () => {
    const txt = renderText(baseReport({ lockedRules: [] }));
    expect(txt).not.toContain("CHECKS NOT RUN");
  });
});
