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

describe("localUnverifiedLinksNotice (pub#800)", () => {
  test("signed out, with unverified links: says why and how to get an answer", () => {
    expect(
      localUnverifiedLinksNotice(report(3), {
        signedIn: false,
        hasAccount: false,
      })
    ).toBe(
      "3 external links could not be verified from this machine (bot protection or a timeout), so they are listed as unverified, not broken. Sign in with `squirrel auth login` to check them with squirrelscan's cloud link checker."
    );
    expect(
      localUnverifiedLinksNotice(report(1), {
        signedIn: false,
        hasAccount: false,
      })
    ).toContain(
      "1 external link could not be verified from this machine (bot protection or a timeout), so it is listed"
    );
  });

  test("a saved account the audit could not use this run is not told to sign in", () => {
    const notice = localUnverifiedLinksNotice(report(2), {
      signedIn: false,
      hasAccount: true,
    });
    expect(notice).toContain(
      "An audit that can use the cloud (signed in, with enough credits) checks them"
    );
    expect(notice).not.toContain("squirrel auth login");
  });

  test("nothing when signed in, or when no link came back unverified", () => {
    expect(
      localUnverifiedLinksNotice(report(3), {
        signedIn: true,
        hasAccount: true,
      })
    ).toBeNull();
    expect(
      localUnverifiedLinksNotice(report(0), {
        signedIn: false,
        hasAccount: false,
      })
    ).toBeNull();
    expect(
      localUnverifiedLinksNotice(
        { ruleResults: {} } as Pick<AuditReport, "ruleResults">,
        {
          signedIn: false,
          hasAccount: false,
        }
      )
    ).toBeNull();
  });
});
