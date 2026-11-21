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

// #1274's TEAM_MAX_PAGES_UNLOCKED flag is GONE (#1028). It existed to stop an
// unrelated rise in `REPORT_LIMITS.maxPages` from silently unlocking Team's
// ladder step before #1023 stage 1 (chunked/streaming publish past the 20MB
// payload gate) had landed. That work has landed — the API ingests findings as
// streamed NDJSON chunks — and the ceilings below were raised deliberately for
// exactly that reason, so the gate has nothing left to gate. A constant that is
// permanently `true` is not a safety net, it is an extra hop every reader of
// `planMaxPages()` has to follow. `Math.min(raw, REPORT_LIMITS.maxPages)` in
// planMaxPages() remains the single hard backstop: no plan can ever dispatch a
// crawl the report pipeline cannot ingest.

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
    // Most pages one audit renders at once. The hosted runner holds a cloud
    // audit to it (squirrelscan/repo#2480) and the CLI clamps to it. Before
    // #2480 the cloud ignored it: rendered crawls ran at the crawler's default
    // width (5, or 8 under the authorised profile) on every plan. Free held 1 from
    // #2480 and took the crawl stage of a scheduled free audit from about 46 s to
    // 176 s (a page at a time, about 13 s a page); it is 2 now (squirrelscan/repo#3576).
    renderConcurrency: 2,
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
    // Pro and up (squirrelscan/repo#2772): alerts about new broken links are
    // ongoing monitoring, not evaluation.
    brokenLinkAlerts: false,
    // #1020 ladder: matches Screaming Frog's free-tier crawl cap and today's
    // `full` coverage preset ceiling. Held at 500 through #1028's raise: free
    // audits run on the 4 GiB container class, and a 10,000-page audit retains
    // ~4.4 GB — the ceiling is a memory fact here, not a pricing choice.
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
    brokenLinkAlerts: true,
    // #1028 ladder: unchanged at 2,000. Pro is a single-seat plan for ordinary
    // sites; Team is where the raised ceiling is the product.
    maxPagesPerAudit: 2000,
    unlimitedCredits: false,
    selfServe: true,
  },
  /**
   * Flat Team (squirrelscan/repo#5002, decided 2026-11-20): one price for the org, no seat charge,
   * unlimited members, a pooled monthly grant. The per-seat Team it replaced lives on as `team_legacy`
   * for the subscribers who bought it. Trials (`organizations.trial_ends_at`) run on this plan.
   */
  team: {
    id: "team",
    name: "Team",
    priceMonthUsd: 89,
    // 12 months prepaid at the cost of 10.
    priceYearUsd: 890,
    monthlyCredits: 15000,
    maxOrgs: 1,
    maxWebsites: 100,
    // Sold as unlimited; the hidden cap below only stops abuse.
    maxMembers: -1,
    memberAbuseCap: 100,
    renderConcurrency: 10,
    scheduledCrawls: true,
    maxScheduledWebsites: -1,
    scheduleFrequencies: SCHEDULE_FREQUENCIES,
    customHeaders: true,
    brokenLinkAlerts: true,
    // #1028 ladder: Team is where large-site auditing lives. 10,000 is the
    // measured ceiling of the paid standard-4 container class (#1869): a
    // 10,000-page audit retains ~4.4 GB, which fits 8/12 GiB and does not fit
    // free's 4 GiB. Equal to REPORT_LIMITS.maxPages, so nothing clamps it.
    maxPagesPerAudit: 10000,
    unlimitedCredits: false,
    selfServe: true,
  },
  /**
   * The per-seat Team plan as sold before #5002 ($29 a seat, minimum 2, 3,000 credits a seat pooled),
   * kept unchanged for the subscribers on it and for comped orgs moved onto it (#5002 D8). Not
   * self-serve: nobody new can buy it. Its seat prices (STRIPE_PRICE_TEAM_SEAT*) map here. Ranks with
   * `team`, so every "Team and up" entitlement holds, and its limits are Team's.
   */
  team_legacy: {
    id: "team_legacy",
    name: "Team",
    // Purchased via per-seat Stripe checkout (#736): `quantity = seats` against
    // STRIPE_PRICE_TEAM_SEAT; the monthly grant is pooled as
    // `seats * perSeat.includedCreditsPerSeat`, so the flat grant stays 0.
    monthlyCredits: 0,
    maxOrgs: 1,
    maxWebsites: 100,
    // -1 = no fixed cap: every member is a paid seat (Stripe quantity).
    maxMembers: -1,
    renderConcurrency: 10,
    scheduledCrawls: true,
    maxScheduledWebsites: -1,
    scheduleFrequencies: SCHEDULE_FREQUENCIES,
    customHeaders: true,
    brokenLinkAlerts: true,
    maxPagesPerAudit: 10000,
    unlimitedCredits: false,
    selfServe: false,
    perSeat: {
      priceMonthUsd: 29,
      // Annual per-seat = 12 months prepaid at the cost of 10.
      priceYearUsd: 290,
      includedCreditsPerSeat: 3000,
      minSeats: 2,
    },
  },
  /**
   * Business (squirrelscan/repo#5002, decided 2026-11-20): the tier above Team. UNLISTED until it is
   * switched on: `selfServe: false` keeps it off the pricing page, plan pickers, checkout and upsells
   * (D2, D7), and flipping it to true is the launch. Raises Team's limits (D6, D9). Its 25,000-page
   * ceiling is above `REPORT_LIMITS.maxPages` until the cloud runner can carry it, and `planMaxPages()`
   * clamps it meanwhile; raising that ceiling blocks the launch.
   */
  business: {
    id: "business",
    name: "Business",
    priceMonthUsd: 249,
    // 12 months prepaid at the cost of 10.
    priceYearUsd: 2490,
    monthlyCredits: 45000,
    maxOrgs: 1,
    // Hidden abuse cap, like every plan's; Business's is higher (D6).
    maxWebsites: 500,
    maxMembers: -1,
    memberAbuseCap: 100,
    renderConcurrency: 20,
    scheduledCrawls: true,
    maxScheduledWebsites: -1,
    scheduleFrequencies: SCHEDULE_FREQUENCIES,
    customHeaders: true,
    brokenLinkAlerts: true,
    maxPagesPerAudit: 25000,
    unlimitedCredits: false,
    selfServe: false,
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
    // Team's 10 for now, below Business's 20 on purpose: unlike the page ceiling, nothing clamps
    // renders at dispatch, and 20 renders at once on the paid container is unmeasured. Raise it with
    // the runner capacity work that blocks turning Business on (#5002 D9).
    renderConcurrency: 10,
    scheduledCrawls: true,
    maxScheduledWebsites: -1,
    scheduleFrequencies: SCHEDULE_FREQUENCIES,
    customHeaders: true,
    brokenLinkAlerts: true,
    // At least Business's ceiling, never below it (#1028): a contracted plan
    // that audited fewer pages than the tier under it would be a pricing bug.
    // Kept as its own literal rather than a reference so a tier change is a
    // deliberate decision here too; still clamped at dispatch by
    // `REPORT_LIMITS.maxPages` like every other plan.
    maxPagesPerAudit: 25000,
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
export const SELF_SERVE_PLAN_IDS: readonly PlanId[] = (
  Object.keys(PLANS) as PlanId[]
).filter((id) => PLANS[id].selfServe);

// Accepts a raw string (DB columns are plain text) and falls back to the free
// plan for any unknown id — callers never need to cast or null-check.
export function getPlan(planId: string): PlanDefinition {
  return Object.hasOwn(PLANS, planId) ? PLANS[planId as PlanId] : PLANS.free;
}

// Tier hierarchy: free < starter < team = team_legacy < business < enterprise. Keep in sync with
// PlanId: a new tier must be ranked here (an unranked id resolves to 0 = free, matching getPlan).
// team_legacy ranks WITH team (#5002): the per-seat subscriber keeps every Team entitlement.
// Enterprise ranks top so it inherits every `planAtLeast` entitlement.
const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  team: 2,
  team_legacy: 2,
  business: 3,
  enterprise: 4,
};

/**
 * True when `planId` sits at or above `floor` in the tier hierarchy
 * (free < starter < team = team_legacy < business < enterprise). Accepts a raw string; an unknown id ranks as free.
 * Use for "at least this tier" entitlement gates (e.g. `planAtLeast(id,
 * "starter")` = "any paid plan") instead of a binary `id !== "free"` so a
 * higher tier inherits every entitlement of the tiers below it.
 */
export function planAtLeast(planId: string, floor: PlanId): boolean {
  return (PLAN_RANK[planId as PlanId] ?? 0) >= PLAN_RANK[floor];
}

/**
 * What a plan whose scheduling limits we cannot read is treated as. Spelled out
 * rather than pointing at `PLANS.free` so the free tier's marketed limits can
 * change without silently moving what "unknown" means.
 */
const FALLBACK_SCHEDULE_LIMITS: {
  maxScheduledWebsites: number;
  scheduleFrequencies: readonly ScheduledAuditFrequency[];
} = {
  maxScheduledWebsites: 1,
  scheduleFrequencies: ["weekly", "monthly"],
};

/**
 * The scheduling limits of a plan OBJECT, with a conservative stand-in for
 * anything the object does not carry.
 *
 * The single reader of `maxScheduledWebsites` / `scheduleFrequencies`, and the
 * reason both are optional on `PlanDefinition`. A plan does not only come from
 * `PLANS`: it also arrives as `CreditsResponse.plan`, which cloud-client hands
 * back as a plain-JSON cast — additive-safe, NOT subtractive-safe. A CLI built
 * against a core-contracts that has these fields, talking to a server that
 * predates them (or has been rolled back), holds a type promising values that
 * are absent at runtime; reading them directly turns that into
 * `undefined.includes(...)` at the first schedule check.
 *
 * The fallback is the FREE tier's limits, never a permissive one: a plan we
 * cannot fully read must degrade to the least entitlement rather than silently
 * granting daily audits on every site.
 */
export function resolvePlanScheduleLimits(
  plan:
    | Pick<PlanDefinition, "maxScheduledWebsites" | "scheduleFrequencies">
    | null
    | undefined
): {
  maxScheduledWebsites: number;
  scheduleFrequencies: readonly ScheduledAuditFrequency[];
} {
  return {
    maxScheduledWebsites:
      plan?.maxScheduledWebsites ??
      FALLBACK_SCHEDULE_LIMITS.maxScheduledWebsites,
    scheduleFrequencies:
      plan?.scheduleFrequencies ?? FALLBACK_SCHEDULE_LIMITS.scheduleFrequencies,
  };
}

/**
 * How many websites in one org may have an enabled recurring audit schedule.
 * `-1` = uncapped. Accepts a raw string (DB columns are plain text); an unknown
 * id resolves to free, i.e. the TIGHTEST cap — a plan we cannot identify must
 * never buy more recurring spend than the free tier.
 */
export function planMaxScheduledWebsites(planId: string): number {
  return resolvePlanScheduleLimits(getPlan(planId)).maxScheduledWebsites;
}

/** The cadences a plan funds, most frequent first. Never undefined. */
export function planScheduleFrequencies(
  planId: string
): readonly ScheduledAuditFrequency[] {
  return resolvePlanScheduleLimits(getPlan(planId)).scheduleFrequencies;
}

/** True when `count` scheduled websites is at or over the plan's cap. Uncapped (-1) is never full. */
export function scheduledWebsiteCapReached(
  planId: string,
  count: number
): boolean {
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
 *
 * The cadence is the most frequent one the plan ACTUALLY funds, read off the
 * ordered list rather than tested for `daily`: a monthly-only plan is valid
 * under the type, and asking "is daily in there?" would have labelled it
 * "Weekly" — a cadence it does not run.
 */
export function planScheduleSummary(planId: string): string {
  const plan = getPlan(planId);
  const { maxScheduledWebsites: cap, scheduleFrequencies } =
    resolvePlanScheduleLimits(plan);
  const cadence = SCHEDULE_FREQUENCIES.find((f) =>
    scheduleFrequencies.includes(f)
  );
  // No cadence, or no slots, is the same product answer as no capability: this
  // plan does not schedule. Plain words rather than a dash — the cell is public
  // copy sitting beside real values in the same column.
  if (!plan.scheduledCrawls || !cadence || cap === 0) return "Not included";
  const sites = cap < 0 ? "all sites" : `${cap} site${cap === 1 ? "" : "s"}`;
  return `${SCHEDULE_LABEL[cadence]}, ${sites}`;
}

/** Sentence-cased cadence label for the pricing surfaces. */
const SCHEDULE_LABEL: Record<ScheduledAuditFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

export function planAllowsScheduleFrequency(
  planId: string,
  frequency: ScheduledAuditFrequency
): boolean {
  return planScheduleFrequencies(planId).includes(frequency);
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
  requested: ScheduledAuditFrequency
): ScheduledAuditFrequency {
  const allowed = planScheduleFrequencies(planId);
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
 * its white-label settings: Team and Enterprise orgs that turn it on get
 * `whiteLabel: true`, which hides squirrelscan branding in rendered reports
 * and shows the org's own logo (or its name as plain text when no logo is
 * set). Omitted / undefined = default squirrelscan-branded output, so every
 * existing render path is unchanged.
 */
export interface ReportBranding {
  whiteLabel: boolean;
  /** Public logo URL for the report header. */
  orgLogoUrl?: string;
  /** Brand name — the header fallback when no logo is set, and the logo's alt text. */
  orgName?: string;
  /** https URL the header logo or name links to. Anything else is not linked. */
  websiteUrl?: string;
  /** Plain-text footer shown in place of the squirrelscan footer credit. */
  footerText?: string;
  /**
   * Accent colour as lowercase `#rrggbb`. Applied only when it passes
   * `validateBrandColor` (AA text contrast and 3:1 against white); absent or
   * invalid = the default theme. (squirrelscan/repo#3130)
   */
  brandColor?: string;
}
