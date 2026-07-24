import { renderJson } from "@squirrelscan/report";

import type { AuditReport } from "@/types";

import { writeReportFile } from "@/reports/utils";

import { version } from "../../../package.json";

export function generateJsonReport(
  report: AuditReport,
  outputPath?: string
): void {
  const content = renderJson(report as Parameters<typeof renderJson>[0], {
    version,
  });

  if (outputPath) {
    writeReportFile(outputPath, content);
    console.log(`JSON report saved to: ${outputPath}`);
  } else {
    process.stdout.write(content);
    process.stdout.write("\n");
  }
}
