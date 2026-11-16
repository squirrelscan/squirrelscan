// Cloud-service result plumbing for rules.
//
// Cloud rules stay zero-HTTP: a prefetch phase (packages/audit-engine) batches
// the credit-gated `/v1/services/*` calls, stamps the results into a store, and
// the runner threads that store onto each rule's `ctx.cloudResults` (per audit
// run, not a process global). Rules read their slice synchronously with
// `readCloudResult(ctx.cloudResults, …)` and emit `skipped` + `skipReason` when
// a result is absent (logged out, out of credits, service down, …). No rule ever
// opens a socket or knows about credits.

import {
  A11Y_SNAPSHOT_LIMITS,
  type A11ySnapshot,
  type A11ySnapshotSection,
  type RenderResultItem,
  CLOUD_PREFETCH_OUT_OF_TIME_SKIP_REASON,
  type CloudServiceId,
  type CreditFeature,
} from "@squirrelscan/core-contracts";

/** Why a cloud result is unavailable to a rule. Surfaced as `CheckResult.skipReason`. */
export type CloudSkipReason =
  | "not-authenticated" // no CLI token / logged out
  | "insufficient-credits" // balance below the call's cost
  | "service-unavailable" // provider/API error during prefetch
  | "payload-too-large" // batch request body rejected by the API size limit
  | "credit-cap-reached" // hit `[cloud].max_credits_per_audit`
  | "not-applicable" // Stage-1 gating (via the Stage-0 site metadata) ruled this service out for this site type
  | "render-failed" // service rendered ok but this page failed (nav timeout / JS error)
  | "render-disabled" // the run was configured not to render (render: false): the render service was never asked
  | "prefetch-out-of-time" // the prefetch hit its time budget before this result came back (repo#2129): "not checked"
  | "not-prefetched"; // rule enabled but prefetch never ran for it

/**
 * Per-key cloud result. `status: "ok"` carries `data`; `status: "skipped"`
 * carries a `skipReason` the rule turns into a human hint. `creditsSpent` is the
 * actual debit attributed to this key (0 on skip / cache hit).
 */
export interface CloudResultEnvelope<T = unknown> {
  status: "ok" | "skipped";
  skipReason?: CloudSkipReason;
  data?: T;
  creditsSpent?: number;
}

/**
 * Injected cloud results: service → key → envelope. The key is the unit the
 * service is addressed by — a page URL (`unit: "page"`/`"link"`) or the literal
 * `"site"` for site-scoped services. Built by the prefetch phase.
 */
export type CloudResultStore = Map<CloudServiceId, Map<string, CloudResultEnvelope>>;

/** Field added to `RuleMeta` for cloud-backed rules — declares the service it reads. */
export interface RuleCloudSpec {
  /** Which `/v1/services/*` endpoint feeds this rule. */
  service: CloudServiceId;
  /** Addressing unit: per page, per external link, or once for the whole site. */
  unit: "page" | "site" | "link";
  /** Credit feature billed for this service (drives estimate + ledger). */
  creditFeature: CreditFeature;
  /**
   * The rule reads the per-page accessibility snapshot on the `render` result (repo#3087).
   * The prefetch then asks the render service for it, and renders pages a rendered crawl
   * would otherwise skip (the snapshot is not self-identical to the crawl's HTML).
   */
  a11ySnapshot?: boolean;
}

/** Site-scoped store key — services with `unit: "site"` register under this. */
export const CLOUD_SITE_KEY = "site";

/**
 * Cloud services no execution path can fulfil yet (#656): rules reading them
 * always skip `not-prefetched`, on free AND paid runs alike, so the locked-rules
 * upsell must not advertise them. Remove entries as the services get wired.
 *
 * `render` was wired into cloud-prefetch for ax/content-without-js (#673), so it
 * left this set — it now runs on raw-HTML crawls (skipped, not advertised-unwired,
 * on rendered crawls).
 */
export const UNWIRED_CLOUD_SERVICES: ReadonlySet<CloudServiceId> = new Set<CloudServiceId>([]);

/**
 * Read a single prefetched cloud result from a per-run store. `key` is the page
 * URL for per-page / per-link services; omit it (or pass the default) for
 * site-scoped services. Returns the typed envelope, or `undefined` when nothing
 * was prefetched for this (service, key) — the rule treats `undefined` as
 * `not-prefetched`.
 *
 * The store lives on the RULE CONTEXT (`ctx.cloudResults`), threaded per audit
 * run rather than a process-global singleton, so concurrent audits in one
 * isolate never read each other's results. Cloud rules MUST call this (passing
 * their `ctx`) — there is no module-global cloud store to fall back on.
 */
export function readCloudResult<T>(
  store: CloudResultStore | undefined,
  service: CloudServiceId,
  key: string = CLOUD_SITE_KEY,
): CloudResultEnvelope<T> | undefined {
  return store?.get(service)?.get(key) as CloudResultEnvelope<T> | undefined;
}

/**
 * Consistent operator-facing copy for a skip, with a remedy. Renderers/banners
 * use this so the hint reads the same everywhere a cloud rule is skipped.
 */
export function humanizeCloudSkip(reason: CloudSkipReason): string {
  switch (reason) {
    case "not-authenticated":
      return "Cloud analysis skipped — run `squirrel auth login` to enable it.";
    case "insufficient-credits":
      return "Cloud analysis skipped — out of credits. Top up at https://squirrelscan.com/account/credits.";
    case "service-unavailable":
      return "Cloud analysis skipped — the service was unavailable. Try again later.";
    case "payload-too-large":
      return "Cloud analysis skipped — the page batch was too large to submit. Lower `[cloud].batch_size` and re-run.";
    case "credit-cap-reached":
      return "Cloud analysis skipped — hit the per-audit credit cap (`[cloud].max_credits_per_audit`).";
    case "not-applicable":
      // computeLockedRules keys off this exact sentence via
      // isNotApplicableCloudSkip — update both together on any copy edit.
      return "Cloud analysis skipped — not applicable to this site type.";
    case "render-failed":
      return "Cloud analysis skipped — the page could not be rendered (navigation timeout or JS error).";
    case "render-disabled":
      return "Cloud analysis skipped — render disabled by the run config.";
    case "not-prefetched":
      return "Cloud analysis skipped — no result was prefetched for this page.";
    case "prefetch-out-of-time":
      // A coded not-checked reason (rule-outcome.ts), so reports list the rule
      // as "Not checked" rather than reading the missing result as clean.
      return CLOUD_PREFETCH_OUT_OF_TIME_SKIP_REASON;
  }
}

/**
 * True when a stored check's `skipReason` is the not-applicable gate (#656).
 * Checks persist only the humanized sentence (CheckResult.skipReason is a bare
 * string), so this is the single place that string is matched — producers and
 * this predicate both go through `humanizeCloudSkip`, keeping them in lockstep.
 */
export function isNotApplicableCloudSkip(skipReason: string | undefined): boolean {
  return skipReason === humanizeCloudSkip("not-applicable");
}

/**
 * True when a stored check's `skipReason` is the run-configured "render disabled"
 * skip (`render-disabled`, private#3792). Like not-applicable, it is the run's own
 * choice, not something a paid run would unlock, so it must stay off the locked-rules
 * upsell. Same single-place matching of the humanized sentence as above.
 */
export function isRenderDisabledCloudSkip(skipReason: string | undefined): boolean {
  return skipReason === humanizeCloudSkip("render-disabled");
}

/** Outcome of reading a page's accessibility snapshot (repo#3087). */
export type A11ySnapshotRead =
  | { status: "ok"; snapshot: A11ySnapshot; truncated: boolean }
  | { status: "skipped"; skipReason: CloudSkipReason };

/**
 * Read one page's accessibility snapshot from the prefetched `render` result. A skipped
 * envelope keeps its reason; a render that returned no html, no snapshot or a malformed
 * one is `render-failed`; a missing envelope is `not-prefetched`. Caps are re-enforced
 * here (an older or misbehaving service cannot blow the report size), and anything cut
 * is flagged `truncated` with per-section drop counts instead of vanishing.
 */
export function readA11ySnapshot(
  store: CloudResultStore | undefined,
  pageUrl: string,
): A11ySnapshotRead {
  const env = readCloudResult<RenderResultItem>(store, "render", pageUrl);
  if (!env) return { status: "skipped", skipReason: "not-prefetched" };
  if (env.status === "skipped") {
    return { status: "skipped", skipReason: env.skipReason ?? "not-prefetched" };
  }
  const raw = env.data?.a11ySnapshot;
  if (
    !raw ||
    !Array.isArray(raw.textNodes) ||
    !Array.isArray(raw.interactive) ||
    !Array.isArray(raw.tabOrder) ||
    !Array.isArray(raw.boxes)
  ) {
    return { status: "skipped", skipReason: "render-failed" };
  }
  const dropped: Partial<Record<A11ySnapshotSection, number>> = { ...raw.dropped };
  const cap = <T>(section: A11ySnapshotSection, items: T[], max: number): T[] => {
    if (items.length <= max) return items;
    dropped[section] = (dropped[section] ?? 0) + (items.length - max);
    return items.slice(0, max);
  };
  const L = A11Y_SNAPSHOT_LIMITS;
  const snapshot: A11ySnapshot = {
    textNodes: cap("textNodes", raw.textNodes, L.textNodes),
    interactive: cap("interactive", raw.interactive, L.interactive),
    tabOrder: cap("tabOrder", raw.tabOrder, L.tabOrder),
    boxes: cap("boxes", raw.boxes, L.boxes),
    truncated: raw.truncated === true,
    ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
  };
  if (Object.keys(dropped).length > 0) snapshot.truncated = true;
  return { status: "ok", snapshot, truncated: snapshot.truncated };
}
