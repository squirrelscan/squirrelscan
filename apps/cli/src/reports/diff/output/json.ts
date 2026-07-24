import { writeReportFile } from "@/reports/utils";

import type { DiffReport } from "../types";

export function generateDiffJson(diff: DiffReport, outputPath?: string): void {
  const json = JSON.stringify(diff, null, 2);

  if (outputPath) {
    writeReportFile(outputPath, json);
    console.log(`Diff report saved to: ${outputPath}`);
  } else {
    process.stdout.write(json);
    process.stdout.write("\n");
  }
}
