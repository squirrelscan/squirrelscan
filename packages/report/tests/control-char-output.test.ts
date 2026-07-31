// End-to-end: page-derived terminal escapes must not survive into the text or
// llm renderers.
//
// The payload below is the one that matters — `ESC[2J ESC[1;1H` clears the
// screen and homes the cursor, so a malicious site can blank the real findings
// and repaint whatever it likes. The llm output is documented as pipeable
// straight into an agent (`--format llm | claude`), so it is also how control
// bytes would land in a model's context.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderLlm } from "../src/output/llm";
import { renderText } from "../src/output/text";

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

describe("page-derived control characters never reach report output", () => {
  test("renderText emits no ESC", () => {
    const out = renderText(hostileReport(), { version: "0.0.81" });
    expect(out).not.toContain(ESC);
  });

  test("renderLlm emits no ESC", () => {
    const out = renderLlm(hostileReport(), { version: "0.0.81" });
    expect(out).not.toContain(ESC);
  });

  test("no C0 control byte other than tab and newline survives", () => {
    // Broader than the ESC assertion: catches BEL, backspace, CR and NUL too.
    for (const out of [
      renderText(hostileReport(), { version: "0.0.81" }),
      renderLlm(hostileReport(), { version: "0.0.81" }),
    ]) {
      expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    }
  });

  test("the surrounding finding text still renders", () => {
    // The strip must not eat the report: a guard that blanked everything would
    // pass the assertions above for the wrong reason.
    const out = renderText(hostileReport(), { version: "0.0.81" });
    expect(out).toContain("Message ");
    expect(out).toContain("FORGED: 0 issues found");
    expect(out.length).toBeGreaterThan(200);
  });
});
