import { renderText, type ReportBranding } from "@squirrelscan/report";
import { writeFileSync } from "node:fs";

import type { AuditReport } from "@/types";

import { version } from "../../../package.json";

export function generateTextReport(
  report: AuditReport,
  outputPath?: string,
  branding?: ReportBranding,
  includePassed = false
): void {
  const output = renderText(report as Parameters<typeof renderText>[0], {
    version,
    branding,
    includePassed,
  });

  if (outputPath) {
    writeFileSync(outputPath, output);
    return;
  }

  process.stdout.write(output);
}
