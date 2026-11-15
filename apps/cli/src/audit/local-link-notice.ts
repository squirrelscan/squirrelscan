// pub#800: an audit that checked its external links only from this machine
// lists the ones a bot or sign-in wall (or a timeout) left unverifiable apart
// from the broken ones. Say once, after the audit, why there are so many and
// what gets a real answer for them.
//
// pub#823: what sends links to the cloud link checker is a signed-in Surface
// or Full audit, not signing in alone: a signed-in Quick audit still checks
// them from this machine, so it gets the notice too, and the advice names the
// level and the credits those checks cost.

import type { AuditReport } from "@/types";

const RULE_ID = "links/broken-external-links";
const BLOCKED_CHECKS = new Set([
  "waf-blocked-external-links",
  "rate-limited-external-links",
]);

/**
 * The Perch upsell for links that could not be verified by the local checker.
 */
export function localUnverifiedLinksNotice(
  report: Pick<AuditReport, "ruleResults">,
  account: { signedIn: boolean; hasAccount: boolean; cloudLevel: boolean }
): string | null {
  if (account.signedIn && account.cloudLevel) return null;
  const rows =
    report.ruleResults[RULE_ID]?.checks.filter((check) =>
      BLOCKED_CHECKS.has(check.name)
    ) ?? [];
  const count = rows.reduce(
    (total, row) => total + (row.items?.length ?? 0),
    0
  );
  if (count === 0) return null;
  return `${count} of these links may be false positives: sites often block plain requests (403, 406, 429, 999 or a Cloudflare/Akamai block). Perch in the cloud checks them properly: squirrel auth login`;
}
