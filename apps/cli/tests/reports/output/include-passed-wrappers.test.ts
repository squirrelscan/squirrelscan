// #1037: every CLI report writer threads `includePassed` through to its
// renderer. The writers take it positionally after `branding`, so a dropped or
// swapped argument in one format would otherwise go unnoticed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditReport } from "@/types";

import { generateHtmlReport } from "@/reports/output/html";
import { generateJsonReport } from "@/reports/output/json";
import { generateLlmReport } from "@/reports/output/llm";
import { generateMarkdownReport } from "@/reports/output/markdown";
import { generateTextReport } from "@/reports/output/text";
import { generateXmlReport } from "@/reports/output/xml";

import { createMinimalReport } from "../fixtures";

function reportWithPass(): AuditReport {
  const report = createMinimalReport();
  report.ruleResults = {
    "core/canonical": {
      meta: {
        id: "core/canonical",
        name: "Canonical",
        description: "",
        category: "core",
        scope: "page",
        severity: "error",
        weight: 5,
      },
      checks: [
        {
          name: "c",
          status: "pass",
          message: "ok",
          pageUrl: "https://example.com/",
        },
      ],
    },
  };
  return report;
}

/** Each writer with the flag on or off, writing to `path`, and what marks the list. */
const WRITERS: Array<[string, (path: string, on: boolean) => void, string]> = [
  [
    "text",
    (p, on) => generateTextReport(reportWithPass(), p, undefined, on),
    "PASSED (1 rule)",
  ],
  [
    "json",
    (p, on) => generateJsonReport(reportWithPass(), p, on),
    '"passedRules"',
  ],
  [
    "markdown",
    (p, on) => generateMarkdownReport(reportWithPass(), p, undefined, on),
    "## Passed",
  ],
  [
    "xml",
    (p, on) => generateXmlReport(reportWithPass(), p, undefined, on),
    '<passed count="1">',
  ],
  [
    "llm",
    (p, on) => generateLlmReport(reportWithPass(), p, on),
    '<passed count="1">',
  ],
  [
    "html",
    (p, on) => generateHtmlReport(reportWithPass(), p, undefined, on),
    'id="passed"',
  ],
];

describe("CLI report writers pass includePassed through (#1037)", () => {
  let dir: string;
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "squirrel-include-passed-writers-"));
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  });

  test.each(WRITERS)(
    "%s lists the passed rule only with the flag",
    (_, write, marker) => {
      const on = join(dir, "on");
      const off = join(dir, "off");
      write(on, true);
      write(off, false);
      expect(readFileSync(on, "utf8")).toContain(marker);
      expect(readFileSync(off, "utf8")).not.toContain(marker);
    }
  );
});
