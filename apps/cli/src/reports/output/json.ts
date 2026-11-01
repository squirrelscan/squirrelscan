import { pageOutcome, renderJson } from "@squirrelscan/report";

import type { AuditReport } from "@/types";

import { writeReportFile } from "@/reports/utils";

import { version } from "../../../package.json";

export function generateJsonReport(
  report: AuditReport,
  outputPath?: string,
  includePassed = false,
  includePages = false
): void {
  const content = renderJson(report as Parameters<typeof renderJson>[0], {
    version,
    includePassed,
    // #1260: every crawled page, opt in. A report read back from JSON has no pages.
    ...(includePages
      ? {
          pages: [
            ...report.pages.map((page) => ({
              url: page.url,
              finalUrl: page.finalUrl ?? page.url,
              status: page.statusCode,
              outcome: pageOutcome(page.statusCode),
              ruleCount: page.ruleCount ?? 0,
            })),
            // #1396: URLs the crawl requested but stored no page for, after the crawled pages.
            ...(report.unstoredPages ?? []).map((page) => ({
              url: page.url,
              finalUrl: page.url,
              status: 0,
              outcome: page.outcome,
              ruleCount: 0,
              reason: page.reason,
            })),
          ],
          pagesTotal:
            report.pages.length +
            (report.unstoredPagesTotal ?? report.unstoredPages?.length ?? 0),
        }
      : {}),
  });

  if (outputPath) {
    writeReportFile(outputPath, content);
    console.error(`JSON report saved to: ${outputPath}`);
  } else {
    process.stdout.write(content);
    process.stdout.write("\n");
  }
}
