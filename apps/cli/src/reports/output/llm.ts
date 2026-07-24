import { renderLlm } from "@squirrelscan/report";

import type { AuditReport } from "@/types";

import { writeReportFile } from "@/reports/utils";

import { version } from "../../../package.json";

// Re-export for tests
export {
  sampleAffectedPagesBreadthFirst,
  serializeMetaValue,
} from "@squirrelscan/report/output/llm";

export function generateLlmReport(
  report: AuditReport,
  outputPath?: string
): void {
  const content = renderLlm(report as Parameters<typeof renderLlm>[0], {
    version,
  });

  if (outputPath) {
    writeReportFile(outputPath, content);
    console.log(`LLM report saved to: ${outputPath}`);
  } else {
    process.stdout.write(content);
    process.stdout.write("\n");
  }
}
