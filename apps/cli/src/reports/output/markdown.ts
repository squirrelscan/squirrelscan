import { renderMarkdown, type ReportBranding } from "@squirrelscan/report";

import type { AuditReport } from "@/types";

import { writeReportFile } from "@/reports/utils";

import { version } from "../../../package.json";

export function generateMarkdownReport(
  report: AuditReport,
  outputPath?: string,
  branding?: ReportBranding
): void {
  const content = renderMarkdown(
    report as Parameters<typeof renderMarkdown>[0],
    { version, branding }
  );

  if (outputPath) {
    writeReportFile(outputPath, content);
    console.log(`Markdown report saved to: ${outputPath}`);
  } else {
    process.stdout.write(content);
    process.stdout.write("\n");
  }
}
