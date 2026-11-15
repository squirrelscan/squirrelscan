// The text of `squirrel self doctor`, shared with the support ticket
// diagnostics (#1090) so a ticket carries exactly what the command prints.

import type { DoctorCheck, DoctorReport } from "./types";

export function formatDoctorCheck(check: DoctorCheck): string[] {
  const icon =
    check.status === "pass"
      ? "[OK]"
      : check.status === "warn"
        ? "[WARN]"
        : "[FAIL]";
  const lines = [`${icon} ${check.name}: ${check.message}`];
  if (check.fix) lines.push(`    Fix: ${check.fix}`);
  return lines;
}

export function formatDoctorReport(report: DoctorReport): string {
  return [
    ...report.checks.flatMap(formatDoctorCheck),
    "",
    `Passed: ${report.passed} | Warnings: ${report.warnings} | Failed: ${report.failed}`,
  ].join("\n");
}

/** Run the checks and return the report text; null when they could not run. */
export async function collectDoctorText(): Promise<string | null> {
  try {
    const { runDoctorChecks } = await import("@/self/doctor");
    const { checkClassifier } = await import("@/classifier/doctor");
    const result = runDoctorChecks({ extraChecks: [checkClassifier()] });
    return result.ok ? formatDoctorReport(result.data) : null;
  } catch {
    return null;
  }
}
