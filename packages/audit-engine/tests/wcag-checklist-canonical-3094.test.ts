// repo#3094: the accessibility checklist over a report built the way the engine builds it, on THE canonical
// 500-page fixture. The engine writes no `meta.wcag`, so the checklist comes from the rules' declarations
// passed in; a rule that ran and found nothing to check (a11y/autocomplete-tokens, not applicable on every
// page) answered, so a normal full audit has no "Rules did not run" row.

import type { FullAuditReport } from "@squirrelscan/audit-engine";

import { SQLiteStorage } from "@squirrelscan/crawler";
import {
  buildWcagChecklist,
  renderMarkdown,
  wcagChecklistCounts,
} from "@squirrelscan/report";
import { loadAllRules } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import {
  canonicalFixtureDb,
  getGoldenBaselineConfig,
  run,
  runV1Pipeline,
} from "./helpers/golden-baseline";

const CAPTURE_BUDGET_MS = 180_000;

let reportPromise: Promise<FullAuditReport> | undefined;
function canonicalReport(): Promise<FullAuditReport> {
  reportPromise ??= (async () => {
    const storage = new SQLiteStorage(await canonicalFixtureDb());
    try {
      await run(storage.init());
      const crawlId = (await run(storage.listCrawls(1)))[0]?.id;
      if (!crawlId) throw new Error("no crawl in the canonical fixture");
      return (await runV1Pipeline(storage, crawlId, getGoldenBaselineConfig()))
        .report;
    } finally {
      await run(storage.close());
    }
  })();
  return reportPromise;
}

const wcagRules = () =>
  [...loadAllRules({ includeOptIn: true }).values()].map((rule) => ({
    id: rule.meta.id,
    wcag: rule.meta.wcag,
  }));

describe("accessibility checklist on the canonical fixture (repo#3094)", () => {
  test(
    "a normal full audit has no 'Rules did not run' row, and 1.3.5 reads no issue",
    async () => {
      const report = await canonicalReport();
      const rows = buildWcagChecklist(report, wcagRules());
      expect(wcagChecklistCounts(rows)["not-run"]).toBe(0);
      expect(rows.find((r) => r.sc === "1.3.5")).toMatchObject({
        status: "no-finding",
        rules: ["a11y/autocomplete-tokens"],
        notRun: [],
      });
      const md = renderMarkdown(report, { wcagRules: wcagRules() });
      expect(md).toContain("## Accessibility checklist");
      expect(md).not.toContain("| Rules did not run |");
    },
    CAPTURE_BUDGET_MS
  );

  test(
    "the engine's report carries no meta.wcag, so without the declarations there is no checklist",
    async () => {
      const report = await canonicalReport();
      expect(
        Object.values(report.ruleResults).some((r) => "wcag" in (r.meta ?? {}))
      ).toBe(false);
      expect(renderMarkdown(report)).not.toContain(
        "## Accessibility checklist"
      );
    },
    CAPTURE_BUDGET_MS
  );
});
