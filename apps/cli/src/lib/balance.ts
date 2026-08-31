// One reading of "can this account afford things?" for every CLI surface that
// used to compare `balance.total` against a cost.
//
// The enterprise plan (internal, 2026-08-28) is not metered against a prepaid
// balance: `GET /v1/credits` returns `balance.unlimited: true` and the stored
// numbers are frozen. Comparing `total` against a price there is wrong in both
// directions — a frozen 0 would drop the run to local-only, and a frozen 5,000
// would look like a balance that can run out. Every gate, warning and upsell in
// the CLI must therefore ask `isUnlimitedBalance` first.
//
// The field is OPTIONAL on the wire: a binary already on someone's machine
// talks to whatever server it finds, and servers predating the plan omit it.
// Absent = metered, which is the safe reading (it keeps today's behaviour).

/**
 * Preflight balance passed to a spend-confirm prompt. `"unlimited"` renders as
 * that word instead of a misleading frozen number.
 */
export type PreflightBalance = number | "unlimited";

/**
 * True when the account's plan is not metered. Deliberately takes the loose
 * shape rather than `CreditsResponse["balance"]` so callers holding a partially
 * typed or hand-built payload (tests, the run-tracker's register response) can
 * pass it without a cast. `undefined`/`null` → false.
 */
export function isUnlimitedBalance(
  balance: { unlimited?: boolean } | null | undefined
): boolean {
  return balance?.unlimited === true;
}

/** The balance as shown to a user: a grouped number, or the word "unlimited". */
export function formatBalance(total: number, unlimited: boolean): string {
  return unlimited ? "unlimited" : total.toLocaleString("en-US");
}

/**
 * The balance to hand a confirm prompt. Unlimited accounts still see the
 * estimate (the spend is real, it is just invoiced rather than deducted), so
 * the prompt is kept — only the balance half changes.
 */
export function preflightBalanceOf(balance: {
  total: number;
  unlimited?: boolean;
}): PreflightBalance {
  return isUnlimitedBalance(balance) ? "unlimited" : balance.total;
}
