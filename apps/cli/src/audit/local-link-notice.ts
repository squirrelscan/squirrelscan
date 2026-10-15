// pub#800: an audit that checked its external links only from this machine
// lists the ones a bot or sign-in wall (or a timeout) left unverifiable apart
// from the broken ones. Say once, after the audit, why there are so many and
// what gets a real answer for them.

import type { AuditReport } from "@/types";

const RULE_ID = "links/broken-external-links";
const UNVERIFIED_CHECK = "waf-blocked-external-links";

/**
 * The summary notice for links checked only from this machine that came back
 * unverifiable, or null: none came back so, or the audit ran signed in and
 * the cloud link checker had its turn. `hasAccount` is a saved login or token
 * the audit could not use this run (no credits, an outage).
 */
export function localUnverifiedLinksNotice(
  report: Pick<AuditReport, "ruleResults">,
  account: { signedIn: boolean; hasAccount: boolean }
): string | null {
  if (account.signedIn) return null;
  const row = report.ruleResults[RULE_ID]?.checks.find(
    (check) => check.name === UNVERIFIED_CHECK
  );
  const count = row?.items?.length ?? 0;
  if (count === 0) return null;
  const links = count === 1 ? "1 external link" : `${count} external links`;
  const verb = count === 1 ? "it is" : "they are";
  const next = account.hasAccount
    ? "A signed-in audit with credits checks them with squirrelscan's cloud link checker."
    : "Sign in with `squirrel auth login` to check them with squirrelscan's cloud link checker.";
  return `${links} could not be verified from this machine (bot protection or a timeout), so ${verb} listed as unverified, not broken. ${next}`;
}
