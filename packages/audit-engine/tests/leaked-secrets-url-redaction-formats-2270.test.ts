// #2270: a secret in the URL a security/leaked-secrets finding names is masked in every report format. The real rule's
// result is rendered through the llm, markdown, json and html renderers, and none of them prints either secret.
// Values are built from parts: no secret-shaped literal is committed.

import type { AuditReport, ReportRuleResult } from "@squirrelscan/report";
import type { RuleContext } from "@squirrelscan/rules/types";

import { parsePage } from "@squirrelscan/parser";
import {
  renderHtml,
  renderJson,
  renderLlm,
  renderMarkdown,
} from "@squirrelscan/report";
import { buildCollectedPageSignal, security } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

const BASE = "https://shop.example.test";
const QUERY_KEY = `${["sk", "live"].join("_")}_${"aB3dE5gH7jK9mN1pQ3rS5tU7"}`;
const PATH_TOKEN = `${"glpat"}-${"aB3dE5gH7jK9mN1pQ3rS"}`;
const BODY_KEY = `${["sk", "live"].join("_")}_${"Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2"}`;
const QUERY_SCRIPT = `${BASE}/config.json?key=${QUERY_KEY}`;
const PATH_SCRIPT = `${BASE}/api/${PATH_TOKEN}/data.js`;

async function report(): Promise<AuditReport> {
  const scripts = [QUERY_SCRIPT, PATH_SCRIPT];
  const ctx = {
    site: {
      baseUrl: BASE,
      pages: [],
      scripts: scripts.map((url, i) => ({
        url,
        // A different secret body per script, so each script keeps its own finding.
        content: `window.cfg${i}={key:"${i === 0 ? BODY_KEY : QUERY_KEY.replace("aB3", "Qq1")}"};`,
        sourcePages: [`${BASE}/`],
        status: 200,
        error: null,
        contentType: "application/javascript",
        sizeBytes: 64,
      })),
    },
    collectedSignals: {
      pages: [
        buildCollectedPageSignal({
          url: `${BASE}/`,
          parsed: parsePage(
            `<html><body>${scripts.map((u) => `<script src="${u}"></script>`).join("")}</body></html>`,
            `${BASE}/`
          ),
          rendered: false,
        }),
      ],
    },
    options: {},
  } as unknown as RuleContext;
  const rule = security.leakedSecretsRule;
  const { checks } = await rule.run(ctx);
  const result = {
    meta: rule.meta,
    checks,
  } as unknown as ReportRuleResult;
  return {
    baseUrl: BASE,
    timestamp: "2026-11-23T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 1,
    ruleResults: { [rule.meta.id]: result },
    healthScore: {
      overall: 60,
      categories: [],
      groups: [],
      errorCount: 1,
      warningCount: 0,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

describe("#2270: leaked-secrets URLs are redacted in every report format", () => {
  const formats: Array<[string, (r: AuditReport) => string]> = [
    ["llm", (r) => renderLlm(r)],
    ["markdown", (r) => renderMarkdown(r)],
    ["json", (r) => renderJson(r)],
    ["html", (r) => renderHtml(r)],
  ];
  for (const [name, render] of formats) {
    test(`${name}: names both scripts, prints neither secret`, async () => {
      const out = render(await report());
      expect(out).not.toContain(QUERY_KEY);
      expect(out).not.toContain(PATH_TOKEN);
      expect(out).not.toContain(encodeURIComponent(PATH_TOKEN));
      expect(out).toContain("config.json?key=sk_liv…5tU7");
      expect(out).toContain("/api/glpat-…Q3rS/data.js");
    });
  }
});
