import type { PlanDefinition, PlanId } from "./index";

/**
 * #1274 (follow-up to #1020): explicit gate for Team's 5,000-page ladder
 * value actually taking effect. Team's `maxPagesPerAudit` below stays a fixed
 * 5,000 unconditionally — that's the plan's nominal/marketing ceiling, and
 * pricing.tsx always displays it. This flag is a SEPARATE, narrower switch
 * consulted only by the enforcement seam (apps/api's `planMaxPages()`), which
 * uses Pro's 2,000 ceiling for Team instead of the raw 5,000 while this is
 * `false`.
 *
 * Why not just gate on `REPORT_LIMITS.maxPages` rising (#1020's original
 * design)? That constant is shared with unrelated schema/crawl-cap concerns
 * and could rise for a reason that has nothing to do with #1023 — this flag
 * makes the ACTUAL gate condition ("has #1023 stage 1, chunked/streaming
 * publish past the 20MB payload gate, landed?") explicit and greppable
 * instead of an implicit side effect. `planMaxPages()` still applies
 * `Math.min(raw, REPORT_LIMITS.maxPages)` as a hard backstop regardless of
 * this flag, so even a premature flip here can't dispatch a crawl the
 * publish pipeline can't ingest.
 *
 * Flip to `true` in the #1023/#1021 finish-line PR — not before.
 */
export const TEAM_MAX_PAGES_UNLOCKED = false;

// maxWebsites is a HIDDEN abuse cap (100 for every plan) — pricing is purely
// subscription + credits. Never surface website limits in UI or marketing.
export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    // Recurring calendar-month grant, applied by the `credits:free-monthly-grant`
    // scheduler task + instantly at org creation (grantFreeMonthly). NOT
    // Stripe-driven — free orgs have no subscription, so no invoice.paid fires.
    monthlyCredits: 500,
    maxOrgs: 1,
    maxWebsites: 100,
    maxMembers: 1,
    renderConcurrency: 1,
    scheduledCrawls: false,
    customHeaders: false,
    // #1020 ladder: matches Screaming Frog's free-tier crawl cap and today's
    // `full` coverage preset ceiling.
    maxPagesPerAudit: 500,
  },
  starter: {
    id: "starter",
    // Display name only — planId stays "starter" everywhere (DB rows, Stripe
    // metadata, webhooks). Renaming the id would require a prod data migration.
    name: "Pro",
    priceMonthUsd: 19,
    // Annual = 12 months prepaid at the cost of 10. Credits still granted
    // monthly (3000/mo) — the invoice.paid grant covers the first cycle and
    // the `credits:annual-monthly-grant` task refills each later cycle.
    priceYearUsd: 190,
    // Granted on each invoice.paid; existing subscribers pick this up at
    // their next renewal automatically.
    monthlyCredits: 3000,
    maxOrgs: 1,
    maxWebsites: 100,
    // Team invites move to the Team plan (#625). Pro is single-seat now; orgs
    // that already have >1 member are grandfathered (the invite/accept routes
    // only block on `memberCount >= maxMembers`, never remove existing members).
    maxMembers: 1,
    renderConcurrency: 5,
    scheduledCrawls: true,
    customHeaders: true,
    // #1020 ladder: today's cloud REPORT_LIMITS.maxPages ceiling.
    maxPagesPerAudit: 2000,
  },
  team: {
    id: "team",
    name: "Team",
    // Purchasable via per-seat Stripe checkout (#736): checkout uses
    // `quantity = seats` against STRIPE_PRICE_TEAM_SEAT, and the invoice.paid
    // webhook maps that price back to this plan. Seat-based pricing lives in
    // `perSeat` below.
    //
    // monthlyCredits stays 0 here: the recurring grant is pooled as
    // `seats * perSeat.includedCreditsPerSeat`, but that seat-aware grant math
    // ships in Phase 2c (#625). Until then the flat grant reads this 0 — no org
    // is over-credited by a placeholder.
    monthlyCredits: 0,
    maxOrgs: 1,
    maxWebsites: 100,
    // TODO(#625 Phase 2b): replace the open cap with the paid seat count
    // (Stripe subscription quantity). -1 = no fixed cap, so the invite routes
    // treat Team as invite-capable.
    maxMembers: -1,
    renderConcurrency: 10,
    scheduledCrawls: true,
    customHeaders: true,
    // #1020 ladder: exceeds today's REPORT_LIMITS.maxPages (2,000) on purpose —
    // apps/api's planMaxPages() clamps to that cap, so this only takes effect
    // once the report/publish ingest ceiling is raised separately (see the
    // maxPagesPerAudit doc comment on PlanDefinition in index.ts).
    maxPagesPerAudit: 5000,
    perSeat: {
      priceMonthUsd: 29,
      // Annual per-seat = 12 months prepaid at the cost of 10.
      priceYearUsd: 290,
      includedCreditsPerSeat: 3000,
      minSeats: 2,
    },
  },
} as const;

// Accepts a raw string (DB columns are plain text) and falls back to the free
// plan for any unknown id — callers never need to cast or null-check.
export function getPlan(planId: string): PlanDefinition {
  return PLANS[planId as PlanId] ?? PLANS.free;
}

// Tier hierarchy: free < starter < team. Keep in sync with PlanId — a new tier
// must be ranked here (an unranked id resolves to 0 = free, matching getPlan).
const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  team: 2,
};

/**
 * True when `planId` sits at or above `floor` in the tier hierarchy
 * (free < starter < team). Accepts a raw string; an unknown id ranks as free.
 * Use for "at least this tier" entitlement gates (e.g. `planAtLeast(id,
 * "starter")` = "any paid plan") instead of a binary `id !== "free"` so a
 * higher tier inherits every entitlement of the tiers below it.
 */
export function planAtLeast(planId: string, floor: PlanId): boolean {
  return (PLAN_RANK[planId as PlanId] ?? 0) >= PLAN_RANK[floor];
}

/**
 * White-label report branding (#810). Resolved from the owning org's plan and
 * logo: Team plan grants `whiteLabel: true`, which hides squirrelscan branding
 * in rendered reports and shows the org's own logo (or its name as plain text
 * when no logo is set). Omitted / undefined = default squirrelscan-branded
 * output, so every existing render path is unchanged.
 */
export interface ReportBranding {
  whiteLabel: boolean;
  /** Public org logo URL (organizations.avatar_url, #807). */
  orgLogoUrl?: string;
  /** Org display name — the header fallback when no logo is set. */
  orgName?: string;
}
