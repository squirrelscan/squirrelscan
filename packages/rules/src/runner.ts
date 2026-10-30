import { logger, profileRules } from "./logger";
// Rule runner - executes rules with context

import { PRIVATE_TARGET_SKIP_REASON, RULE_TIMED_OUT_SKIP_REASON } from "@squirrelscan/core-contracts";
import { detectSoft404, parsePage } from "@squirrelscan/parser";
import { stripShadowIdScopes } from "@squirrelscan/parser/dom";
import { mapWithConcurrency } from "@squirrelscan/utils";
import { nonPublicHostLabel } from "@squirrelscan/utils/non-public-host";

import type {
  CheckResult,
  EntityMap,
  IntelContext,
  SiteMetadata,
  SiteQuery,
} from "@squirrelscan/core-contracts";


import type {
  PageData,
  ParsedPage,
  Rule,
  RuleContext,
  RuleMeta,
  RuleRunResult,
  SiteData,
} from "./types";

import type { CloudResultStore } from "./cloud";
import type { CollectedSiteSignals } from "./collected-signals";
import type { EndpointSurface } from "./endpoint-surface";
import type { ProbeBudget } from "./probe-budget";
import type { TlsProbeFn } from "@squirrelscan/utils/tls-certificate";
import { ruleApplies } from "./applicability";
import { filterRules } from "./filter";
import { loadAllRules, type RuleNamespace } from "./loader";
import { describeRuleOptionIssues } from "./rule-options-check";
import {
  RULE_TIME_BUDGET_MS,
  RuleTimeoutError,
  runWithinBudget,
  SITE_RULE_BUDGET_CAP_MS,
  siteRuleBudgetMs,
} from "./rule-budget";
import { noindexSource, skipsNoindexPages } from "./shared/noindex";
import { pageTypeRuleSkip, skippablePageType } from "./shared/page-type";

// Minimal config interface — CLI's full Config satisfies this
export interface RulesConfig {
  rule_options: Record<string, Record<string, unknown>>;
  rules?: {
    enable?: string[];
    disable?: string[];
    categories?: string[];
    // Escape hatch: force every enabled rule to run regardless of the Stage-0
    // site-metadata profile (guards against misclassification suppressing real
    // issues). Default false — `appliesWhen` gating engages normally.
    ignore_applicability?: boolean;
    // `[rules] time_budget_ms` (#578): the per-page rule time budget, overriding
    // RULE_TIME_BUDGET_MS. `0` turns it off. `RunnerOptions.ruleTimeBudgetMs`
    // wins over it.
    time_budget_ms?: number;
  };
}

/**
 * Per-audit-run state threaded into the runner. Replaces the former process-
 * global `setSiteMetadata`/`setCloudResults` singletons so concurrent
 * audits in one isolate cannot corrupt each other's gating or cloud reads.
 * Both fields are optional — omit them to run exactly as an offline / free /
 * no-cloud audit does today (no gating, all cloud lookups miss).
 */
export interface RunnerScope {
  /**
   * Resolved Stage-0 site profile for THIS run. Drives `appliesWhen` gating and
   * is threaded into each applicable rule's `ctx.siteMetadata`. Undefined = no
   * gating (run as today).
   */
  siteMetadata?: SiteMetadata;
  /**
   * Prefetched cloud-service results for THIS run (service → key → envelope),
   * threaded into `ctx.cloudResults`. Undefined = nothing prefetched; cloud
   * rules emit `skipped` + `not-prefetched`.
   */
  cloudResults?: CloudResultStore;
  /**
   * Threat-intel handle for THIS run (#117) — feeds/lookups/signatures resolved
   * before rules run, threaded into `ctx.intel`. Undefined = intel off / not
   * opted-in; the integrity intel rules contribute nothing.
   */
  intel?: IntelContext;
  /**
   * The site's entity map for THIS run (#2091), threaded into `ctx.entityMap`.
   * Scope rather than a `runSiteRules` argument, deliberately: like `intel` it
   * is resolved before the runner exists, and unlike `siteQuery` it is a
   * finished immutable document rather than a handle onto live storage.
   * Undefined = not built; the `schema/entity-*` rules skip.
   */
  entityMap?: EntityMap;
  /**
   * The shared probing budget for THIS run, threaded into `ctx.probe` on every
   * page and site rule (the same object, so the cap is shared). Undefined =
   * passive: probing rules send nothing.
   */
  probe?: ProbeBudget;
  /**
   * The TLS handshake for THIS run, threaded into `ctx.tlsProbe` on site rules.
   * Only the CLI injects one (it vets and pins every address). Undefined =
   * `security/tls-certificate` reports "not checked".
   */
  tlsProbe?: TlsProbeFn;
}

export interface RunnerOptions extends RunnerScope {
  config: RulesConfig;
  /** Extra rule namespaces (plugins / tests) merged on top of the built-ins. */
  additionalNamespaces?: RuleNamespace[];
  /**
   * Max rules to run concurrently within a single page/site pass. Rules are
   * independent (each reads shared, immutable context and produces its own
   * checks), so overlapping them lets I/O-bound rules (broken-link probes,
   * HTTP→HTTPS probes, LLM calls) wait in parallel. Results are always
   * assembled in deterministic rule order regardless of completion order, so
   * output is byte-identical to sequential execution. Default 8. Set to 1 to
   * force fully sequential execution.
   */
  ruleConcurrency?: number;
  /**
   * Wall-clock budget (ms) for one page-rule evaluation on one page; site rules
   * get this much per page of the site. A rule that runs past it is abandoned
   * and recorded as a rule error. Defaults to {@link RULE_TIME_BUDGET_MS};
   * `0` turns the budget off.
   */
  ruleTimeBudgetMs?: number;
  /**
   * Ceiling (ms) on one site-rule evaluation, whatever the page count. Defaults to
   * `SITE_RULE_BUDGET_CAP_MS`.
   */
  siteRuleBudgetCapMs?: number;
}

const DEFAULT_RULE_CONCURRENCY = 8;

/** Site rules that report the absence of a root resource, beyond the discovery-probe readers. */
const ROOT_RESOURCE_RULES: ReadonlySet<string> = new Set(["crawl/sitemap-exists"]);

/** Whether a rule's findings are about root resources (a discovery probe or the sitemap). */
function judgesRootResource(rule: Rule): boolean {
  return (rule.meta.discoveryProbes?.length ?? 0) > 0 || ROOT_RESOURCE_RULES.has(rule.meta.id);
}

/**
 * Whether the crawl never saw the site answer: it fetched no page AND a root
 * request recorded a refusal or a failed fetch. Zero pages alone is not enough:
 * a start URL excluded by config or robots.txt, or a `maxPages` of 0, also
 * yields zero pages while the root files answered normally, and a missing
 * sitemap is a real finding there. Reads `crawlLimits`, which both engine paths
 * set; undefined (a caller that never threaded it) reads as "pages were
 * fetched", so nothing is skipped without evidence.
 */
function fetchedNoPages(site: SiteData | undefined): boolean {
  const limits = site?.crawlLimits;
  if (!site || !limits || limits.pagesCrawled !== 0 || limits.maxPages <= 0) return false;
  const robots = site.robotsTxt;
  const failedFetch = robots !== null && robots !== undefined && !robots.exists && robots.errors.length > 0;
  return (site.refusedFetches?.length ?? 0) > 0 || failedFetch;
}

export interface PageRunResult {
  checks: CheckResult[];
  parsed: ParsedPage;
  ruleResults: Map<string, RuleRunResult>;
}

/** Per-page options for {@link RuleRunner.runPageRules}. */
export interface PageRuleRunOptions {
  /**
   * Template fan-out (#1951): `ruleId -> checks` for rules that must NOT run on
   * this page because a page sharing its template cluster already produced the
   * verdict. Only rules for which {@link mayFanOutAcrossTemplate} holds may
   * appear here, and it is the CALLER that owns the cluster identity — the runner
   * has no view of the crawl and simply trusts the map.
   *
   * The contract on the values:
   *
   *  - they are the sibling's checks CLONED, so stamping `pageUrl` on them cannot
   *    reach back into another page's result (see `template-fanout.ts`);
   *  - they carry no `pageUrl`, so the caller's ordinary stamping applies;
   *  - they contain nothing derived from the sibling's URL, which is the property
   *    `template-verdict-page-independence.test.ts` asserts for every declaring
   *    rule by running it under two urls that share only scheme and host.
   *
   * A rule id absent from the map runs normally, so an empty or omitted map is
   * exactly today's behaviour.
   */
  fannedRuleChecks?: ReadonlyMap<string, CheckResult[]>;
}

export interface SiteRunResult {
  checks: CheckResult[];
  ruleResults: Map<string, RuleRunResult>;
}
// Get rule options from config, with defaults from rule schema
function getRuleOptions(rule: Rule, config: RulesConfig): Record<string, unknown> {
  const ruleConfig = config.rule_options[rule.meta.id] ?? {};

  // If rule has options schema, parse with defaults. A value of the wrong type
  // names the table and the option (pub#510), not a bare zod issue list.
  if (rule.meta.optionsSchema) {
    const parsed = rule.meta.optionsSchema.safeParse(ruleConfig);
    if (!parsed.success) {
      throw new Error(describeRuleOptionIssues(rule.meta.id, parsed.error.issues).join("; "));
    }
    return parsed.data;
  }

  return ruleConfig;
}

/**
 * Applicability gate consulted before running each rule. Returns a single
 * VISIBLE `skipped` check when the rule declares `appliesWhen` and the resolved
 * Stage-0 metadata excludes it (unless the `ignore_applicability` escape hatch is
 * set). Returns `null` when the rule should run normally. The skipped check is
 * persisted (not silently dropped) so reports explain why a rule didn't run.
 *
 * `meta` is the per-run metadata — the SAME value used to build
 * `ctx.siteMetadata` — so gating and injection can never disagree.
 */
function checkApplicability(
  rule: Rule,
  config: RulesConfig,
  meta: SiteMetadata | undefined
): CheckResult | null {
  if (config.rules?.ignore_applicability) return null;
  const verdict = ruleApplies(rule.meta.appliesWhen, meta);
  if (verdict.applies) return null;
  return {
    name: rule.meta.id,
    status: "skipped",
    message: `Not applicable: ${verdict.reason}`,
    skipReason: verdict.reason,
  };
}

/**
 * The visible skip a `skipOnPrivateTarget` rule emits on a local or
 * private-network target (pub#629). Constant text, no host: the report says
 * which host once, not once per rule and page.
 */
function privateTargetSkip(ruleId: string): CheckResult {
  return {
    name: ruleId,
    status: "skipped",
    message: "Not applicable: local or private-network host",
    skipReason: PRIVATE_TARGET_SKIP_REASON,
    // Folds apart from any other skip of the same rule, like the noindex gate.
    details: { foldKey: PRIVATE_TARGET_SKIP_REASON },
  };
}

export class RuleRunner {
  private rules: Map<string, Rule>;
  private enabledRuleIds: string[];
  private config: RulesConfig;
  // Only affects site rules — page rules are sync CPU and run sequentially (#379)
  private ruleConcurrency: number;
  /** The per-page rule time budget this run uses, in ms; `0` means off. */
  readonly ruleTimeBudgetMs: number;
  private readonly siteRuleBudgetCapMs: number;
  // Safe only because page rules run sequentially (see the note on `ruleConcurrency`):
  // the check-then-set on this map and the in-place `details.pages++` here and in
  // `collectedTimeoutChecks` assume no two page rules interleave. Parallelising page
  // rules would need an atomic per-rule counter instead.
  // Page rules that have already timed out in this run, with the live `details`
  // of the first skipped check that reported it. A timed-out page is not
  // evaluated (pub#960), never a finding: every page gets a skipped check, and the
  // count of pages lives on the first one and in the `-timeouts` info row.
  //
  // This is per-AUDIT state on the runner: a runner must serve one audit, or
  // `resetAudit()` must be called between audits (`runSiteRules`, the last step of
  // an audit, also clears it). Otherwise a second audit's first timeout of the
  // same rule would be counted onto the first audit's check.
  // The in-place `details.pages` on the first check is best effort: a sink may
  // have serialized it already, so the final count is also emitted by
  // `runSiteRules` as one `<rule>-timeouts` summary check.
  private readonly timedOutPageRules = new Map<
    string,
    {
      details: { pages: number };
      meta: Rule["meta"];
      name: string;
      category: string;
      budgetMs: number;
      maxElapsedMs?: number;
    }
  >();
  // Page rules that THREW in this run (#1291), the same shape as a timeout: every
  // page gets a skipped `<rule>-error` (not evaluated, never a finding: the defect
  // is squirrel's, and one rule throwing on every page must not read as N failures
  // or lower the score), the count lives on the first one and in one `<rule>-errors`
  // info row. Per-AUDIT state like `timedOutPageRules`, cleared with it.
  private readonly erroredPageRules = new Map<
    string,
    { pages: number; meta: Rule["meta"]; name: string; category: string; error: string; site: boolean }
  >();
  // Per-run state — captured once at construction, immutable for the
  // lifetime of this runner instance. Each audit gets its own RuleRunner, so
  // concurrent audits never share these.
  private readonly siteMetadata: SiteMetadata | undefined;
  private readonly cloudResults: CloudResultStore | undefined;
  private readonly intel: IntelContext | undefined;
  private readonly entityMap: EntityMap | undefined;
  private readonly probe: ProbeBudget | undefined;
  private readonly tlsProbe: TlsProbeFn | undefined;
  // The audited url last classified by `isPrivateTarget`, and the verdict. One
  // audit has one base url, so this is a single classification per run; keyed on
  // the url so a runner reused for another site cannot carry a stale verdict.
  private privateTarget: { url: string; isPrivate: boolean } | undefined;

  constructor(options: RunnerOptions) {
    this.config = options.config;
    this.siteMetadata = options.siteMetadata;
    this.cloudResults = options.cloudResults;
    this.intel = options.intel;
    this.entityMap = options.entityMap;
    this.probe = options.probe;
    this.tlsProbe = options.tlsProbe;
    this.ruleConcurrency = Math.max(
      1,
      options.ruleConcurrency ?? DEFAULT_RULE_CONCURRENCY
    );
    this.ruleTimeBudgetMs =
      options.ruleTimeBudgetMs ??
      options.config.rules?.time_budget_ms ??
      RULE_TIME_BUDGET_MS;
    this.siteRuleBudgetCapMs = options.siteRuleBudgetCapMs ?? SITE_RULE_BUDGET_CAP_MS;

    // Load all rules (plus any caller-supplied namespaces — plugins / tests)
    this.rules = loadAllRules({
      additionalNamespaces: options.additionalNamespaces,
      includeOptIn: true,
    });

    // Filter to enabled rules based on config
    const allIds = Array.from(this.rules.keys());
    this.enabledRuleIds = filterRules(
      allIds,
      this.config.rules?.enable,
      this.config.rules?.disable,
      this.config.rule_options as Record<string, { enabled?: boolean }>,
      this.rules
    );
  }

  /**
   * Whether this audit's target is a local or private-network host (pub#629),
   * decided from the audit URL (`site.baseUrl`) by the same classifier the CLI's
   * cloud preflight uses. A page rule run without site data falls back to the
   * page's own url, which is on the audited host.
   */
  private isPrivateTarget(ctx: RuleContext): boolean {
    const url = ctx.site?.baseUrl || ctx.page.url;
    if (this.privateTarget?.url !== url) {
      this.privateTarget = { url, isPrivate: nonPublicHostLabel(url) !== null };
    }
    return this.privateTarget.isPrivate;
  }

  // Get list of enabled rules
  getEnabledRules(): Rule[] {
    return this.enabledRuleIds.map((id) => this.rules.get(id)!);
  }

  /**
   * The enabled PAGE rules in execution order, each with the options it will
   * actually run with (squirrelscan/repo#1990).
   *
   * This is what a per-page rule-result cache keys on, so it must be the resolved
   * options and not the raw config: a rule's Zod defaults are part of its verdict,
   * and a rules-package upgrade that changes a default has to invalidate cached
   * results even when nobody edited squirrel.toml. Returned as an ARRAY because
   * order is part of the identity — reordering the rule set reorders the flat
   * per-page check list, which the report renders.
   */
  pageRuleSignature(): Array<{ id: string; options: Record<string, unknown> }> {
    return this.getEnabledRules()
      .filter((rule) => rule.meta.scope === "page")
      .map((rule) => ({ id: rule.meta.id, options: getRuleOptions(rule, this.config) }));
  }

  /** `meta` for an enabled rule, or undefined. Lets a cached result be re-assembled
   *  into a {@link RuleRunResult} with the LIVE meta rather than a stored copy. */
  getRuleMeta(ruleId: string): RuleMeta | undefined {
    return this.rules.get(ruleId)?.meta;
  }

  /**
   * Run a single rule and return its result. Applies the Stage-0 applicability
   * gate first (emitting a visible `skipped` check) and converts thrown errors
   * into a `fail` check, matching prior sequential behaviour. Pure with respect
   * to shared state — only reads the immutable `ctx` inputs.
   *
   * Returns synchronously when `run()` is sync (nearly all rules) and a Promise
   * only for the few async rules, so the common path pays no microtask overhead
   * (#521). Callers must handle either shape.
   *
   * `fanned` substitutes a template sibling's checks for `run()` (#1951). It is
   * consulted AFTER the gates, because they are decided per PAGE and a
   * representative's verdict says nothing about them: applicability happens to be
   * run-constant, but the soft-404 and noindex gates are not, so a member that
   * serves 404 content or is noindex must take its own skip rather than a
   * sibling's real verdict.
   *
   * `budgetMs` bounds the synchronous part of `run()` (see rule-budget.ts). A rule
   * that runs past it is abandoned and recorded as a `<id>-error` SKIPPED check
   * (`rule-timed-out`: not evaluated, never a finding), so the rest of the audit
   * carries on. A thrown error is the same skipped `<id>-error` (`details.errored`, #1291).
   */
  private runOneRule(
    rule: Rule,
    ctx: RuleContext,
    siteMetadata: SiteMetadata | undefined,
    budgetMs: number,
    scopeForLog?: "site",
    fanned?: CheckResult[]
  ): RuleRunResult | Promise<RuleRunResult> {
    // Run-time applicability gate — emit a visible `skipped` check and skip
    // `run()` when the Stage-0 metadata excludes this rule.
    const skip = checkApplicability(rule, this.config, siteMetadata);
    if (skip) {
      return { meta: rule.meta, checks: [skip] };
    }

    // Private-target gate (pub#629): transport and delivery rules judge the
    // production edge, and a dev server or a box on the local network is not it.
    // Plain HTTP, HTTP/1.1, no caching or compression are the norm there, so the
    // rules are skipped rather than failed, which also keeps one cause (no
    // HTTPS, no compression, no caching policy) from costing the score several
    // times. Decided by the audit URL, so it is constant for the whole run.
    if (rule.meta.skipOnPrivateTarget && this.isPrivateTarget(ctx)) {
      return { meta: rule.meta, checks: [privateTargetSkip(rule.meta.id)] };
    }

    // Soft-404 gate: skip page content/mechanism rules on a URL that serves 404
    // content with a 2xx status, so one broken error template can't spray
    // per-page legal/quality warnings. Scoped to page rules — a site rule sees
    // the first page's parsed state, which must not gate a whole-site check.
    if (rule.meta.scope === "page" && rule.meta.skipOnSoft404 && ctx.parsed?.isSoft404) {
      return {
        meta: rule.meta,
        checks: [
          {
            name: rule.meta.id,
            status: "skipped",
            message: "Skipped: page serves 404 content with HTTP 200 (soft 404)",
            skipReason: "soft-404",
          },
        ],
      };
    }

    // Noindex gate (pub#457): skip search-presentation rules on a page its owner
    // keeps out of the index, on a site known to be indexed (not a staging or
    // preview host, where these rules are the point). Decided per page like the
    // soft-404 gate, so it also comes before a fanned verdict.
    if (rule.meta.scope === "page" && rule.meta.skipOnNoindex && skipsNoindexPages(ctx.site)) {
      const source = noindexSource(ctx.parsed, ctx.page.headers);
      if (source) {
        return {
          meta: rule.meta,
          checks: [
            {
              name: rule.meta.id,
              status: "skipped",
              message: `Skipped: page is set to noindex via ${source}`,
              skipReason: "noindex",
              // Folds apart from any other skip of the same rule, so a folded
              // aggregate is all-noindex: the resolution signal relies on it.
              details: { foldKey: "noindex" },
            },
          ],
        };
      }
    }

    // Page-type gate (pub#841): a contact or legal page is short on purpose, so the rules that
    // judge length or density skip it. Model labels at or above the trust bar only.
    if (rule.meta.scope === "page" && rule.meta.skipOnPageType?.length) {
      const label = skippablePageType(ctx.parsed, rule.meta.skipOnPageType);
      if (label !== null) {
        return {
          meta: rule.meta,
          checks: [pageTypeRuleSkip(rule.meta.id, label, rule.meta.name)],
        };
      }
    }

    // No-observation gate: a rule that judges a root resource (a discovery
    // probe, the sitemap) reports an absence when it finds nothing, but a crawl
    // that fetched no page of the site never saw the site answer at all: it is
    // down or walled, and a 500 or a challenge on /sitemap.xml says nothing
    // about whether a sitemap exists. Skipped, never a finding.
    if (rule.meta.scope === "site" && judgesRootResource(rule) && fetchedNoPages(ctx.site)) {
      return {
        meta: rule.meta,
        checks: [
          {
            name: rule.meta.id,
            status: "skipped",
            message: "Skipped: no page of the site was fetched, so its root files were not judged",
            skipReason: "no-pages-fetched",
          },
        ],
      };
    }

    // #1951: this rule already ran on a page sharing this one's template cluster
    // and declared its verdict a property of the template, so the sibling's checks
    // ARE this page's checks. Handed in pre-cloned and free of `pageUrl`, so the
    // caller stamps this page's url onto them exactly as it does a real run's.
    if (fanned) {
      return { meta: rule.meta, checks: fanned };
    }

    const ruleStart = profileRules ? performance.now() : 0;
    let ruleError: unknown = null;
    let ruleCheckCount = 0;

    // Build the result + emit the per-rule profile line. Shared by both paths so
    // output and logging are identical regardless of run() being sync or async.
    const finalize = (ruleChecks: CheckResult[]): RuleRunResult => {
      ruleCheckCount = ruleChecks.length;
      // Ids inside a declarative shadow root carry an internal scope suffix (#922); findings name the source's.
      stripShadowIdScopes(ruleChecks, ctx.parsed?.document);
      // pub#274: the logger drops this line unless SQUIRREL_RULE_PROFILE is set,
      // but its arguments (three filters and the payload) would still be built
      // on every rule invocation, so build them only when profiling.
      if (!profileRules) return { meta: rule.meta, checks: ruleChecks };
      const passed = ruleChecks.filter((c) => c.status === "pass").length;
      const failed = ruleChecks.filter((c) => c.status === "fail").length;
      const warned = ruleChecks.filter((c) => c.status === "warn").length;
      const elapsedMs = performance.now() - ruleStart;
      logger.debug("rule", {
        ruleId: rule.meta.id,
        ...(scopeForLog ? { scope: scopeForLog } : { pageUrl: ctx.page.url }),
        checks: ruleChecks.length,
        passed,
        failed,
        warned,
        durationMs: Math.round(elapsedMs),
        // Whole-ms rounding above sums to nonsense across hundreds of pages
        // (a sub-ms rule sums to zero, a 1.4 ms rule sums 40% high), so the
        // profiler also emits unrounded microseconds. Keep both: `durationMs`
        // is what the older bench scripts read.
        durationUs: Math.round(elapsedMs * 1000),
      });
      return { meta: rule.meta, checks: ruleChecks };
    };

    const errorChecks = (e: unknown): CheckResult[] => {
      ruleError = e;
      if (e instanceof RuleTimeoutError) {
        logger.warn("rule timed out", {
          ruleId: rule.meta.id,
          ...(scopeForLog ? { scope: scopeForLog } : { pageUrl: ctx.page.url }),
          budgetMs: e.budgetMs,
          elapsedMs: e.elapsedMs,
        });
        // Not evaluated, never a finding (pub#960): the rule did not finish, so it
        // found nothing there, and a skipped check is excluded from the score and
        // the tallies and is not evidence for resolving a carried finding. Every
        // page gets the same status, the first one included.
        const name = `${rule.meta.id}-error`;
        // `elapsedMs` is diagnostic only (pub#960): nothing scores or tallies it.
        const timeoutDetails = {
          timedOut: true,
          ruleId: rule.meta.id,
          budgetMs: e.budgetMs,
          ...(e.elapsedMs !== undefined ? { elapsedMs: e.elapsedMs } : {}),
        };
        const earlier = scopeForLog ? undefined : this.timedOutPageRules.get(rule.meta.id);
        if (earlier) {
          earlier.details.pages++;
          earlier.maxElapsedMs = Math.max(earlier.maxElapsedMs ?? 0, e.elapsedMs ?? 0) || undefined;
          return [
            {
              name,
              status: "skipped",
              message: `Rule not evaluated: ${e.message} (already reported for this audit)`,
              skipReason: RULE_TIMED_OUT_SKIP_REASON,
              details: { ...timeoutDetails, pages: earlier.details.pages },
            },
          ];
        }
        // `pages` is updated in place as later pages time out too.
        const details = { ...timeoutDetails, pages: 1 };
        if (!scopeForLog) {
          this.timedOutPageRules.set(rule.meta.id, {
            details,
            meta: rule.meta,
            name: rule.meta.name,
            category: rule.meta.category,
            budgetMs: e.budgetMs,
            maxElapsedMs: e.elapsedMs,
          });
        }
        return [
          {
            name,
            status: "skipped",
            message: `Rule not evaluated: ${e.message}`,
            skipReason: RULE_TIMED_OUT_SKIP_REASON,
            details,
          },
        ];
      }
      // A thrown rule is not evaluated either (#1291): a skipped `<rule>-error`
      // with the timeout's skip reason (every consumer already treats it as a gap
      // that carries, never resolves) and `details.errored`, so no consumer reads it
      // as a page failure. The message is clipped: it can quote page content.
      const error = e instanceof Error ? e.message : String(e);
      const clipped = error.length > MAX_RULE_ERROR_CHARS ? `${error.slice(0, MAX_RULE_ERROR_CHARS)}...` : error;
      const name = `${rule.meta.id}-error`;
      // Every row of the rule carries the FIRST error and the same details, so the per-page
      // rows are identical but for their page and the report folds them into one check that
      // lists the pages; the count and the error live on the one `<rule>-errors` row.
      let entry = this.erroredPageRules.get(rule.meta.id);
      if (!entry) {
        entry = { pages: 0, meta: rule.meta, name: rule.meta.name, category: rule.meta.category, error: clipped, site: !!scopeForLog };
        this.erroredPageRules.set(rule.meta.id, entry);
      }
      entry.pages += 1;
      return [
        {
          name,
          status: "skipped",
          message: `Rule error: ${entry.error} (rule not evaluated${scopeForLog ? "" : " on this page"})`,
          skipReason: RULE_TIMED_OUT_SKIP_REASON,
          details: { errored: true, ruleId: rule.meta.id, error: entry.error },
        },
      ];
    };

    // Sync fast-path: only the async rules return a Promise; await just those.
    // withTrace is sync, so the span itself adds no scheduling overhead (#521).
    return logger.withTrace(
      `rule:${rule.meta.id}`,
      () => {
        let outcome: ReturnType<Rule["run"]>;
        try {
          outcome = runWithinBudget(() => rule.run(ctx), budgetMs);
        } catch (e) {
          return finalize(errorChecks(e));
        }
        if (outcome instanceof Promise) {
          return outcome.then(
            (result) => finalize(result.checks),
            (e) => finalize(errorChecks(e))
          );
        }
        return finalize(outcome.checks);
      },
      () => (ruleError ? { error: true } : { checks: ruleCheckCount })
    );
  }

  // Run page-scope rules on a single page
  // Optional siteData allows page rules to access site-level data (scripts, resourceSizes, etc.)
  async runPageRules(
    page: PageData,
    siteData?: SiteData,
    opts?: PageRuleRunOptions
  ): Promise<PageRunResult> {
    return logger.withTraceAsync(
      "runPageRules:page",
      async () => {
        // Use pre-parsed data if available (Phase 3: read from storage)
        const parsed =
          page.parsed ??
          logger.withTrace(
            "parsePage",
            () => parsePage(page.html, page.url),
            () => ({ url: page.url, htmlLen: page.html.length })
          );

        // Soft-404 signal (cheap, no extra fetch): a 2xx page serving 404/error
        // content. Computed here where both the status code (page) and parsed
        // fields are available, so it is never persisted stale and both CLI and
        // cloud paths get it. Read by `crawl/soft-404` and `skipOnSoft404` gating.
        const soft404 = detectSoft404({
          statusCode: page.statusCode,
          document: parsed.document,
          errorShell: parsed.errorShell,
          title: parsed.meta?.title,
          h1Texts: parsed.h1?.texts,
          robotsMeta: parsed.meta?.robots,
          wordCount: parsed.content?.wordCount,
        });
        parsed.isSoft404 = soft404.isSoft404;
        parsed.soft404Signals = soft404.signals;

        // Filter to page-scope rules only
        const pageRules = this.getEnabledRules().filter(
          (r) => r.meta.scope === "page"
        );

        // Per-run Stage-0 metadata + cloud store + intel (captured at
        // construction) so gating and ctx.siteMetadata can never disagree and
        // concurrent audits never share state.
        const siteMetadata = this.siteMetadata;
        const cloudResults = this.cloudResults;
        const intel = this.intel;
        const probe = this.probe;

        // Sequential + sync fast-path: only the few async page rules pay a
        // microtask; sync rules run straight through, no Promise overhead (#521).
        const ruleResults = new Map<string, RuleRunResult>();
        const allChecks: CheckResult[] = [];
        const fannedChecks = opts?.fannedRuleChecks;
        for (const rule of pageRules) {
          const ctx: RuleContext = {
            page,
            parsed,
            site: siteData, // Pass site data for rules that need scripts/resourceSizes
            siteMetadata,
            cloudResults,
            intel,
            probe,
            options: getRuleOptions(rule, this.config),
          };
          // The substitution happens INSIDE this loop rather than by splicing
          // afterwards, so a fanned rule occupies exactly the position a real run
          // would: `allChecks` stays in enabled-rule order and `ruleResults` keeps
          // its insertion order, which is what makes the output byte-identical.
          const out = this.runOneRule(
            rule,
            ctx,
            siteMetadata,
            this.ruleTimeBudgetMs,
            undefined,
            fannedChecks?.get(rule.meta.id)
          );
          const result = out instanceof Promise ? await out : out;
          ruleResults.set(rule.meta.id, result);
          allChecks.push(...result.checks);
        }

        return { checks: allChecks, parsed, ruleResults };
      },
      () => ({ url: page.url })
    );
  }

  // Run site-scope rules after all pages are collected. `siteQuery` is the
  // optional streaming-engine aggregate view (#1022): when supplied it is
  // threaded onto every site rule's `ctx.siteQuery` so the rule can read bounded
  // rollups instead of `siteData.pages`. Omit it (or pass undefined) and every
  // rule falls through to its legacy `site.pages` path — byte-identical to today.
  async runSiteRules(
    siteData: SiteData,
    siteQuery?: SiteQuery,
    collectedSignals?: CollectedSiteSignals,
    endpointSurface?: EndpointSurface
  ): Promise<SiteRunResult> {
    return logger.withTraceAsync(
      "runSiteRules:exec",
      async () => {
        // Filter to site-scope rules only
        const siteRules = this.getEnabledRules().filter(
          (r) => r.meta.scope === "site"
        );

        // Per-run Stage-0 metadata + cloud store + intel (see runPageRules).
        const siteMetadata = this.siteMetadata;
        const cloudResults = this.cloudResults;
        const intel = this.intel;
        const entityMap = this.entityMap;
        const probe = this.probe;
        const tlsProbe = this.tlsProbe;

        // For site-scope rules, we need to provide page context: use the first
        // page or a dummy if no pages. Built once and shared (read-only).
        const firstPage = siteData.pages[0];
        const sitePage = firstPage
          ? {
              url: firstPage.url,
              html: "",
              statusCode: 200,
              loadTime: 0,
              headers: {},
            }
          : {
              url: siteData.baseUrl,
              html: "",
              statusCode: 200,
              loadTime: 0,
              headers: {},
            };
        const siteParsed = firstPage?.parsed ?? ({} as ParsedPage);

        // Site rules' work grows with the site, so their budget does too. The
        // streaming path carries no `siteData.pages`; its page count is on the
        // query handle.
        const budgetMs = siteRuleBudgetMs(
          this.ruleTimeBudgetMs,
          Math.max(siteData.pages.length, siteQuery?.pageCount() ?? 0),
          this.siteRuleBudgetCapMs
        );

        // Run rules with bounded concurrency; assemble in deterministic order.
        // runOneRule may return sync; Promise.resolve normalizes for the pool.
        const results = await mapWithConcurrency(
          siteRules.map((rule) => () => {
            const ctx: RuleContext = {
              page: sitePage,
              parsed: siteParsed,
              site: siteData,
              siteQuery,
              collectedSignals,
              endpointSurface,
              siteMetadata,
              cloudResults,
              intel,
              entityMap,
              probe,
              tlsProbe,
              options: getRuleOptions(rule, this.config),
            };
            return Promise.resolve(
              this.runOneRule(rule, ctx, siteMetadata, budgetMs, "site")
            );
          }),
          this.ruleConcurrency
        );

        // A site rule's page-time extractor that timed out on a page (streaming
        // path, collected-signals.ts) is recorded against that rule and page here,
        // the same shape as a timeout in the runner itself.
        const collectedTimeouts = collectedTimeoutChecks(collectedSignals);

        const allChecks: CheckResult[] = [];
        const ruleResults = new Map<string, RuleRunResult>();
        for (let i = 0; i < siteRules.length; i++) {
          let result = results[i];
          const timeouts = collectedTimeouts.get(siteRules[i].meta.id);
          // Not onto a rule that was gated off: it did not run, whatever the collector did.
          // A rule's own timeout is a skip too, and says nothing about the rule being
          // gated off, so it does not count as one here.
          const gatedOff = result.checks.every(
            (c) => c.status === "skipped" && c.skipReason !== RULE_TIMED_OUT_SKIP_REASON
          );
          if (timeouts && !gatedOff) {
            const meta = siteRules[i].meta;
            const budgetMs = (timeouts[0]?.details as { budgetMs?: number } | undefined)?.budgetMs ?? 0;
            result = {
              ...result,
              checks: [
                ...result.checks,
                ...timeouts,
                timeoutSummaryCheck(
                  meta.id,
                  meta.name,
                  meta.category,
                  budgetMs,
                  timeouts.length,
                  Math.max(0, ...timeouts.map((c) => (c.details as { elapsedMs?: number } | undefined)?.elapsedMs ?? 0))
                ),
              ],
            };
          }
          ruleResults.set(siteRules[i].meta.id, result);
          allChecks.push(...result.checks);
        }

        // One summary per page rule that timed out in this audit, carrying the
        // final count of pages it did not check. The per-page checks are emitted as
        // each page finishes, so only this one can hold the total.
        // And the row also goes into the page rule's own results (pub#971): the
        // store and the report are built from `ruleResults`, and a row only in
        // `checks` never reached either. It merges into that rule's per-page results
        // as one site-scope check.
        for (const [ruleId, t] of this.timedOutPageRules) {
          const summary = timeoutSummaryCheck(ruleId, t.name, t.category, t.budgetMs, t.details.pages, t.maxElapsedMs);
          allChecks.push(summary);
          const existing = ruleResults.get(ruleId);
          ruleResults.set(
            ruleId,
            existing ? { ...existing, checks: [...existing.checks, summary] } : { meta: t.meta, checks: [summary] }
          );
        }
        for (const [ruleId, t] of this.erroredPageRules) {
          const summary = errorSummaryCheck(ruleId, t.name, t.pages, t.error, t.site);
          allChecks.push(summary);
          const existing = ruleResults.get(ruleId);
          ruleResults.set(
            ruleId,
            existing ? { ...existing, checks: [...existing.checks, summary] } : { meta: t.meta, checks: [summary] }
          );
        }
        this.resetAudit();

        return { checks: allChecks, ruleResults };
      },
      () => ({})
    );
  }

  /**
   * Forget which page rules have timed out, so the next audit on this runner
   * counts its own timeouts from one. A runner should serve one audit;
   * this is for a caller that reuses one.
   */
  resetAudit(): void {
    this.timedOutPageRules.clear();
    this.erroredPageRules.clear();
  }
}

/** A thrown rule's message is clipped to this in a check: it can quote page content. */
const MAX_RULE_ERROR_CHARS = 200;

/**
 * The `<rule>-errors` info check (#1291): how many pages a rule that threw did
 * not evaluate, and its first error. The one row the report shows for the rule.
 */
function errorSummaryCheck(ruleId: string, name: string, pages: number, error: string, site = false): CheckResult {
  return {
    name: `${ruleId}-errors`,
    status: "info" as const,
    message: site
      ? `${name}: threw an error and was not evaluated for the site (first error: ${error}). This is a defect in squirrelscan, not a problem with your site`
      : `${name}: threw an error on ${pages} page${pages === 1 ? "" : "s"} and was not evaluated there (first error: ${error}). This is a defect in squirrelscan, not a problem with your pages`,
    details: { errored: true, ruleId, ...(site ? { site: true } : { pagesNotChecked: pages }), error },
  };
}

/**
 * The `<rule>-timeouts` info check: how many pages a timed-out rule did not
 * check. The place the report surfaces a timeout, now that the per-page check
 * is a skip (pub#960).
 */
function timeoutSummaryCheck(
  ruleId: string,
  name: string,
  category: string,
  budgetMs: number,
  pages: number,
  maxElapsedMs?: number
): CheckResult {
  const unchecked = `${pages} page${pages === 1 ? "" : "s"} not checked`;
  return {
    name: `${ruleId}-timeouts`,
    status: "info" as const,
    message:
      category === "security"
        ? `${name}: ${unchecked} because it exceeded its ${budgetMs} ms time budget. A timed-out security rule did not check those pages, so no finding there is not a clean result`
        : `${name}: ${unchecked} because it exceeded its ${budgetMs} ms time budget`,
    details: {
      timedOut: true,
      ruleId,
      budgetMs,
      pagesNotChecked: pages,
      ...(maxElapsedMs ? { maxElapsedMs } : {}),
    },
  };
}

/** `ruleId -> skipped checks` for the page-time extractors that ran past their
 *  budget: one per page that timed out, each against its own page (pub#960), the
 *  same shape as a page rule's timeout. The count of pages is the `-timeouts`
 *  info row's `pagesNotChecked`. */
function collectedTimeoutChecks(
  collected: CollectedSiteSignals | undefined
): Map<string, CheckResult[]> {
  const byRule = new Map<string, CheckResult[]>();
  for (const page of collected?.pages ?? []) {
    if (!page.timedOut) continue;
    const { budgetMs, ruleIds, elapsedMs } = page.timedOut;
    for (const ruleId of ruleIds) {
      let checks = byRule.get(ruleId);
      if (!checks) {
        checks = [];
        byRule.set(ruleId, checks);
      }
      checks.push({
        name: `${ruleId}-error`,
        status: "skipped",
        message: `Rule not evaluated: ${new RuleTimeoutError(budgetMs).message}`,
        skipReason: RULE_TIMED_OUT_SKIP_REASON,
        pageUrl: page.url,
        details: {
          timedOut: true,
          ruleId,
          budgetMs,
          ...(elapsedMs?.[ruleId] !== undefined ? { elapsedMs: elapsedMs[ruleId] } : {}),
        },
      });
    }
  }
  return byRule;
}

// Convenience function to create runner with defaults. `scope` threads the
// per-audit-run Stage-0 site metadata + prefetched cloud results; omit it
// for an offline / no-cloud run (no gating, all cloud lookups miss).
export function createRunner(config: RulesConfig, scope?: RunnerScope): RuleRunner {
  return new RuleRunner({ config, ...scope });
}
