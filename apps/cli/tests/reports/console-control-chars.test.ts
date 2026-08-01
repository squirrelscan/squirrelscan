// The console renderer is the DEFAULT output path and the one a hijack payload
// actually targets: `ESC[2J ESC[1;1H` clears the screen and homes the cursor,
// so a malicious page can blank the real findings and repaint forged ones.
// packages/report covers the text and llm renderers; this covers the console.
//
// Our own SGR colour codes are stripped from the captured output before
// asserting, so any ESC that remains is a hostile one.
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { generateConsoleReport } from "../../src/reports/output/console";

const ESC = "\x1b";
const HIJACK = `${ESC}[2J${ESC}[1;1HFORGED: 0 issues found`;

/** A report carrying the payload in every field a rule can populate. */
function hostileReport(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-07-31T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 1,
    ruleResults: {
      "content/example": {
        meta: {
          id: "content/example",
          name: `Rule ${HIJACK}`,
          description: `Description ${HIJACK}`,
          category: "content",
          severity: "error",
          weight: 5,
        },
        checks: [
          {
            name: `check ${HIJACK}`,
            status: "fail",
            message: `Message ${HIJACK}`,
            pageUrl: "https://example.com/a",
            items: [
              {
                id: "item-1",
                label: `Label ${HIJACK}`,
                snippet: `<img alt="${HIJACK}">`,
                sourcePages: ["https://example.com/a"],
              },
            ],
          },
        ],
      },
    },
  } as unknown as AuditReport;
}

function captureConsole(run: () => void): string {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")
    );
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}

/** Remove our own SGR colour codes so any REMAINING ESC is a hostile one. */
function withoutSgr(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("console renderer strips page-derived control characters", () => {
  test("no non-SGR ESC reaches the console", () => {
    const out = captureConsole(() => generateConsoleReport(hostileReport()));
    expect(withoutSgr(out)).not.toContain(ESC);
  });

  test("no C0 control byte other than tab and newline survives", () => {
    const out = withoutSgr(
      captureConsole(() => generateConsoleReport(hostileReport()))
    );
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  test("the report still renders around the stripped payload", () => {
    // A guard that blanked everything would satisfy the assertions above for
    // entirely the wrong reason.
    const out = captureConsole(() => generateConsoleReport(hostileReport()));
    expect(out).toContain("FORGED: 0 issues found");
    expect(out.length).toBeGreaterThan(200);
  });

  test("the payload is neutralised, not merely uncoloured", () => {
    // Colour is disabled under a non-TTY test runner, so the absence of ESC
    // above could in principle mean "nothing emits ESC here at all". Assert the
    // hostile sequence specifically lost its ESC while its inert remainder
    // survived as ordinary text — that is the strip doing its job.
    const out = captureConsole(() => generateConsoleReport(hostileReport()));
    expect(out).toContain("[2J[1;1HFORGED");
    expect(out).not.toContain(`${ESC}[2J`);
  });
});
