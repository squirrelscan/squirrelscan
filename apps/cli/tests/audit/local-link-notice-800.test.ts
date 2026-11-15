import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { localUnverifiedLinksNotice } from "../../src/audit/local-link-notice";

function report(unverified: number): Pick<AuditReport, "ruleResults"> {
  const checks = [
    {
      name: "broken-external-links",
      status: "pass",
      message: "All 3 external link(s) are working",
    },
    ...(unverified > 0
      ? [
          {
            name: "waf-blocked-external-links",
            status: "info",
            message: `${unverified} external link(s) could not be verified - status unverifiable`,
            items: Array.from({ length: unverified }, (_, i) => ({
              id: `https://walled.example/${i}`,
            })),
          },
        ]
      : []),
  ];
  return {
    ruleResults: {
      "links/broken-external-links": { meta: {}, checks },
    },
  } as unknown as Pick<AuditReport, "ruleResults">;
}

const SIGNED_OUT = { signedIn: false, hasAccount: false, cloudLevel: false };

describe("localUnverifiedLinksNotice (#2747)", () => {
  test("shows the Perch warning when possibly blocked links exist", () => {
    expect(localUnverifiedLinksNotice(report(7), SIGNED_OUT)).toBe(
      "7 of these links may be false positives: sites often block plain requests (403, 406, 429, 999 or a Cloudflare/Akamai block). Perch in the cloud checks them properly: squirrel auth login"
    );
  });

  test("shows nothing when no link is possibly blocked", () => {
    expect(localUnverifiedLinksNotice(report(0), SIGNED_OUT)).toBeNull();
  });
});
