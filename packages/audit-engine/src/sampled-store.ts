// Scoring a partial re-audit over a SAMPLED cloud store (squirrelscan/repo#3373).
//
// A capped report published as one POST (the CLI's publish) leaves the findings
// store holding a sample: at most 10 pages per issue class. A later partial
// re-audit carries those rows, and every other page of the class reads clean, so
// the score goes up. The prior report's `checkTallies` still count every page of
// every class. When the caller marks the store sampled and hands those tallies
// over, the carried side of each tallied page rule is scored from them instead of
// from the sampled rows.
//
// THE OVERLAP. The tallies count every page the sampled audit checked. The
// re-audit re-checks some of those pages, and those are scored fresh, so their
// prior counts must come out of the tallies before the rest is carried:
//
//  - A re-checked page the store holds a sampled row for (a "known" page) is
//    subtracted exactly: one fail or warn check per (page, check name), and one
//    fail unit, the least it can have held.
//  - A re-checked page with no stored row is UNKNOWN: it was clean, or it failed
//    and the sample clipped it. Nothing is subtracted for it. Its prior issues,
//    if any, stay in the carried estimate, which can only add issues the full
//    store would not have, never remove ones it would. That is the bias: it can
//    lower the score or keep it, never raise it.
//
// THE ESTIMATE, per tallied page rule R and check name k. `c` is the number of
// pages a prior row for k would still be carried on (the pages this run did not
// crawl, plus the crawled ones it did not evaluate k on), `N` the pages the
// sampled audit audited, and KL the known re-checked pages above.
//
//    fail mass   F = min(c * perPage, max(failed, failUnits) - KLfail)
//    warn range  W in [Wlo, Whi]:  Whi = min(c, warnings - KLwarn),
//                                  Wlo = min(Whi, warnings - (N - c))
//    scored:     warnings = Wlo, failed = F + (Whi - Wlo)
//    units:      the same shape over warnUnits / failUnits (cap ISSUE_PENALTY_ITEM_CAP)
//    passes:     clean carried pages = carried pages - min(carried pages,
//                  dirty pages of R - known re-checked dirty pages + pages with
//                  other carried rows)
//
// Every term is an upper bound on what the full store holds for issues and a
// lower bound for passes and warnings, and a warning the bounds cannot place is
// scored as a failure. Starting from the full store's counts, the estimate is
// reached only by removing passes, turning warnings into failures and adding
// failures, and each of those lowers or keeps a rule's pass ratio and raises or
// keeps the issue-density penalty. So the score can only be the full store's or
// lower.
//
// When nothing was re-checked the bounds meet (`KL` = 0, `N` = `c`), so the
// estimate is the full store's count exactly; when every page was re-checked
// (`c` = 0) it is empty and the score is a fresh full audit's. Between the two,
// the gap is at most the unknown re-checked pages: per rule and check name, at
// most that many extra failing checks (each with up to ISSUE_PENALTY_ITEM_CAP
// fail units) and that many fewer clean carried pages.
//
// Assumptions the bounds rest on, which the engine's rules and store hold: a rule
// emits at most one fail or warn check per check name and page (the store keys an
// item-less row by page, rule and check, so it could not hold two); an item list
// holds at most ISSUE_PENALTY_ITEM_CAP items. The store replays a carried check
// with an item list as one check per item, which the tallies cannot see for
// WARNINGS (`warnUnits` counts pages, not items), so a warn class with item lists
// is bounded at the audit's granularity, one check per page, as a fresh audit
// counts it.
//
// Off the single-POST (sampled) path only: a complete-store finalize ignores the
// marker (see CloudSmartAuditsInput.sampledStore).

import type {
  CheckTallies,
  CheckTally,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import type { RuleRunResult } from "@squirrelscan/rules/types";
import { ISSUE_PENALTY_ITEM_CAP } from "@squirrelscan/utils/constants";

import {
  addChecksToTally,
  carriedFindingToCheck,
  emptyTally,
  type CarriedFinding,
  type IssueTally,
  type PageUrlSet,
  type RuleTally,
} from "./scoring";

/**
 * (repo#3373) What the caller knows about a store an earlier capped single POST
 * wrote: it holds a sample of that audit's findings, and the audit's own counts.
 */
export interface SampledStoreMarker {
  /** True when the store holds only the capped report's sample. Anything else: ignored. */
  sampled: boolean;
  /**
   * The audit id the sampled publish ran under: the `lastSeenCrawlId` its rows
   * and site pages were written with. Pages still carrying it are the pages that
   * audit checked and no later audit has.
   */
  crawlId: string;
  /** That report's `checkTallies`: every page of every class, counted before the cap. */
  checkTallies: CheckTallies;
  /**
   * Pages that audit audited (its `coverage.auditedPages`). Bounds how many of
   * its warnings can sit on pages this run re-checked. Without it, every
   * warning the estimate carries is scored as a failure.
   */
  pagesAudited?: number;
  /**
   * That report's `rulePageCounts`: the exact distinct failing pages of the rules
   * whose classes overlap. Without an entry, a rule's classes are added up, which
   * can only count more failing pages than there were.
   */
  rulePageCounts?: Record<string, number>;
}

/** True when `marker` asks for, and can support, the sampled-store estimate. */
export function isSampledStoreMarker(marker: unknown): marker is SampledStoreMarker {
  if (!marker || typeof marker !== "object") return false;
  const m = marker as Partial<SampledStoreMarker>;
  return (
    m.sampled === true &&
    typeof m.crawlId === "string" &&
    m.crawlId.length > 0 &&
    !!m.checkTallies &&
    typeof m.checkTallies === "object" &&
    !Array.isArray(m.checkTallies)
  );
}

export interface SampledStoreScope {
  marker: SampledStoreMarker;
  /** The site's pages as the merge read them, before this run wrote any. */
  priorPages: readonly SitePageRecord[];
  /** This run crawled the page (any evidence: payload, signal list or its hashes). */
  crawled(url: string): boolean;
  /** This run removed the page (404/410). */
  removed(url: string): boolean;
  /** This run evaluated check `checkName` of `ruleId` on the (crawled) page. */
  evaluated(url: string, ruleId: string, checkName: string): boolean;
  /**
   * False when this run's own crawled set cannot be read exactly (no signal, or a
   * clipped list without hashes): a page it re-checked may then also count as
   * carried, so no estimated warning is kept as one.
   */
  crawledSetExact: boolean;
}

interface LeavingRule {
  /** Pages this run did not carry that hold a sampled row of the rule. */
  dirtyPages: Set<string>;
  /** Per check name, re-checked pages that held a sampled fail / warn row. */
  byName: Map<string, { fail: Set<string>; warn: Set<string> }>;
}

/** A safe count off a published tally: a finite non-negative integer, else 0. */
function count(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER)
    : 0;
}

function subtractTally(target: IssueTally, source: IssueTally): void {
  target.passed = Math.max(0, target.passed - source.passed);
  target.warnings = Math.max(0, target.warnings - source.warnings);
  target.failed = Math.max(0, target.failed - source.failed);
  target.warnUnits = Math.max(0, target.warnUnits - source.warnUnits);
  target.failUnits = Math.max(0, target.failUnits - source.failUnits);
}

function addInto(target: IssueTally, source: IssueTally): void {
  target.passed += source.passed;
  target.warnings += source.warnings;
  target.failed += source.failed;
  target.warnUnits += source.warnUnits;
  target.failUnits += source.failUnits;
}

/**
 * Collects what the estimate needs while the merge streams the prior rows, then
 * rewrites the carried side of the scoring tallies (see the file header).
 */
export class SampledStoreEstimator {
  private readonly marker: SampledStoreMarker;
  private readonly scope: SampledStoreScope;
  /** P: active pages the sampled audit checked and no later audit has. */
  private readonly priorRunPages = new Set<string>();
  /** CP: those of P this run did not crawl or remove. */
  private readonly carriedPages = new Set<string>();
  /** P pages this run crawled and did not remove. */
  private readonly recheckedPages: string[] = [];
  private readonly leaving = new Map<string, LeavingRule>();
  /** Check names each tallied rule has sampled rows for (a class the tallies may omit). */
  private readonly rowNames = new Map<string, Set<string>>();
  /** Carried findings that are the sampled audit's own rows, counted by the tallies. */
  private readonly sampledRows = new Set<CarriedFinding>();
  /** `pagesAudited`, when usable: at least every page in P. */
  private readonly pagesAudited: number | undefined;

  constructor(scope: SampledStoreScope) {
    this.scope = scope;
    this.marker = scope.marker;
    for (const page of scope.priorPages) {
      if (page.state !== "active" || page.lastSeenCrawlId !== this.marker.crawlId) continue;
      this.priorRunPages.add(page.normalizedUrl);
    }
    for (const url of this.priorRunPages) {
      if (scope.removed(url)) continue;
      if (scope.crawled(url)) this.recheckedPages.push(url);
      else this.carriedPages.add(url);
    }
    const audited = this.marker.pagesAudited;
    this.pagesAudited =
      typeof audited === "number" && Number.isSafeInteger(audited) && audited >= 0
        ? Math.max(audited, this.priorRunPages.size)
        : undefined;
  }

  private tallyFor(ruleId: string, checkName: string): CheckTally | undefined {
    const byName = this.marker.checkTallies[ruleId];
    if (!byName || typeof byName !== "object") return undefined;
    const t = (byName as Record<string, CheckTally>)[checkName];
    return t && typeof t === "object" ? t : undefined;
  }

  private isSampledRow(row: { normalizedUrl: string; ruleId: string; lastSeenCrawlId: string }): boolean {
    return (
      row.lastSeenCrawlId === this.marker.crawlId &&
      this.priorRunPages.has(row.normalizedUrl) &&
      Object.hasOwn(this.marker.checkTallies, row.ruleId)
    );
  }

  /** Every OPEN prior row, as the merge reads it. */
  observePrior(row: PageFindingRecord): void {
    if (row.state !== "open" || !this.isSampledRow(row)) return;
    const { normalizedUrl: url, ruleId, checkName } = row;
    let names = this.rowNames.get(ruleId);
    if (!names) {
      names = new Set();
      this.rowNames.set(ruleId, names);
    }
    names.add(checkName);
    if (this.carriedPages.has(url)) return;
    let rule = this.leaving.get(ruleId);
    if (!rule) {
      rule = { dirtyPages: new Set(), byName: new Map() };
      this.leaving.set(ruleId, rule);
    }
    rule.dirtyPages.add(url);
    // A crawled page this run did not evaluate the check on still carries the row:
    // it has not left the carried side for that check.
    if (!this.scope.removed(url) && !this.scope.evaluated(url, ruleId, checkName)) return;
    let sets = rule.byName.get(checkName);
    if (!sets) {
      sets = { fail: new Set(), warn: new Set() };
      rule.byName.set(checkName, sets);
    }
    if (row.status === "fail") sets.fail.add(url);
    else if (row.status === "warn") sets.warn.add(url);
  }

  /** A prior the merge carried, and the view of it the union was given. */
  noteCarried(
    finding: { normalizedUrl: string; ruleId: string; checkName: string; lastSeenCrawlId: string },
    carried: CarriedFinding,
  ): void {
    if (this.isSampledRow(finding) && this.tallyFor(finding.ruleId, finding.checkName)) {
      this.sampledRows.add(carried);
    }
  }

  /** A row's (rule, check) still counts as carried for `url`: not re-checked for it. */
  private carriedFor(url: string, ruleId: string, checkName: string): boolean {
    if (this.carriedPages.has(url)) return true;
    if (this.scope.removed(url)) return false;
    return !this.scope.evaluated(url, ruleId, checkName);
  }

  /**
   * Rewrite the carried side of every tallied page rule in `scoringTallies` (and
   * the warnings and failures of `reportTotals`) from the sampled audit's counts.
   *
   * `unionCarried` and `unionCarriedPages` must be exactly what the tallies were
   * scored over: the rows this replaces are subtracted as the union counted them.
   */
  apply(input: {
    scoringTallies: Map<string, RuleTally>;
    reportTotals: { passed: number; warnings: number; failed: number };
    unionCarried: readonly CarriedFinding[];
    unionCarriedPages: PageUrlSet;
    ruleMetaIndex: Map<string, RuleRunResult["meta"]>;
  }): void {
    const { scoringTallies, reportTotals, unionCarried, unionCarriedPages } = input;
    // Carried pages that earn a clean pass in the union.
    const passPages: string[] = [];
    for (const url of this.carriedPages) if (unionCarriedPages.has(url)) passPages.push(url);
    const passPageSet = new Set(passPages);

    // The union's carried rows of each tallied rule, by page.
    const rowsByRule = new Map<string, Map<string, CarriedFinding[]>>();
    for (const f of unionCarried) {
      if (!Object.hasOwn(this.marker.checkTallies, f.ruleId)) continue;
      let byPage = rowsByRule.get(f.ruleId);
      if (!byPage) {
        byPage = new Map();
        rowsByRule.set(f.ruleId, byPage);
      }
      const list = byPage.get(f.normalizedUrl);
      if (list) list.push(f);
      else byPage.set(f.normalizedUrl, [f]);
    }

    const n = this.pagesAudited;
    const warnBound = n !== undefined && this.scope.crawledSetExact;

    for (const ruleId of Object.keys(this.marker.checkTallies)) {
      const entry = scoringTallies.get(ruleId);
      if (!entry || entry.meta.scope !== "page") continue;
      const advisory = entry.meta.severity === "info";
      const byName = this.marker.checkTallies[ruleId] as Record<string, CheckTally>;
      if (!byName || typeof byName !== "object") continue;

      // ── What the union counted for the rows this replaces ─────────────────
      // The sampled rows still carried for their check (the estimate stands in
      // for them), and every other carried row of the rule on those pages, whose
      // warnings are scored as failures: one may be a page the tallies count too.
      const replaced = emptyTally();
      const otherAsCounted = emptyTally();
      const otherAsFailures = emptyTally();
      let dirtyPassPages = 0;
      let otherDirtyPassPages = 0;
      for (const [url, rows] of rowsByRule.get(ruleId) ?? []) {
        // Rows on pages the sampled audit did not check are not in its tallies:
        // the union already counts them as the full store would.
        if (!this.priorRunPages.has(url)) continue;
        if (passPageSet.has(url)) dirtyPassPages += 1;
        const sampled: CarriedFinding[] = [];
        const other: CarriedFinding[] = [];
        for (const f of rows) {
          if (!this.carriedFor(url, f.ruleId, f.checkName)) continue;
          (this.sampledRows.has(f) ? sampled : other).push(f);
        }
        if (sampled.length > 0) {
          addChecksToTally(replaced, sampled.map((f) => carriedFindingToCheck(f, url)), advisory);
        }
        if (other.length > 0) {
          if (passPageSet.has(url)) otherDirtyPassPages += 1;
          addChecksToTally(otherAsCounted, other.map((f) => carriedFindingToCheck(f, url)), advisory);
          addChecksToTally(
            otherAsFailures,
            other.map((f) => {
              const check = carriedFindingToCheck(f, url);
              // An advisory warning scores nothing either way.
              return advisory ? check : { ...check, status: "fail" as const };
            }),
            advisory,
          );
        }
      }

      // ── The estimate, per check name ──────────────────────────────────────
      const leaving = this.leaving.get(ruleId);
      const estimate = emptyTally();
      let classPages = 0;
      const names = new Set(Object.keys(byName));
      for (const name of this.rowNames.get(ruleId) ?? []) names.add(name);
      for (const name of names) {
        const t = byName[name];
        const failed = count(t?.failed);
        const warnings = count(t?.warnings);
        const failUnits = count(t?.failUnits);
        const warnUnits = count(t?.warnUnits);
        const passed = count(t?.passed);
        const skipped = count(t?.skipped);
        // Dirty pages of the class: its fail and warn checks, one per page. An
        // advisory rule's warnings are not in its tallies, so its warn pages are
        // bounded by the pages that neither passed, failed nor skipped the check.
        classPages += failed + warnings;
        if (advisory) {
          classPages += n === undefined ? Number.POSITIVE_INFINITY : Math.max(0, n - passed - failed - skipped);
        }
        if (!t) continue;

        let carriedPages = this.carriedPages.size;
        for (const url of this.recheckedPages) {
          if (!this.scope.evaluated(url, ruleId, name)) carriedPages += 1;
        }
        if (carriedPages === 0) continue;
        const known = leaving?.byName.get(name);
        const knownFail = known?.fail.size ?? 0;
        const knownWarn = known?.warn.size ?? 0;
        // Off the carried pages, each page holds at most one warning of the check.
        const offCarried = n === undefined ? 0 : Math.max(0, n - carriedPages);

        const perPage = failUnits > failed ? ISSUE_PENALTY_ITEM_CAP : 1;
        const failMass = Math.min(carriedPages * perPage, Math.max(0, Math.max(failed, failUnits) - knownFail));
        const warnHi = Math.min(carriedPages, Math.max(0, warnings - knownWarn));
        const warnLo = warnBound ? Math.min(warnHi, Math.max(0, warnings - offCarried)) : 0;
        const failUnitHi = Math.min(carriedPages * ISSUE_PENALTY_ITEM_CAP, Math.max(0, failUnits - knownFail));
        const warnUnitHi = Math.min(carriedPages, Math.max(0, warnUnits - knownWarn));
        const warnUnitLo = warnBound ? Math.min(warnUnitHi, Math.max(0, warnUnits - offCarried)) : 0;

        estimate.warnings += warnLo;
        estimate.failed += failMass + (warnHi - warnLo);
        estimate.warnUnits += warnUnitLo;
        estimate.failUnits += failUnitHi + (warnUnitHi - warnUnitLo);
      }

      // ── Clean carried pages ───────────────────────────────────────────────
      const rulePages = this.marker.rulePageCounts?.[ruleId];
      const dirtyPages =
        typeof rulePages === "number" && Number.isFinite(rulePages) && rulePages >= 0
          ? Math.floor(rulePages)
          : classPages;
      const knownDirty = leaving?.dirtyPages.size ?? 0;
      const passCandidates = passPages.length;
      const sampledDirty = Math.min(passCandidates, Math.max(0, dirtyPages - knownDirty));
      const estimatedDirty = Math.min(passCandidates, sampledDirty + otherDirtyPassPages);
      // Passes the union gave that the estimate does not. Never negative: the
      // estimate only ever takes passes away.
      const passDelta = Math.max(0, estimatedDirty - dirtyPassPages);

      const tally = entry.tally;
      subtractTally(tally, replaced);
      subtractTally(tally, otherAsCounted);
      addInto(tally, otherAsFailures);
      addInto(tally, estimate);
      tally.passed = Math.max(0, tally.passed - passDelta);

      reportTotals.warnings = Math.max(
        0,
        reportTotals.warnings - replaced.warnings - otherAsCounted.warnings + otherAsFailures.warnings + estimate.warnings,
      );
      reportTotals.failed = Math.max(
        0,
        reportTotals.failed - replaced.failed - otherAsCounted.failed + otherAsFailures.failed + estimate.failed,
      );
    }
  }
}
