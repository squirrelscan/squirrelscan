// ── Credit Pricing ──────────────────────────────────────────────
// Credit costs for cloud-enriched features. Bump CREDIT_PRICING_VERSION
// whenever any cost or unit changes so consumers can detect drift.

export const CREDIT_PRICING_VERSION = 10;

export interface CreditPrice {
  cost: number;
  per: number;
  unit: "page" | "url" | "run" | "report" | "issue";
}

// Pricing v10 (#391): flat, predictable audits — `audit_base` (50cr, debited at
// run registration/dispatch) + `render` (2cr per rendered page, cache hit or
// miss). Every other service that runs inside an audit is folded into the base
// at cost 0. The cost-0 keys STAY: the ledger keeps per-feature units for COGS
// analytics, and the idempotency-keyed 0-debit rows keep the replay dedup that
// protects provider spend. Caching never discounts the customer price — the
// cache savings are our margin.
export const CREDIT_COSTS = {
  // Flat per-audit charge covering every folded (cost-0) service below.
  // Auto-refunded when the run terminally fails (reverseRunCharges sweep).
  audit_base: { cost: 50, per: 1, unit: "run" },
  render: { cost: 2, per: 1, unit: "page" },
  // Cross-audit render cache HIT (#193): same price as a fresh render; kept as
  // a distinct ledger feature so hit-rate/COGS stay observable.
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
  // HEAD/GET link checks are folded; WAF-escalated rendered link checks still
  // bill at the `render` rate in the dead-links route (2cr per rendered request).
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
 * Upper-bound credit estimate for a cloud/CLI audit — the "up to N" CAP shown
 * before a run. Pricing v10 makes this near-exact: base + 2cr × pages, where
 * actual spend is base + 2cr × pages actually rendered (≤ maxPages). Opt-in
 * add-ons (keyword/content gaps) are charged and confirmed separately.
 */
export const estimateAuditCap = (input: { maxPages: number; render: boolean }): number => {
  const pages = Math.max(1, Math.floor(input.maxPages));
  const renderCost = input.render ? computeCost("render", pages) : 0;
  return computeCost("audit_base", 1) + renderCost;
};

/**
 * Credit RANGE shown before a run: `min` = HTTP-only floor (the audit base),
 * `max` = full cap. Reuses estimateAuditCap — no new pricing. min === max when
 * render is off.
 */
export const estimateAuditRange = (input: {
  maxPages: number;
  render: boolean;
}): {
  min: number;
  max: number;
} => {
  const max = estimateAuditCap(input);
  const min = input.render ? estimateAuditCap({ maxPages: input.maxPages, render: false }) : max;
  return { min, max };
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
// run id (cloud/container runs + threaded CLI renders). See
// apps/api/src/lib/audit-cost.ts.

/** One feature's charge (and any reversal) for a single audit run. */
export interface AuditCostLine {
  /** Credit feature key (e.g. "audit_base", "render", "render_cached", folded 0-cost services). */
  feature: string;
  /** Units billed — rendered page count for render/render_cached, null for flat/base features. */
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
