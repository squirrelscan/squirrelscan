// How the server reads a published check, shared by the merge that reads it
// (`merge-promise.ts`) and the capper that counts it before sampling
// (`publish-cap.ts`): the two must agree on which checks are this run's
// evidence, or the tallies the capper ships would not be the numbers the merge
// would have counted from the rows (squirrelscan/repo#2657).
//
// Worker-clean: core-contracts types only.

import type { CheckResult } from "@squirrelscan/core-contracts";

/** 404/410 = page gone → stale its findings (not carry), and never score it. */
export const REMOVED_STATUSES: ReadonlySet<number> = new Set([404, 410]);

/**
 * True when a published check is a REPLAY, not evidence from this run (#2063).
 *
 * The producers tag every check they publish: `carried` = re-injected from the
 * producer's own finding store for a page this run did NOT crawl, `unrendered` =
 * a finding on a page no audit has ever rendered. Neither was observed by the
 * crawl being published, so neither may count as a crawled page or as a fresh
 * finding here — the cloud has its own store and its own history, and it decides
 * what to carry from that.
 *
 * The laundering this guards against is not hypothetical: a CLI whose LOCAL store
 * held 3,200 open findings on 508 URLs last seen weeks earlier published them as
 * carried, the server counted all 508 as crawled this run, and 129 "audited pages"
 * appeared for a 16-page crawl with every stale finding re-stamped as first seen
 * today (squirrelscan/repo#2063).
 *
 * Gated on the check being PAGE-ATTRIBUTED, so the ordinary site-scope check —
 * no `pageUrl`, no aggregate marker, scored from the shell verbatim — is never
 * dropped by a stray provenance tag. The gate reads the CHECK's shape, not the
 * rule's scope: a check carrying the aggregate marker and naming pages is treated
 * as a page replay whichever rule emitted it, which is the only honest reading of
 * a check that claims those pages.
 */
export function isReplayedCheck(check: CheckResult): boolean {
  return (
    isPageAttributed(check) &&
    (check.provenance === "carried" || check.provenance === "unrendered")
  );
}

/**
 * True when a check speaks for one or more PAGES: a per-page check carries a
 * `pageUrl`, and a folded aggregate carries its affected pages in `pages[]`
 * instead.
 *
 * Both forms matter. The sampled branch unfolds before it filters, so it only
 * ever sees the first; the COMPLETE-store branch deliberately does not unfold —
 * the shell's aggregates are its display surface — so there the second form is
 * the one a replay arrives as.
 *
 * The aggregate test is deliberately `unfoldAggregateCheck`'s own gate, so the
 * two branches agree on what an aggregate IS. A check carrying `pages` without
 * the `aggregated` marker is not unfolded there and is not page-attributed here:
 * either way it names no page this run is asked to believe in.
 */
export function isPageAttributed(check: CheckResult): boolean {
  if (check.pageUrl) return true;
  return check.details?.aggregated === true && !!check.pages && check.pages.length > 0;
}
