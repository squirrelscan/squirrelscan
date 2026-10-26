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

describe("localUnverifiedLinksNotice (pub#800, pub#823)", () => {
  test("signed out, with unverified links: says why, and that a signed-in Surface or Full audit checks them for credits", () => {
    expect(localUnverifiedLinksNotice(report(3), SIGNED_OUT)).toBe(
      "3 external links could not be verified from this machine (bot protection or a timeout), so they are listed as unverified, not broken. Sign in with `squirrel auth login` and run a Surface or Full audit (Surface is the default once signed in) to check them with squirrelscan's cloud link checker, at 1 credit per link it checks (at most 1 per page)."
    );
    expect(localUnverifiedLinksNotice(report(1), SIGNED_OUT)).toBe(
      "1 external link could not be verified from this machine (bot protection or a timeout), so it is listed as unverified, not broken. Sign in with `squirrel auth login` and run a Surface or Full audit (Surface is the default once signed in) to check it with squirrelscan's cloud link checker, at 1 credit per link it checks (at most 1 per page)."
    );
  });

  test("signed out at Surface (the level is not what kept the cloud away): still names signing in", () => {
    const notice = localUnverifiedLinksNotice(report(2), {
      ...SIGNED_OUT,
      cloudLevel: true,
    });
    expect(notice).toContain("Sign in with `squirrel auth login`");
    expect(notice).toContain("1 credit per link it checks");
  });

  test("a saved account the audit could not use this run is not told to sign in", () => {
    const notice = localUnverifiedLinksNotice(report(2), {
      signedIn: false,
      hasAccount: true,
      cloudLevel: true,
    });
    expect(notice).toContain(
      "A Surface or Full audit that can use the cloud (signed in, with enough credits) checks them with squirrelscan's cloud link checker, at 1 credit per link it checks (at most 1 per page)."
    );
    expect(notice).not.toContain("squirrel auth login");
  });

  test("signed in at Quick: names --level surface or full and the credit cost", () => {
    const notice = localUnverifiedLinksNotice(report(4), {
      signedIn: true,
      hasAccount: true,
      cloudLevel: false,
    });
    expect(notice).toBe(
      "4 external links could not be verified from this machine (bot protection or a timeout), so they are listed as unverified, not broken. A Quick audit checks links only from this machine: run `squirrel audit --level surface` (or `--level full`) to check them with squirrelscan's cloud link checker, at 1 credit per link it checks (at most 1 per page)."
    );
    expect(notice).not.toContain("squirrel auth login");
  });

  test("nothing when signed in at a level the cloud checked links for, or when no link came back unverified", () => {
    expect(
      localUnverifiedLinksNotice(report(3), {
        signedIn: true,
        hasAccount: true,
        cloudLevel: true,
      })
    ).toBeNull();
    expect(localUnverifiedLinksNotice(report(0), SIGNED_OUT)).toBeNull();
    expect(
      localUnverifiedLinksNotice(
        { ruleResults: {} } as Pick<AuditReport, "ruleResults">,
        { signedIn: true, hasAccount: true, cloudLevel: false }
      )
    ).toBeNull();
  });
});
