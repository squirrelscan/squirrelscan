/**
 * The low-credit nudge (repo#1118): "Balance 40 credits, next audit needs ~64".
 *
 * Printed only when the balance cannot cover the next estimated audit, so an
 * agent driving the CLI has one line to relay to its human. Frequency-capped:
 * it speaks at most once per window per account, in this process and across
 * runs (via the `credit_nudge_at` setting).
 */
export const CREDIT_NUDGE_WINDOW_MS = 24 * 60 * 60 * 1000;

const shownThisProcess = new Map<string, number>();

/** Test hook: forget the in-process cap. */
export function resetCreditNudgeCap(): void {
  shownThisProcess.clear();
}

/**
 * Claim the right to print the nudge. Returns true at most once per window for
 * a key; claiming records it in memory, the caller persists `credit_nudge_at`.
 */
export function claimCreditNudge(opts: {
  key: string;
  lastShownAt?: string | null;
  now?: number;
  windowMs?: number;
}): boolean {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? CREDIT_NUDGE_WINDOW_MS;
  const inMemory = shownThisProcess.get(opts.key);
  if (inMemory !== undefined && now - inMemory < windowMs) return false;
  const persisted = opts.lastShownAt ? Date.parse(opts.lastShownAt) : NaN;
  if (Number.isFinite(persisted) && now - persisted < windowMs) return false;
  shownThisProcess.set(opts.key, now);
  return true;
}

export function creditNudgeLine(opts: {
  balance: number;
  nextEstimate: number;
  url: string;
  topUp: boolean;
}): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `Balance ${n(opts.balance)} credits, next audit needs ~${n(opts.nextEstimate)}. ${opts.topUp ? "Top up" : "Upgrade"}: ${opts.url} (shown once a day)`;
}
