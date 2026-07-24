import { renderHtml, type ReportBranding } from "@squirrelscan/report";

import type { AuditReport } from "@/types";

import { writeReportFile } from "@/reports/utils";

export function generateHtmlReport(
  report: AuditReport,
  outputPath: string,
  branding?: ReportBranding
): void {
  const html = renderHtml(report as Parameters<typeof renderHtml>[0], {
    branding,
  });
  writeReportFile(outputPath, html);
  console.log(`HTML report saved to: ${outputPath}`);
}
