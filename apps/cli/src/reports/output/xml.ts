import { renderXml, type ReportBranding } from "@squirrelscan/report";

import type { AuditReport } from "@/types";

import { writeReportFile } from "@/reports/utils";

import { version } from "../../../package.json";

export function generateXmlReport(
  report: AuditReport,
  outputPath?: string,
  branding?: ReportBranding
): void {
  const content = renderXml(report as Parameters<typeof renderXml>[0], {
    version,
    branding,
  });

  if (outputPath) {
    writeReportFile(outputPath, content);
    console.log(`XML report saved to: ${outputPath}`);
  } else {
    process.stdout.write(content);
    process.stdout.write("\n");
  }
}
