// ── Credit Pricing ──────────────────────────────────────────────
// Credit costs for cloud-enriched features. Bump CREDIT_PRICING_VERSION
// whenever any cost or unit changes so consumers can detect drift.

export const CREDIT_PRICING_VERSION = 11;

export interface CreditPrice {
  cost: number;
  per: number;
  unit: "page" | "url" | "run" | "report" | "issue";
}

// Pricing v11 (#2290, #2291): an audit costs `audit_base` (50cr, debited at run
// registration/dispatch) + `audit_page` (2cr per audited page, however the page
// was obtained: plain HTTP, a browser render, the local or remote cache, a 304,
// or a fallback after a failed render) + `external_link` (1cr per distinct
// external destination OUR CLOUD checks during a cloud audit). Internal link
// checks are free, and so are the checks a signed-in CLI runs for itself.
// Every other service that runs inside an audit is folded into the base at cost
// 0. The cost-0 keys STAY: the ledger keeps per-feature units for COGS
// analytics, and the idempotency-keyed 0-debit rows keep the replay dedup that
// protects provider spend. Caching never discounts the customer price — the
// cache savings are our margin.
export const CREDIT_COSTS = {
  // Flat per-audit charge covering every folded (cost-0) service below.
  // Auto-refunded when the run terminally fails (reverseRunCharges sweep).
  audit_base: { cost: 50, per: 1, unit: "run" },
  // One audited page (#2290). A page rendered inside an audit is billed HERE,
  // once, when its render is submitted; every other page is settled when the
  // run completes. Never stacked with a `render` charge for the same audit.
  audit_page: { cost: 2, per: 1, unit: "page" },
  // One distinct external destination checked by the cloud during a cloud
  // audit (#2291), whatever status it returns. HEAD/GET fallback, browser
  // escalation and retries never multiply it.
  external_link: { cost: 1, per: 1, unit: "url" },
  // A STANDALONE render: a render call that belongs to no in-flight audit run.
  // Inside an audit the page is billed as `audit_page` instead.
  render: { cost: 2, per: 1, unit: "page" },
  // Cross-audit render cache HIT (#193) outside an audit: same price as a fresh
  // render; kept as a distinct ledger feature so hit-rate/COGS stay observable.
  render_cached: { cost: 2, per: 1, unit: "page" },
  // Opt-in add-ons — the only audit-scoped features still itemized.
  keyword_gaps: { cost: 25, per: 1, unit: "run" },
  content_gaps: { cost: 25, per: 1, unit: "run" },
  // AI issue enrichment — one Gemini Flash call per issue, charged on the
  // manual enrich routes (not part of an audit run).
  issue_enrich: { cost: 3, per: 1, unit: "issue" },
  // ── Folded into audit_base (cost 0; still gated: org lock + positive balance) ──
  // report_publish charges NOTHING and is no longer gated at all — publishing
  // (any visibility, incl. later flips to public) always succeeds. Key kept
  // only so historical ledger rows keep their label.
  report_publish: { cost: 0, per: 1, unit: "report" },
  ai_parse: { cost: 0, per: 1, unit: "page" },
  authority_signals: { cost: 0, per: 1, unit: "page" },
  adblock_detect: { cost: 0, per: 1, unit: "run" },
  privacy_block: { cost: 0, per: 1, unit: "run" },
  site_metadata: { cost: 0, per: 1, unit: "run" },
  // HEAD/GET link checks a signed-in CLI sends to the cloud dead-links service
  // are free (#2291); a WAF-blocked link the service escalates to a browser
  // render still bills as a standalone `render`. A cloud audit's checks bill
  // `external_link` per destination instead, escalation included.
  dead_links: { cost: 0, per: 100, unit: "url" },
  tech_detect: { cost: 0, per: 1, unit: "run" },
  editor_summary: { cost: 0, per: 1, unit: "run" },
  domain_stats: { cost: 0, per: 1, unit: "run" },
  // Archive Indexing (#789) — Wayback + Common Crawl per-domain lookups, folded
  // into the base under v10. Key kept: the 0-debit idempotency row dedups the
  // per-(domain,audit) provider replay.
  archive_indexing: { cost: 0, per: 1, unit: "run" },
} satisfies Record<string, CreditPrice>;

export type CreditFeature = keyof typeof CREDIT_COSTS;

export const computeCost = (f: CreditFeature, units: number): number =>
  Math.ceil(units / CREDIT_COSTS[f].per) * CREDIT_COSTS[f].cost;

/**
 * Distinct external destinations a cloud audit budgets for per audited page
 * (#2291). Nobody knows a site's external-link count before the crawl, so the
 * quote reserves this many per page; destinations past the reserve are still
 * checked, just not charged, so the quoted cap always holds.
 */
export const EXTERNAL_LINK_BUDGET_PER_PAGE = 1;

/** What an audit is priced on before it runs. */
export interface AuditCostInput {
  maxPages: number;
  /**
   * The cloud will check this audit's external links: a cloud audit with
   * external link checking on. A CLI audit's link checks are free, so a CLI
   * estimate leaves this unset.
   */
  cloudExternalLinks?: boolean;
}

/** Credits each page of the page cap commits an audit to: the page itself plus its external-link reserve. */
export const auditCreditsPerPage = (cloudExternalLinks = false): number =>
  computeCost("audit_page", 1) +
  (cloudExternalLinks ? computeCost("external_link", EXTERNAL_LINK_BUDGET_PER_PAGE) : 0);

/** External destinations a cloud audit of `maxPages` pages may be charged for. */
export const externalLinkBudget = (maxPages: number): number =>
  Math.max(1, Math.floor(maxPages)) * EXTERNAL_LINK_BUDGET_PER_PAGE;

/**
 * Upper-bound credit estimate for a cloud/CLI audit — the "up to N" CAP shown
 * before a run and stamped on it as `maxCredits`: base + 2cr × maxPages, plus
 * the external-link reserve for a cloud audit that checks external links.
 * Actual spend is base + 2cr × pages actually audited (≤ maxPages) + 1cr per
 * external destination actually checked (≤ the reserve). Opt-in add-ons
 * (keyword/content gaps) are charged and confirmed separately.
 */
export const estimateAuditCap = (input: AuditCostInput): number => {
  const pages = Math.max(1, Math.floor(input.maxPages));
  return computeCost("audit_base", 1) + pages * auditCreditsPerPage(input.cloudExternalLinks);
};

/**
 * Credit RANGE shown before a run: `min` = a one-page audit with no external
 * links, `max` = the full cap. Reuses the same pricing as estimateAuditCap.
 */
export const estimateAuditRange = (
  input: AuditCostInput,
): {
  min: number;
  max: number;
} => ({
  min: estimateAuditCap({ maxPages: 1 }),
  max: estimateAuditCap(input),
});

/** The cheapest audit there is: the base plus one page. Below this, refuse. */
export const minimumAuditCredits = (cloudExternalLinks = false): number =>
  computeCost("audit_base", 1) + auditCreditsPerPage(cloudExternalLinks);

/** A run's page cap after fitting it to what its credits can pay for. */
export interface AuditPageBudget {
  /** Pages the run may audit. 0 ⇒ not even one page is affordable: refuse the run. */
  maxPages: number;
  /** The page cap before the clamp. */
  requestedMaxPages: number;
  /** `maxPages < requestedMaxPages`. */
  clamped: boolean;
  /**
   * What bound it, when clamped: the org's `balance`, or the per-audit credit
   * `cap` the customer set (CLI `[cloud] max_credits_per_audit`, a website's
   * per-audit cap).
   */
  limitedBy?: "balance" | "cap";
}

/**
 * Fit an audit's page cap to the credits that can pay for it (#2290).
 *
 * Every audited page costs, so an audit priced past the balance would run out
 * of credits part-way. Rather than refuse a run a smaller audit could afford,
 * the page cap comes down to `floor((credits − base) / perPage)`, where perPage
 * is 2cr, or 3cr when the cloud checks external links. Only a run that cannot
 * pay for even one page comes back with `maxPages: 0`, which callers refuse.
 *
 * An unmetered balance (enterprise) and an absent one bound nothing; a `cap` of
 * 0 or less means "no cap", matching `max_credits_per_audit = 0`.
 */
export const clampAuditPages = (input: {
  maxPages: number;
  balance?: number | null;
  unlimited?: boolean;
  cap?: number | null;
  cloudExternalLinks?: boolean;
}): AuditPageBudget => {
  const requested = Math.max(1, Math.floor(input.maxPages));
  const base = computeCost("audit_base", 1);
  const perPage = auditCreditsPerPage(input.cloudExternalLinks);
  const pagesFor = (credits: number) => Math.max(0, Math.floor((credits - base) / perPage));
  const byBalance =
    input.unlimited || input.balance == null || !Number.isFinite(input.balance)
      ? Number.POSITIVE_INFINITY
      : pagesFor(input.balance);
  const byCap = input.cap != null && input.cap > 0 ? pagesFor(input.cap) : Number.POSITIVE_INFINITY;
  const maxPages = Math.min(requested, byBalance, byCap);
  if (maxPages >= requested) return { maxPages: requested, requestedMaxPages: requested, clamped: false };
  return {
    maxPages,
    requestedMaxPages: requested,
    clamped: true,
    limitedBy: byBalance <= byCap ? "balance" : "cap",
  };
};

// ── Credit Top-ups (one-time purchases) ─────────────────────────
// User picks any whole-dollar amount (min $10); checkout uses inline Stripe
// price_data — no pre-created Stripe products. Top-ups are PAID-PLAN ONLY:
// the checkout route rejects free orgs. Credits land in the non-expiring
// pack bucket (ledger entry_type stays `grant_pack`).

export const CREDIT_TOPUP = {
  minUsd: 10,
  maxUsd: 1_000,
  creditsPerUsd: 100,
} as const;

/** Credits granted for a whole-dollar top-up amount. */
export const topupCreditsForUsd = (usd: number): number =>
  Math.floor(usd) * CREDIT_TOPUP.creditsPerUsd;

// ── Legacy credit packs (DEPRECATED) ────────────────────────────
// No longer purchasable. Kept ONLY so the Stripe webhook can honor checkout
// sessions minted before the top-up cutover. Remove after 2026-07.

export type CreditPackId = "pack_1000" | "pack_5000";

export const CREDIT_PACKS: Record<CreditPackId, { credits: number; priceUsd: number }> = {
  pack_1000: { credits: 1000, priceUsd: 9 },
  pack_5000: { credits: 5000, priceUsd: 39 },
} as const;

// ── Per-audit cost breakdown (#1134) ─────────────────────────────
// A per-feature account of what one audit run charged (and had refunded),
// surfaced identically in the dashboard cost card, the MCP get_report/
// get_audit_status output, and the API audit-detail response. Two sources
// feed the same shape: the report payload's embedded `cloudSpend` (CLI runs,
// incl. historical) or the `credit_ledger` debits/refunds tagged with the
// run id (cloud/container runs + threaded CLI renders).

/** One feature's charge (and any reversal) for a single audit run. */
export interface AuditCostLine {
  /** Credit feature key (e.g. "audit_base", "audit_page", "external_link", folded 0-cost services). */
  feature: string;
  /** Units billed — pages for audit_page/render, destinations for external_link, null for flat/base features. */
  units: number | null;
  /** Credits charged for this feature (0 for folded "included" services). */
  charged: number;
  /** Credits refunded against this feature's charges (positive; e.g. a cancelled run's base). */
  refunded: number;
}

/** Full per-audit cost account. `netSpent = totalCharged - totalRefunded`. */
export interface AuditCostBreakdown {
  lines: AuditCostLine[];
  /** Sum of every line's `charged`. */
  totalCharged: number;
  /** Sum of every line's `refunded` (positive). */
  totalRefunded: number;
  /** Credits actually kept for this audit (`totalCharged - totalRefunded`). */
  netSpent: number;
  /** Balance immediately after the audit when the report recorded it; null for ledger-derived. */
  balanceAfter: number | null;
  /** Where the breakdown was derived from — the report's `cloudSpend` or the ledger. */
  source: "report" | "ledger";
}
