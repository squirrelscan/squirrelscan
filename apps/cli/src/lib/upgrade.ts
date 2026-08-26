// The upgrade offer, in one place, for every surface that can hit the credit
// wall: `squirrel credits`, the preflight balance line, and a register failure
// mid-audit.
//
// Before this, the CLI had three different "where to pay" URLs and only one of
// them worked. `squirrel credits` printed https://squirrelscan.com/account/credits,
// which has never been a route on the marketing site, so the single most direct
// question a paying-curious user can ask the CLI answered with a 404.
//
// The URL is squirrelscan.com/upgrade, not an app.squirrelscan.com deep link.
// Billing lives under /$org/settings/billing and the CLI does not reliably know
// the org slug (an API key acts for an org the user never named), and a binary
// already on someone's machine can never be corrected — so the CLI points at a
// stable marketing URL and lets the site own the mapping.

import { computeCost } from "@squirrelscan/core-contracts/credits";
import { getPlan } from "@squirrelscan/core-contracts/plans";

import { fmt } from "@/cli/format";

/** planId stays "starter" in the DB and Stripe; users only ever see "Pro". */
const PRO = getPlan("starter");

/** Cheapest possible audit: a balance under this can buy no cloud audit at all. */
export const AUDIT_BASE_CREDITS = computeCost("audit_base", 1);
export const RENDER_PAGE_CREDITS = computeCost("render", 1);

const UPGRADE_BASE = "https://squirrelscan.com/upgrade";

/**
 * The one public upgrade URL. `src` is attribution only, so the surface that
 * sold the upgrade can be told apart from the ones that didn't.
 */
export function upgradeUrl(src: "cli" | "cli-audit" | "cli-credits"): string {
  return `${UPGRADE_BASE}?src=${src}`;
}

const n = (value: number) => value.toLocaleString("en-US");

/** One line naming the price and the grant. Safe to embed anywhere. */
export const PRO_HEADLINE = `Pro: $${PRO.priceMonthUsd}/month (or $${PRO.priceYearUsd}/year) for ${n(PRO.monthlyCredits)} credits a month`;

/**
 * The full pitch, as lines ready to `log()`. Used verbatim by every CLI surface
 * so the price and the feature list can never drift between them.
 */
export function proPitchLines(
  src: "cli" | "cli-audit" | "cli-credits"
): string[] {
  return [
    `  ${fmt.bold(PRO_HEADLINE)}`,
    `  ${fmt.dim(`Also unlocks scheduled audits, custom request headers, and up to ${n(PRO.maxPagesPerAudit)} pages per audit.`)}`,
    `  Upgrade: ${fmt.cyan(upgradeUrl(src))}`,
  ];
}

/** What an audit costs, stated in the same words everywhere. */
export const AUDIT_PRICING_LINE = `Every cloud audit costs ${AUDIT_BASE_CREDITS} credits base plus ${RENDER_PAGE_CREDITS} per rendered page.`;
