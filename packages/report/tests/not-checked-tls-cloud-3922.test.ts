// The "Not checked" hint for security/tls-certificate (#3922): a hosted audit
// gets a hint with no advice about networks, proxies or --offline; a local one
// keeps the existing hint.

import { describe, expect, test } from "bun:test";

import { TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON } from "@squirrelscan/core-contracts";

import { notCheckedRules } from "../src/not-checked";
import type { AuditReport } from "../src/types";

function report(details?: Record<string, unknown>): AuditReport {
  return {
    baseUrl: "https://example.com",
    ruleResults: {
      "security/tls-certificate": {
        meta: {
          id: "security/tls-certificate",
          name: "TLS Certificate",
          description: "d",
          category: "security",
          scope: "site",
          severity: "error",
          weight: 6,
        },
        checks: [
          {
            name: "tls-certificate",
            status: "skipped",
            message: "TLS certificate not checked: the hosted audit could not open a TLS connection to the site",
            value: "not-checked",
            skipReason: TLS_CERTIFICATE_NOT_CHECKED_SKIP_REASON,
            ...(details ? { details } : {}),
          },
        ],
      },
    },
  } as unknown as AuditReport;
}

describe("security/tls-certificate hint by environment (#3922)", () => {
  test("a cloud check gets a hint without network, proxy or --offline advice", () => {
    const [rule] = notCheckedRules(report({ environment: "cloud" }));
    expect(rule!.hint).not.toMatch(/[Pp]roxy|--offline|[Nn]etwork|CONNECT/);
    expect(rule!.hint).toContain("TLS connection");
  });

  test("a local check keeps the existing hint", () => {
    const [rule] = notCheckedRules(report());
    expect(rule!.hint).toContain("Run the audit again from a network that can open a direct TLS connection");
    expect(rule!.hint).toContain("--offline");
  });
});
