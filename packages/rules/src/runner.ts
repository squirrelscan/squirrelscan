import { logger } from "./logger";
// Rule runner - executes rules with context

import { detectSoft404, parsePage } from "@squirrelscan/parser";
import { mapWithConcurrency } from "@squirrelscan/utils";

import type {
  CheckResult,
  IntelContext,
  SiteMetadata,
  SiteQuery,
} from "@squirrelscan/core-contracts";


import type {
  PageData,
  ParsedPage,
  Rule,
  RuleContext,
  RuleRunResult,
  SiteData,
} from "./types";

import type { CloudResultStore } from "./cloud";
import type { CollectedSiteSignals } from "./collected-signals";
import { ruleApplies } from "./applicability";
import { filterRules } from "./filter";
import { loadAllRules, type RuleNamespace } from "./loader";

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
}

const DEFAULT_RULE_CONCURRENCY = 8;

export interface PageRunResult {
  checks: CheckResult[];
  parsed: ParsedPage;
  ruleResults: Map<string, RuleRunResult>;
}

export interface SiteRunResult {
  checks: CheckResult[];
  ruleResults: Map<string, RuleRunResult>;
}
// Get rule options from config, with defaults from rule schema
function getRuleOptions(rule: Rule, config: RulesConfig): Record<string, unknown> {
  const ruleConfig = config.rule_options[rule.meta.id] ?? {};

  // If rule has options schema, parse with defaults
  if (rule.meta.optionsSchema) {
    return rule.meta.optionsSchema.parse(ruleConfig);
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

export class RuleRunner {
  private rules: Map<string, Rule>;
  private enabledRuleIds: string[];
  private config: RulesConfig;
  // Only affects site rules — page rules are sync CPU and run sequentially (#379)
  private ruleConcurrency: number;
  // Per-run state — captured once at construction, immutable for the
  // lifetime of this runner instance. Each audit gets its own RuleRunner, so
  // concurrent audits never share these.
  private readonly siteMetadata: SiteMetadata | undefined;
  private readonly cloudResults: CloudResultStore | undefined;
  private readonly intel: IntelContext | undefined;

  constructor(options: RunnerOptions) {
    this.config = options.config;
    this.siteMetadata = options.siteMetadata;
    this.cloudResults = options.cloudResults;
    this.intel = options.intel;
    this.ruleConcurrency = Math.max(
      1,
      options.ruleConcurrency ?? DEFAULT_RULE_CONCURRENCY
    );

    // Load all rules (plus any caller-supplied namespaces — plugins / tests)
    this.rules = loadAllRules({ additionalNamespaces: options.additionalNamespaces });

    // Filter to enabled rules based on config
    const allIds = Array.from(this.rules.keys());
    this.enabledRuleIds = filterRules(
      allIds,
      this.config.rules?.enable,
      this.config.rules?.disable,
      this.config.rule_options as Record<string, { enabled?: boolean }>
    );
  }

  // Get list of enabled rules
  getEnabledRules(): Rule[] {
    return this.enabledRuleIds.map((id) => this.rules.get(id)!);
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
   */
  private runOneRule(
    rule: Rule,
    ctx: RuleContext,
    siteMetadata: SiteMetadata | undefined,
    scopeForLog?: "site"
  ): RuleRunResult | Promise<RuleRunResult> {
    // Run-time applicability gate — emit a visible `skipped` check and skip
    // `run()` when the Stage-0 metadata excludes this rule.
    const skip = checkApplicability(rule, this.config, siteMetadata);
    if (skip) {
      return { meta: rule.meta, checks: [skip] };
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

    const ruleStart = performance.now();
    let ruleError: unknown = null;
    let ruleCheckCount = 0;

    // Build the result + emit the per-rule profile line. Shared by both paths so
    // output and logging are identical regardless of run() being sync or async.
    const finalize = (ruleChecks: CheckResult[]): RuleRunResult => {
      ruleCheckCount = ruleChecks.length;
      const passed = ruleChecks.filter((c) => c.status === "pass").length;
      const failed = ruleChecks.filter((c) => c.status === "fail").length;
      const warned = ruleChecks.filter((c) => c.status === "warn").length;
      logger.debug("rule", {
        ruleId: rule.meta.id,
        ...(scopeForLog ? { scope: scopeForLog } : { pageUrl: ctx.page.url }),
        checks: ruleChecks.length,
        passed,
        failed,
        warned,
        durationMs: Math.round(performance.now() - ruleStart),
      });
      return { meta: rule.meta, checks: ruleChecks };
    };

    const errorChecks = (e: unknown): CheckResult[] => {
      ruleError = e;
      return [
        {
          name: `${rule.meta.id}-error`,
          status: "fail",
          message: `Rule error: ${(e as Error).message}`,
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
          outcome = rule.run(ctx);
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
    siteData?: SiteData
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

        // Sequential + sync fast-path: only the few async page rules pay a
        // microtask; sync rules run straight through, no Promise overhead (#521).
        const ruleResults = new Map<string, RuleRunResult>();
        const allChecks: CheckResult[] = [];
        for (const rule of pageRules) {
          const ctx: RuleContext = {
            page,
            parsed,
            site: siteData, // Pass site data for rules that need scripts/resourceSizes
            siteMetadata,
            cloudResults,
            intel,
            options: getRuleOptions(rule, this.config),
          };
          const out = this.runOneRule(rule, ctx, siteMetadata);
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
    collectedSignals?: CollectedSiteSignals
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
              siteMetadata,
              cloudResults,
              intel,
              options: getRuleOptions(rule, this.config),
            };
            return Promise.resolve(this.runOneRule(rule, ctx, siteMetadata, "site"));
          }),
          this.ruleConcurrency
        );

        const allChecks: CheckResult[] = [];
        const ruleResults = new Map<string, RuleRunResult>();
        for (let i = 0; i < siteRules.length; i++) {
          const result = results[i];
          ruleResults.set(siteRules[i].meta.id, result);
          allChecks.push(...result.checks);
        }

        return { checks: allChecks, ruleResults };
      },
      () => ({})
    );
  }
}

// Convenience function to create runner with defaults. `scope` threads the
// per-audit-run Stage-0 site metadata + prefetched cloud results; omit it
// for an offline / no-cloud run (no gating, all cloud lookups miss).
export function createRunner(config: RulesConfig, scope?: RunnerScope): RuleRunner {
  return new RuleRunner({ config, ...scope });
}
