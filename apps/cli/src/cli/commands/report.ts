// squirrelscan report [audit-id] - CLI wrapper

import { defineCommand } from "citty";

import type { RuleCategory } from "@/rules/categories";
import type { AuditReport } from "@/types";

import {
  generateConsoleReport,
  generateTextReport,
  generateJsonReport,
  generateHtmlReport,
  generateMarkdownReport,
  generateXmlReport,
  generateLlmReport,
} from "@/audit/report";
import { OUTPUT_FORMATS_HELP } from "@/constants";
import {
  loadReport,
  validateFormat,
  listStoredAudits,
  getStoredAudit,
  getStoredAuditByPrefix,
  getLatestAudit,
} from "@/controllers/report";
import { savePublishedReportInfo } from "@/controllers/report/publish";
import {
  publishReport,
  type ReportVisibility,
} from "@/controllers/report/publish";
import { diffReports, isSameBaseUrl } from "@/reports/diff";
import {
  generateDiffConsole,
  generateDiffJson,
  generateDiffLlm,
  generateDiffMarkdown,
  generateDiffText,
} from "@/reports/diff/output";
import { filterByCategory } from "@/reports/filters";
import {
  isValidCategory,
  normalizeCategoryCode,
  RULE_CATEGORY_VALUES,
} from "@/rules/categories";
import { warnIfSessionUnreadable } from "@/self/credentials";
import { safeExit } from "@/self/updater";
import { isUUID, isShortId } from "@/utils";

import { printFooter } from "../banner";
import { printDatabaseLockWarningIfNeeded } from "../db-lock-warning";

/**
 * Filter report by severity
 */
function filterBySeverity(
  report: AuditReport,
  severity: "error" | "warning" | "all"
): AuditReport {
  if (severity === "all") return report;

  const filteredPages = report.pages.map((page) => ({
    ...page,
    checks: page.checks.filter((c) => {
      if (severity === "error") return c.status === "fail";
      if (severity === "warning") return c.status === "warn";
      return true;
    }),
  }));

  return {
    ...report,
    pages: filteredPages,
  };
}

/**
 * Print audit list table
 */
function printAuditList(
  audits: Array<{
    id: string;
    baseUrl: string;
    startedAt: number;
    status: string;
    stats: { pagesTotal: number };
    published?: {
      url: string;
      visibility: string;
    };
  }>
): void {
  if (audits.length === 0) {
    console.log("No stored audits found.");
    console.log('Run "squirrel audit <url>" to create your first audit.');
    return;
  }

  console.log("Recent Audits:");
  console.log("=".repeat(90));
  console.log(
    "ID".padEnd(11) +
      "Date".padEnd(22) +
      "Pages".padEnd(8) +
      "Status".padEnd(12) +
      "Published"
  );
  console.log("-".repeat(90));

  for (const audit of audits) {
    const date = new Date(audit.startedAt).toLocaleString();
    const pages = audit.stats.pagesTotal.toString();
    const id = audit.id.slice(0, 8);
    const published = audit.published?.visibility ?? "-";

    console.log(
      id.padEnd(11) +
        date.padEnd(22) +
        pages.padEnd(8) +
        audit.status.padEnd(12) +
        published
    );
    console.log(`  ${audit.baseUrl}`);
    if (audit.published) {
      console.log(`  → ${audit.published.url}`);
    }
  }

  console.log("");
  console.log(`Total: ${audits.length} audits`);
  console.log('Use "squirrel report <audit-id>" to view a specific audit.');
}

export const report = defineCommand({
  meta: {
    name: "report",
    description: "Query and view stored audit reports",
  },
  args: {
    id: {
      type: "positional",
      description:
        "Audit ID (UUID or 8-char prefix) or domain name (defaults to latest)",
      required: false,
    },
    list: {
      type: "boolean",
      alias: "l",
      description: "List recent audits",
    },
    severity: {
      type: "string",
      description: "Filter by severity: error, warning, all (default: all)",
    },
    category: {
      type: "string",
      description:
        "Filter by categories: core,content,links,... (comma-separated)",
    },
    format: {
      type: "string",
      alias: "f",
      description: `Output format: ${OUTPUT_FORMATS_HELP} (default: console)`,
    },
    diff: {
      type: "string",
      description:
        "Compare current report against baseline (audit ID or domain)",
    },
    regressionSince: {
      type: "string",
      description:
        "Compare latest (or current) report against baseline (audit ID or domain)",
    },
    allowCrossSite: {
      type: "boolean",
      description: "Allow diff across different base URLs",
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output file path",
    },
    input: {
      type: "string",
      alias: "i",
      description: "Load from JSON file (fallback mode)",
    },
    publish: {
      type: "boolean",
      alias: "p",
      description: "Publish report to reports.squirrelscan.com",
    },
    visibility: {
      type: "string",
      description:
        "Visibility when publishing: public, unlisted, private (default: public)",
    },
    summary: {
      type: "boolean",
      description:
        "Print only the score, category breakdown, and issue counts — no per-issue detail (console format only)",
    },
  },
  async run({ args }) {
    // Loud warning for an unreadable/corrupt session (EACCES, corrupt JSON,
    // ...) — was audit-only (#805), extended to every command entry (#1062).
    warnIfSessionUnreadable();

    // --summary is console-only (#1067), same as `squirrel audit`.
    if (args.summary && args.format && args.format !== "console") {
      console.error(
        `--summary only applies to console output, got --format ${args.format}`
      );
      return safeExit(1);
    }
    // --publish returns before any report is rendered, so --summary would
    // silently do nothing rather than error like the --format case above.
    if (args.summary && args.publish) {
      console.error("--summary has no effect when combined with --publish");
      return safeExit(1);
    }
    // Diff/regression/list console output uses its own renderers that never
    // read --summary, so error instead of silently printing full output.
    if (args.summary && (args.diff || args.regressionSince || args.list)) {
      console.error(
        "--summary is not supported with --diff, --regression-since, or --list"
      );
      return safeExit(1);
    }

    if (args.diff && args.regressionSince) {
      console.error("Use either --diff or --regression-since, not both.");
      return safeExit(1);
    }

    // List mode
    if (args.list) {
      const listResult = await listStoredAudits(10);
      if (!listResult.ok) {
        console.error(listResult.error.message);
        printDatabaseLockWarningIfNeeded(listResult.error.message);
        return safeExit(1);
      }
      printAuditList(listResult.data);
      printFooter();
      return;
    }

    const resolveAuditRef = async (ref: string) => {
      if (isUUID(ref)) {
        return await getStoredAudit(ref);
      }
      if (isShortId(ref)) {
        return await getStoredAuditByPrefix(ref);
      }

      let domain = ref;
      if (!domain.startsWith("http://") && !domain.startsWith("https://")) {
        domain = `https://${domain}`;
      }
      return await getLatestAudit(domain);
    };

    const isDiffMode = Boolean(args.diff || args.regressionSince);

    // Load report from source
    let loadResult;

    if (args.input) {
      // Load from JSON file (sync)
      loadResult = loadReport(args.input);
    } else if (args.id) {
      loadResult = await resolveAuditRef(args.id);

      if (!loadResult.ok) {
        console.error(loadResult.error.message);
        printDatabaseLockWarningIfNeeded(loadResult.error.message);
        return safeExit(1);
      }
    } else {
      // Load latest audit globally (async)
      loadResult = await getLatestAudit();

      if (!loadResult.ok) {
        console.error("No audits found. Run 'squirrel audit <url>' first");
        return safeExit(1);
      }
    }

    if (!loadResult.ok) {
      console.error(loadResult.error.message);
      printDatabaseLockWarningIfNeeded(loadResult.error.message);
      return safeExit(1);
    }

    let reportData = loadResult.data;

    // Diff mode
    if (isDiffMode) {
      if (args.publish) {
        console.error("Diff reports cannot be published.");
        return safeExit(1);
      }

      const baselineRef = (args.diff ?? args.regressionSince) as string;
      const baselineResult = await resolveAuditRef(baselineRef);
      if (!baselineResult.ok) {
        console.error(baselineResult.error.message);
        printDatabaseLockWarningIfNeeded(baselineResult.error.message);
        return safeExit(1);
      }

      let currentReport = reportData;
      let baselineReport = baselineResult.data;

      if (!args.id && !args.input && args.regressionSince) {
        const latestForBase = await getLatestAudit(baselineReport.baseUrl);
        if (latestForBase.ok) {
          currentReport = latestForBase.data;
        }
      }

      if (
        !args.allowCrossSite &&
        !isSameBaseUrl(baselineReport, currentReport)
      ) {
        console.error(
          "Base URL mismatch between baseline and current reports. Use --allow-cross-site to override."
        );
        return safeExit(1);
      }

      // Apply category filter before diff
      if (args.category) {
        const categories = args.category
          .split(",")
          .map((c) => normalizeCategoryCode(c.trim()));
        const invalidCategories = categories.filter((c) => !isValidCategory(c));
        if (invalidCategories.length > 0) {
          console.error(`Invalid category: ${invalidCategories.join(", ")}`);
          console.error(`Valid categories: ${RULE_CATEGORY_VALUES.join(", ")}`);
          return safeExit(1);
        }
        currentReport = filterByCategory(
          currentReport,
          categories as RuleCategory[]
        );
        baselineReport = filterByCategory(
          baselineReport,
          categories as RuleCategory[]
        );
      }

      if (args.severity) {
        const severity = args.severity as "error" | "warning" | "all";
        if (!["error", "warning", "all"].includes(severity)) {
          console.error(
            "Invalid severity. Use: error, warning, or all (default: all)"
          );
          return safeExit(1);
        }
      }

      // Validate and generate diff output
      const format = args.format ?? "console";
      const formatResult = validateFormat(format);
      if (!formatResult.ok) {
        console.error(formatResult.error.message);
        printDatabaseLockWarningIfNeeded(formatResult.error.message);
        return safeExit(1);
      }

      if (["html", "xml"].includes(formatResult.data)) {
        console.error("Diff mode does not support html or xml output.");
        return safeExit(1);
      }

      const diffReport = diffReports(baselineReport, currentReport, {
        severity: args.severity as "error" | "warning" | "all" | undefined,
      });

      if (formatResult.data === "console") {
        generateDiffConsole(diffReport);
      } else if (formatResult.data === "text") {
        generateDiffText(diffReport, args.output);
      } else if (formatResult.data === "json") {
        generateDiffJson(diffReport, args.output);
      } else if (formatResult.data === "markdown") {
        generateDiffMarkdown(diffReport, args.output);
      } else if (formatResult.data === "llm") {
        generateDiffLlm(diffReport, args.output);
      }

      printFooter();
      return;
    }

    // Apply filters
    if (args.severity) {
      const severity = args.severity as "error" | "warning" | "all";
      if (!["error", "warning", "all"].includes(severity)) {
        console.error(
          "Invalid severity. Use: error, warning, or all (default: all)"
        );
        return safeExit(1);
      }
      reportData = filterBySeverity(reportData, severity);
    }

    if (args.category) {
      const categories = args.category
        .split(",")
        .map((c) => normalizeCategoryCode(c.trim()));
      const invalidCategories = categories.filter((c) => !isValidCategory(c));
      if (invalidCategories.length > 0) {
        console.error(`Invalid category: ${invalidCategories.join(", ")}`);
        console.error(`Valid categories: ${RULE_CATEGORY_VALUES.join(", ")}`);
        return safeExit(1);
      }
      reportData = filterByCategory(reportData, categories as RuleCategory[]);
    }

    // Handle publish flag - skip report output when publishing
    if (args.publish) {
      // Validate visibility if provided
      const validVisibilities: ReportVisibility[] = [
        "public",
        "unlisted",
        "private",
      ];
      const visibility = (args.visibility as ReportVisibility) ?? "public";

      if (!validVisibilities.includes(visibility)) {
        console.error(
          `Invalid visibility: ${visibility}. Use: public, unlisted, or private`
        );
        return safeExit(1);
      }

      const publishResult = await publishReport(reportData, { visibility });

      if (!publishResult.ok) {
        console.error(`Failed to publish: ${publishResult.error.message}`);
        printDatabaseLockWarningIfNeeded(publishResult.error.message);
        return safeExit(1);
      }

      // Just output the URL
      console.log(publishResult.data.url);

      // Save published report info for tracking in report --list
      if (reportData.crawlId) {
        await savePublishedReportInfo(
          reportData.crawlId,
          publishResult.data.id,
          publishResult.data.url,
          publishResult.data.visibility
        );
      }
      return;
    }

    // Validate and generate output
    const format = args.format ?? "console";
    const formatResult = validateFormat(format);
    if (!formatResult.ok) {
      console.error(formatResult.error.message);
      printDatabaseLockWarningIfNeeded(formatResult.error.message);
      return safeExit(1);
    }

    // Generate output
    // console, text, json, markdown, llm: stdout by default (pipeable)
    // html: file by default (needs browser)
    if (formatResult.data === "console") {
      generateConsoleReport(reportData, { summaryOnly: args.summary });
    } else if (formatResult.data === "text") {
      generateTextReport(reportData, args.output);
    } else if (formatResult.data === "json") {
      // stdout by default, file if -o provided
      generateJsonReport(reportData, args.output);
    } else if (formatResult.data === "markdown") {
      // stdout by default, file if -o provided
      generateMarkdownReport(reportData, args.output);
    } else if (formatResult.data === "xml") {
      // stdout by default, file if -o provided
      generateXmlReport(reportData, args.output);
    } else if (formatResult.data === "llm") {
      // stdout by default, file if -o provided
      generateLlmReport(reportData, args.output);
    } else if (formatResult.data === "html") {
      // file by default - HTML needs a browser
      const hostname = new URL(reportData.baseUrl).hostname;
      const outputPath = args.output ?? `${hostname}-report.html`;
      generateHtmlReport(reportData, outputPath);
    } else if (formatResult.data === "pdf") {
      console.error("PDF format not yet implemented");
      return safeExit(1);
    } else if (formatResult.data === "sarif") {
      console.error("SARIF format not yet implemented");
      return safeExit(1);
    }

    // Print footer
    printFooter();
  },
});
