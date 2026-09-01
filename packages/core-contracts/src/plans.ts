import type { PlanDefinition, PlanId, ScheduledAuditFrequency } from "./index";

/**
 * Every recurring-audit cadence, ordered MOST → LEAST frequent. The order is
 * load-bearing: `clampScheduleFrequency` walks it to find the nearest cadence a
 * plan allows, so a new cadence must be inserted at its true position, not
 * appended.
 */
export const SCHEDULE_FREQUENCIES: readonly ScheduledAuditFrequency[] = [
  "daily",
  "weekly",
  "monthly",
];

/**
 * #1274 (follow-up to #1020): explicit gate for Team's 5,000-page ladder
 * value actually taking effect. Team's `maxPagesPerAudit` below stays a fixed
 * 5,000 unconditionally — that's the plan's nominal/marketing ceiling, and
 * pricing.tsx always displays it. This flag is a SEPARATE, narrower switch
 * consulted only by hosted plan enforcement, which uses Pro's 2,000 ceiling
 * for Team instead of the raw 5,000 while this is
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
    // Recurring grant on the org's signup anniversary, applied by the `credits:free-monthly-grant`
    // scheduler task + instantly at org creation (grantFreeMonthly). NOT
    // Stripe-driven — free orgs have no subscription, so no invoice.paid fires.
    monthlyCredits: 500,
    maxOrgs: 1,
    maxWebsites: 100,
    maxMembers: 1,
    renderConcurrency: 1,
    // #1704: scheduling is no longer the paid line. A weekly audit of one site
    // burns roughly 250-300 of the 500 monthly credits above, so the free grant
    // finally binds while the tier delivers recurring value; Pro's
    // differentiator is daily cadence and more than one scheduled site.
    scheduledCrawls: true,
    maxScheduledWebsites: 1,
    // No `daily`: 4x weekly's spend does not fit the 500-credit grant. A daily
    // request is clamped to weekly, not refused.
    scheduleFrequencies: ["weekly", "monthly"],
    // Free on purpose: custom headers are how you audit a staging site behind
    // auth, which is evaluation, not a paid job.
    customHeaders: true,
    // #1020 ladder: matches Screaming Frog's free-tier crawl cap and today's
    // `full` coverage preset ceiling.
    maxPagesPerAudit: 500,
    unlimitedCredits: false,
    selfServe: true,
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
    // Uncapped scheduling is the paid line since #1704: as many scheduled sites
    // as the org has, at any cadence.
    maxScheduledWebsites: -1,
    scheduleFrequencies: SCHEDULE_FREQUENCIES,
    customHeaders: true,
    // #1020 ladder: today's cloud REPORT_LIMITS.maxPages ceiling.
    maxPagesPerAudit: 2000,
    unlimitedCredits: false,
    selfServe: true,
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
    maxScheduledWebsites: -1,
    scheduleFrequencies: SCHEDULE_FREQUENCIES,
    customHeaders: true,
    // #1020 ladder: exceeds today's REPORT_LIMITS.maxPages (2,000) on purpose —
    // Hosted plan enforcement clamps to that cap, so this only takes effect
    // once the report/publish ingest ceiling is raised separately (see the
    // maxPagesPerAudit doc comment on PlanDefinition in index.ts).
    maxPagesPerAudit: 5000,
    unlimitedCredits: false,
    selfServe: true,
    perSeat: {
      priceMonthUsd: 29,
      // Annual per-seat = 12 months prepaid at the cost of 10.
      priceYearUsd: 290,
      includedCreditsPerSeat: 3000,
      minSeats: 2,
    },
  },
  /**
   * INTERNAL / invite-only (decided 2026-08-28). This is how enterprise billing
   * will work: usage is not metered against a prepaid balance, it is ACCOUNTED
   * in `credit_ledger` and invoiced out of band.
   *
   * Deliberately absent: `priceMonthUsd` / `priceYearUsd` / `perSeat` — there is
   * no price and no Stripe checkout for it. `selfServe: false` keeps it out of
   * every public surface (pricing page, dashboard plan comparison and upgrade
   * funnel, CLI/MCP upsells). The only way into it is an admin moving the org
   * from the admin dashboard; the only way out is an admin moving it back.
   *
   * `monthlyCredits: 0` because there is nothing to grant — `unlimitedCredits`
   * means the balance is never consulted or mutated. The recurring-grant
   * scheduler tasks skip the plan for the same reason.
   */
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    // No recurring grant: unlimitedCredits makes the balance irrelevant, and
    // granting into a frozen balance would corrupt the value the org resumes
    // from if it is ever moved back to a metered plan.
    monthlyCredits: 0,
    maxOrgs: 1,
    // -1 = uncapped (same sentinel Team uses for maxMembers). The 100-website
    // abuse cap is a hosted-tier guard; a contracted org is not that risk.
    maxWebsites: -1,
    maxMembers: -1,
    renderConcurrency: 10,
    scheduledCrawls: true,
    maxScheduledWebsites: -1,
    scheduleFrequencies: SCHEDULE_FREQUENCIES,
    customHeaders: true,
    // NOT subject to TEAM_MAX_PAGES_UNLOCKED — that flag gates Team's ladder
    // step specifically (#1274). Enterprise carries its own allowance, still
    // clamped at dispatch by `REPORT_LIMITS.maxPages` like every other plan.
    maxPagesPerAudit: 5000,
    unlimitedCredits: true,
    selfServe: false,
  },
} as const;

/**
 * The plans a customer can reach on their own. Every public/marketing/upgrade
 * surface must enumerate THIS, never `Object.keys(PLANS)` — otherwise an
 * internal plan leaks into pricing or a plan picker the moment it is added.
 * Ordered low → high tier.
 */
export const SELF_SERVE_PLAN_IDS: readonly PlanId[] = (Object.keys(PLANS) as PlanId[]).filter(
  (id) => PLANS[id].selfServe,
);

// Accepts a raw string (DB columns are plain text) and falls back to the free
// plan for any unknown id — callers never need to cast or null-check.
export function getPlan(planId: string): PlanDefinition {
  return PLANS[planId as PlanId] ?? PLANS.free;
}

// Tier hierarchy: free < starter < team < enterprise. Keep in sync with PlanId —
// a new tier must be ranked here (an unranked id resolves to 0 = free, matching
// getPlan). Enterprise ranks top so it inherits every `planAtLeast` entitlement.
const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  team: 2,
  enterprise: 3,
};

/**
 * True when `planId` sits at or above `floor` in the tier hierarchy
 * (free < starter < team < enterprise). Accepts a raw string; an unknown id ranks as free.
 * Use for "at least this tier" entitlement gates (e.g. `planAtLeast(id,
 * "starter")` = "any paid plan") instead of a binary `id !== "free"` so a
 * higher tier inherits every entitlement of the tiers below it.
 */
export function planAtLeast(planId: string, floor: PlanId): boolean {
  return (PLAN_RANK[planId as PlanId] ?? 0) >= PLAN_RANK[floor];
}

/**
 * How many websites in one org may have an enabled recurring audit schedule.
 * `-1` = uncapped. Accepts a raw string (DB columns are plain text); an unknown
 * id resolves to free, i.e. the TIGHTEST cap — a plan we cannot identify must
 * never buy more recurring spend than the free tier.
 */
export function planMaxScheduledWebsites(planId: string): number {
  return getPlan(planId).maxScheduledWebsites;
}

/** True when `count` scheduled websites is at or over the plan's cap. Uncapped (-1) is never full. */
export function scheduledWebsiteCapReached(planId: string, count: number): boolean {
  const cap = planMaxScheduledWebsites(planId);
  return cap >= 0 && count >= cap;
}

/**
 * What this plan schedules, in one line: "Weekly, 1 site" / "Daily, all sites".
 *
 * Lives HERE, not next to the tables that render it, because there are two of
 * them in two different apps (the marketing pricing grid and the in-dashboard
 * plan comparison). Both derive the cell from the plan's own limits so a change
 * in `PLANS` cannot leave them lying — which only holds while the derivation is
 * one function rather than two copies free to drift from each other.
 */
export function planScheduleSummary(planId: string): string {
  const plan = getPlan(planId);
  if (!plan.scheduledCrawls) return "—";
  const cadence = plan.scheduleFrequencies.includes("daily") ? "Daily" : "Weekly";
  const cap = plan.maxScheduledWebsites;
  const sites = cap < 0 ? "all sites" : `${cap} site${cap === 1 ? "" : "s"}`;
  return `${cadence}, ${sites}`;
}

export function planAllowsScheduleFrequency(
  planId: string,
  frequency: ScheduledAuditFrequency,
): boolean {
  return getPlan(planId).scheduleFrequencies.includes(frequency);
}

/**
 * The cadence this plan will actually run, given what was asked for.
 *
 * Clamp, never reject (the rule `pageLimitClampNotice` already follows for the
 * page ceiling): a free org asking for `daily` gets `weekly` plus a notice, not
 * a 4xx — the request is not malformed, the plan just does not fund it. Walks
 * DOWN the frequency order first so the clamp always lands on the closest
 * cadence the plan allows and can only ever REDUCE spend; the backward walk is
 * an unreachable-today safety net for a plan whose allowed set is not a
 * suffix of {@link SCHEDULE_FREQUENCIES}.
 */
export function clampScheduleFrequency(
  planId: string,
  requested: ScheduledAuditFrequency,
): ScheduledAuditFrequency {
  const allowed = getPlan(planId).scheduleFrequencies;
  if (allowed.includes(requested)) return requested;
  const at = SCHEDULE_FREQUENCIES.indexOf(requested);
  for (let i = at + 1; i < SCHEDULE_FREQUENCIES.length; i++) {
    const candidate = SCHEDULE_FREQUENCIES[i];
    if (candidate && allowed.includes(candidate)) return candidate;
  }
  for (let i = at - 1; i >= 0; i--) {
    const candidate = SCHEDULE_FREQUENCIES[i];
    if (candidate && allowed.includes(candidate)) return candidate;
  }
  // A plan with an empty frequency list schedules nothing; weekly is the
  // product default and the only value that keeps callers total.
  return "weekly";
}

/**
 * True when the plan is not metered against a prepaid credit balance: debits are
 * recorded in the ledger but never rejected and never mutate `credit_balances`.
 * Accepts a raw string (DB columns are plain text); unknown ids are metered.
 */
export function planHasUnlimitedCredits(planId: string): boolean {
  return getPlan(planId).unlimitedCredits;
}

/**
 * True when the customer can reach this plan themselves. Gate every upgrade CTA,
 * plan card and checkout on this rather than on an id denylist.
 */
export function isSelfServePlan(planId: string): boolean {
  return getPlan(planId).selfServe;
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
