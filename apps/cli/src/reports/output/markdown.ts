import {
  renderMarkdown,
  type ReportBranding,
  type WcagChecklistRule,
} from "@squirrelscan/report";
import { loadAllRules } from "@squirrelscan/rules";

import type { AuditReport } from "@/types";

import { writeReportFile } from "@/reports/utils";

import { version } from "../../../package.json";

/**
 * Every rule's id and `meta.wcag`, for the accessibility checklist (repo#3094): a criterion whose rules
 * did not run on this audit then reads as such, not as one no rule covers.
 */
export function wcagChecklistRules(): WcagChecklistRule[] {
  return [...loadAllRules({ includeOptIn: true }).values()].map((rule) => ({
    id: rule.meta.id,
    wcag: rule.meta.wcag,
  }));
}

export function generateMarkdownReport(
  report: AuditReport,
  outputPath?: string,
  branding?: ReportBranding,
  includePassed = false
): void {
  const content = renderMarkdown(
    report as Parameters<typeof renderMarkdown>[0],
    { version, branding, includePassed, wcagRules: wcagChecklistRules() }
  );

  if (outputPath) {
    writeReportFile(outputPath, content);
    console.log(`Markdown report saved to: ${outputPath}`);
  } else {
    process.stdout.write(content);
    process.stdout.write("\n");
  }
}
