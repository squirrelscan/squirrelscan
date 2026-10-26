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

import { EXTERNAL_LINK_CREDITS } from "@/lib/upgrade";

const RULE_ID = "links/broken-external-links";
const UNVERIFIED_CHECK = "waf-blocked-external-links";

const COST = `at ${EXTERNAL_LINK_CREDITS} ${EXTERNAL_LINK_CREDITS === 1 ? "credit" : "credits"} per link it checks (at most 1 per page)`;

/**
 * The summary notice for links checked only from this machine that came back
 * unverifiable, or null: none came back so, or the audit ran signed in at a
 * level that sends links to the cloud link checker (`cloudLevel`: Surface and
 * Full), so the cloud had its turn. `hasAccount` is a saved login or token the
 * audit could not use this run (too few credits, a spend cap below the
 * minimum, an outage).
 */
export function localUnverifiedLinksNotice(
  report: Pick<AuditReport, "ruleResults">,
  account: { signedIn: boolean; hasAccount: boolean; cloudLevel: boolean }
): string | null {
  if (account.signedIn && account.cloudLevel) return null;
  const row = report.ruleResults[RULE_ID]?.checks.find(
    (check) => check.name === UNVERIFIED_CHECK
  );
  const count = row?.items?.length ?? 0;
  if (count === 0) return null;
  const links = count === 1 ? "1 external link" : `${count} external links`;
  const verb = count === 1 ? "it is" : "they are";
  const them = count === 1 ? "it" : "them";
  const next = account.signedIn
    ? `A Quick audit checks links only from this machine: run \`squirrel audit --level surface\` (or \`--level full\`) to check ${them} with squirrelscan's cloud link checker, ${COST}.`
    : account.hasAccount
      ? `A Surface or Full audit that can use the cloud (signed in, with enough credits) checks ${them} with squirrelscan's cloud link checker, ${COST}.`
      : `Sign in with \`squirrel auth login\` and run a Surface or Full audit (Surface is the default once signed in) to check ${them} with squirrelscan's cloud link checker, ${COST}.`;
  return `${links} could not be verified from this machine (bot protection or a timeout), so ${verb} listed as unverified, not broken. ${next}`;
}
