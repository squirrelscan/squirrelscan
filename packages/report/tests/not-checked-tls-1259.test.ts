// #1259: security/tls-certificate with no handshake (a proxy in the environment, an
// unreachable host) is listed as "Not checked" in every format, never left out so the
// rule reads as clean.

import { describe, expect, test } from "bun:test";

import { TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON } from "@squirrelscan/core-contracts";

import { notCheckedLines, notCheckedRules } from "../src/not-checked";
import { renderJson } from "../src/output/json";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import type { AuditReport } from "../src/types";

const MESSAGE =
  "TLS certificate not checked: an HTTP proxy is set in the environment, and a direct TLS connection would go around it";

function report(): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-30T10:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {
      "security/tls-certificate": {
        meta: {
          id: "security/tls-certificate",
          name: "TLS Certificate",
          description: "TLS certificate description",
          category: "security",
          scope: "site",
          severity: "error",
          weight: 6,
        },
        checks: [
          {
            name: "tls-certificate",
            status: "skipped",
            message: MESSAGE,
            value: "not-checked",
            skipReason: TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON,
          },
        ],
      },
    },
  } as unknown as AuditReport;
}

describe("security/tls-certificate not checked (#1259)", () => {
  test("it is collected with its reason, message and a hint", () => {
    const [rule] = notCheckedRules(report());
    expect(rule).toMatchObject({
      ruleId: "security/tls-certificate",
      name: "TLS Certificate",
      check: "tls-certificate",
      reason: TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON,
      message: MESSAGE,
    });
    expect(rule?.hint).toContain("direct TLS connection");
    expect(notCheckedLines(report())[0]).toStartWith("Not checked: TLS Certificate.");
  });

  test("the JSON report lists it under notChecked", () => {
    const json = JSON.parse(renderJson(report() as never) as string) as {
      notChecked?: Array<{ ruleId: string; reason: string }>;
    };
    expect(json.notChecked).toEqual([
      expect.objectContaining({
        ruleId: "security/tls-certificate",
        reason: TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON,
      }),
    ]);
  });

  test("the text and markdown reports show the same line", () => {
    for (const out of [renderText(report() as never), renderMarkdown(report() as never)]) {
      expect(String(out)).toContain("TLS certificate not checked");
    }
  });
});
