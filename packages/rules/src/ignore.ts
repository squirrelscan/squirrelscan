// `[[ignore]]` waivers (#1262): drop findings a rule reports that are right in
// general and not actionable here, without disabling the rule.
//
// One engine-level filter applied in `RuleRunner.runOneRule` to every rule's
// result (page rules, site rules, fanned template verdicts), before the result is
// counted, tallied or scored. Pure and bounded: matchers are compiled once, regex
// matchers are length-capped and refused when they could backtrack badly, and the
// text a matcher sees is clamped.

import type { CheckItem, CheckResult } from "@squirrelscan/core-contracts";
import { IGNORED_SKIP_REASON, type IgnoredDetails } from "@squirrelscan/core-contracts/ignore";
import { matchesExcludePattern } from "@squirrelscan/utils/patterns";
import { getPathname } from "@squirrelscan/utils/url";

import { compileSafeRegex, type CompileWork, type SafeRegex } from "./safe-regex";
import type { RuleMeta } from "./types";

export { IGNORED_SKIP_REASON };

/**
 * One `[[ignore]]` entry, as `@squirrelscan/config`'s `IgnoreEntry` (structural,
 * so this package keeps no dependency on the config package).
 */
export interface IgnoreEntry {
  rule: string;
  checks?: string[];
  items?: string[];
  urls?: string[];
  reason?: string;
}

/** Text longer than this never matches a regex or glob (truncating would let `$` match mid-string); exact matches still apply. */
const MAX_MATCH_INPUT = 2048;
/** Work one regex test may do (NFA steps) before the entry is given up on. */
export const MAX_STEPS_PER_TEST = 400_000;
/** Work one entry's regexes may do over a whole run; past it the entry stops waiving (fails closed). */
export const MAX_STEPS_PER_ENTRY = 10_000_000;
/** Compile work (code points folded plus instructions) all of a table's regexes may use together; past it the rest are refused. */
export const MAX_COMPILE_WORK_PER_TABLE = 1_000_000;
/** Work every entry's regexes and globs may do together over a run (one table = one audit). Past it every entry stops waiving. */
export const MAX_STEPS_PER_AUDIT = 50_000_000;
/** The schema's caps, enforced here too: entries can arrive from a `--ignore` flag or a cloud config that skipped the schema. */
export const MAX_ENTRIES = 200;
export const MAX_MATCHERS_PER_FIELD = 100;
/** Any item, check or url pattern longer than this is refused. */
export const MAX_PATTERN_CHARS = 512;
/** A glob longer than this is refused. */
const MAX_GLOB_LENGTH = 512;

type TextMatcher = (text: string) => boolean;

/** Why a matcher could not be compiled, for `squirrel config validate`. */
export interface IgnoreMatcherProblem {
  entry: number;
  field: "rule" | "items" | "urls" | "checks";
  pattern: string;
  message: string;
}

/**
 * The work an entry's regexes may do. Shared by all its matchers; once spent (or
 * once one test runs over) the entry is dead: its matchers answer "no match", so
 * nothing more is waived and findings stay visible. Never "match everything".
 */
interface EntryBudget {
  left: number;
  dead: boolean;
  /** The entry has a regex or glob matcher, so it consults the work budget (exact matchers never do). */
  metered: boolean;
  /** Shared by every entry of the table: audit-wide match work, and the compile work of all patterns. */
  total: { left: number; compile: CompileWork };
}

/** Take `steps` from the entry and the table; false once either is spent (the entry is then dead). */
function charge(budget: EntryBudget, steps: number): boolean {
  budget.left -= steps;
  budget.total.left -= steps;
  if (budget.left <= 0 || budget.total.left <= 0) budget.dead = true;
  return !budget.dead;
}

/**
 * Glob match (`*` any run, `?` any one character) in O(text x pattern) with no
 * backtracking blow-up: the classic two-pointer walk that remembers only the last
 * `*`. Replaces a glob-to-RegExp translation, whose `.*.*.*` chains backtrack.
 */
export function globMatch(glob: string, text: string): boolean {
  return globRun(glob, text, Infinity)?.matched ?? false;
}

/** The walk behind {@link globMatch}, counting loop iterations; null when `limit` ran out. */
function globRun(glob: string, text: string, limit: number): { matched: boolean; steps: number } | null {
  let g = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  let steps = 0;
  while (t < text.length) {
    if (++steps > limit) return null;
    const c = glob[g];
    if (c === "*") {
      star = g++;
      mark = t;
    } else if (c !== undefined && (c === "?" || c === text[t])) {
      g++;
      t++;
    } else if (star >= 0) {
      g = star + 1;
      t = ++mark;
    } else return { matched: false, steps };
  }
  while (glob[g] === "*") g++;
  return { matched: g === glob.length, steps };
}

function regexMatcher(re: SafeRegex, budget: EntryBudget): TextMatcher {
  budget.metered = true;
  return (text) => {
    if (budget.dead || budget.total.left <= 0) return false;
    if (text.length > MAX_MATCH_INPUT) return false;
    const result = re.test(text, Math.min(MAX_STEPS_PER_TEST, budget.left, budget.total.left));
    if (result === null) {
      budget.dead = true;
      return false;
    }
    charge(budget, result.steps);
    return result.matched;
  };
}

/** An item or check-name matcher: exact by default, `glob:` and `regex:` by prefix. */
function compileTextMatcher(pattern: string, budget: EntryBudget): TextMatcher | string {
  if (pattern.length > MAX_PATTERN_CHARS) return `a pattern over ${MAX_PATTERN_CHARS} characters`;
  if (pattern.startsWith("regex:")) {
    const re = compileSafeRegex(pattern.slice(6), "", budget.total.compile);
    return typeof re === "string" ? re : regexMatcher(re, budget);
  }
  if (pattern.startsWith("glob:")) {
    const glob = pattern.slice(5);
    if (glob.length > MAX_GLOB_LENGTH) return `a glob over ${MAX_GLOB_LENGTH} characters`;
    budget.metered = true;
    return (text) => {
      if (budget.dead || budget.total.left <= 0 || text.length > MAX_MATCH_INPUT) return false;
      const result = globRun(glob, text, Math.min(MAX_STEPS_PER_TEST, budget.left, budget.total.left));
      if (result === null) {
        budget.dead = true;
        return false;
      }
      charge(budget, result.steps);
      return result.matched;
    };
  }
  return (text) => text === pattern;
}

/** A rule pattern: an exact id, or a glob (`a11y/*`, `*`). */
export function ruleMatcher(pattern: string): (ruleId: string) => boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return (id) => id === pattern;
  if (pattern.length > MAX_GLOB_LENGTH) return () => false;
  return (id) => id.length <= MAX_MATCH_INPUT && globMatch(pattern, id);
}

/** The flags suffix of a url regex (`regex:^/a:i`), as the `excludePatterns` form. */
function splitUrlRegex(pattern: string): { source: string; flags: string } {
  const source = pattern.slice(6);
  const colon = source.lastIndexOf(":");
  if (colon > 0 && /^[gimsuvy]+$/.test(source.slice(colon + 1))) return { source: source.slice(0, colon), flags: source.slice(colon + 1) };
  return { source, flags: "" };
}

/**
 * A url matcher over the page path: the `excludePatterns` forms (substring,
 * `/segment/`, `regex:`), except that a regex runs on the linear engine. Invalid
 * regexes are refused here, not warned per page.
 */
function compileUrlMatcher(pattern: string, budget: EntryBudget): TextMatcher | string {
  if (!pattern) return () => false;
  if (pattern.length > MAX_PATTERN_CHARS) return `a pattern over ${MAX_PATTERN_CHARS} characters`;
  if (pattern.startsWith("regex:")) {
    const { source, flags } = splitUrlRegex(pattern);
    const re = compileSafeRegex(source, flags, budget.total.compile);
    if (typeof re === "string") return re;
    const matcher = regexMatcher(re, budget);
    return (url) => matcher(getPathname(url) || url);
  }
  // Substring and segment forms are linear (`includes` / `startsWith`).
  return (url) => matchesExcludePattern(url, [pattern]);
}

interface CompiledEntry {
  index: number;
  entry: IgnoreEntry;
  rule: TextMatcher;
  checks?: TextMatcher[];
  items?: TextMatcher[];
  urls: TextMatcher[];
  budget: EntryBudget;
}

/** Whether a rule may be waived at all. */
export function isIgnorable(meta: Pick<RuleMeta, "ignorable">): boolean {
  return meta.ignorable !== false;
}

/**
 * The compiled `[[ignore]]` list. Built once per run; `forRule` answers which
 * entries touch a rule, so a rule no entry names pays one map lookup per result.
 */
export class IgnoreTable {
  readonly entries: readonly IgnoreEntry[];
  readonly problems: IgnoreMatcherProblem[] = [];
  private readonly compiled: CompiledEntry[] = [];
  /** Entries whose regexes ran out of work and stopped waiving, with the message shown once. */
  readonly timedOut: { entry: number; message: string }[] = [];
  private readonly byRule = new Map<string, CompiledEntry[]>();
  private onTimeout?: (message: string, entry: number) => void;
  private readonly isIgnorableRule: (ruleId: string) => boolean;
  private readonly countsItems: (ruleId: string) => boolean;

  constructor(
    entries: readonly IgnoreEntry[] | undefined,
    options: {
      isIgnorableRule?: (ruleId: string) => boolean;
      /** Rules whose messages start with the item count ({@link RuleMeta.messageCountsItems}). */
      messageCountsItems?: (ruleId: string) => boolean;
      /** Called once when an entry's regexes exhaust their work budget and the entry stops waiving. */
      onTimeout?: (message: string, entry: number) => void;
      /** Test seam: smaller work budgets than {@link MAX_STEPS_PER_ENTRY} / {@link MAX_STEPS_PER_AUDIT}. */
      limits?: { perEntry?: number; perAudit?: number; compile?: number };
    } = {},
  ) {
    this.entries = entries ?? [];
    this.onTimeout = options.onTimeout;
    this.isIgnorableRule = options.isIgnorableRule ?? (() => true);
    this.countsItems = options.messageCountsItems ?? (() => false);
    const total = { left: options.limits?.perAudit ?? MAX_STEPS_PER_AUDIT, compile: { left: options.limits?.compile ?? MAX_COMPILE_WORK_PER_TABLE } };
    (entries ?? []).forEach((entry, index) => {
      if (index >= MAX_ENTRIES) {
        if (index === MAX_ENTRIES) this.problems.push({ entry: index, field: "rule", pattern: entry.rule, message: `more than ${MAX_ENTRIES} entries: the rest are not applied` });
        return;
      }
      const budget: EntryBudget = { left: options.limits?.perEntry ?? MAX_STEPS_PER_ENTRY, dead: false, metered: false, total };
      const refused = (field: IgnoreMatcherProblem["field"], pattern: string, message: string) => {
        this.problems.push({ entry: index, field, pattern, message });
      };
      // Like the config schema's superRefine, enforced here for entries that never went
      // through it: an entry with no items and no urls (a bare rule, `checks` alone,
      // empty arrays) would waive everything the rule finds.
      if ((entry.items?.length ?? 0) === 0 && (entry.urls?.length ?? 0) === 0) {
        refused("rule", entry.rule, "an entry needs `items` or `urls`: without either it would waive every finding of the rule, so it is not applied");
        return;
      }
      for (const field of ["items", "urls", "checks"] as const) {
        if ((entry[field]?.length ?? 0) > MAX_MATCHERS_PER_FIELD) {
          refused(field, `${entry[field]!.length} patterns`, `more than ${MAX_MATCHERS_PER_FIELD} patterns in one entry: the entry is not applied`);
          return;
        }
      }
      const items: TextMatcher[] = [];
      for (const pattern of entry.items ?? []) {
        const m = compileTextMatcher(pattern, budget);
        if (typeof m === "string") refused("items", pattern, m);
        else items.push(m);
      }
      const checks: TextMatcher[] = [];
      for (const pattern of entry.checks ?? []) {
        const m = compileTextMatcher(pattern, budget);
        if (typeof m === "string") refused("checks", pattern, m);
        else checks.push(m);
      }
      const urls: TextMatcher[] = [];
      for (const pattern of entry.urls ?? []) {
        const m = compileUrlMatcher(pattern, budget);
        if (typeof m === "string") refused("urls", pattern, m);
        else urls.push(m);
      }
      // An entry that lost every matcher of a kind it named would waive too much,
      // so it is not applied at all (its problems are reported).
      if ((entry.items?.length ?? 0) > 0 && items.length === 0) return;
      if ((entry.urls?.length ?? 0) > 0 && urls.length === 0) return;
      if ((entry.checks?.length ?? 0) > 0 && checks.length === 0) return;
      this.compiled.push({
        index,
        entry,
        rule: ruleMatcher(entry.rule),
        ...(entry.checks && checks.length > 0 ? { checks } : {}),
        ...(items.length > 0 ? { items } : {}),
        urls,
        budget,
      });
    });
  }

  get empty(): boolean {
    return this.compiled.length === 0;
  }

  /** The entries that name `ruleId` (and may waive it: a non-ignorable rule has none). */
  forRule(ruleId: string): readonly CompiledEntry[] {
    let list = this.byRule.get(ruleId);
    if (!list) {
      list = this.isIgnorableRule(ruleId) ? this.compiled.filter((c) => c.rule(ruleId)) : [];
      this.byRule.set(ruleId, list);
    }
    return list;
  }

  /** Indexes of the entries that stopped waiving after running over their work budget (for the report). */
  timedOutEntries(): number[] {
    return this.timedOut.map((t) => t.entry);
  }

  /** Whether an entry naming `ruleId` depends on the page (it has `urls`): such a rule's verdict is not a property of its template. */
  hasUrlEntries(ruleId: string): boolean {
    return this.forRule(ruleId).some((c) => c.urls.length > 0);
  }

  /**
   * The entries that touch `ruleId`, in a form fit for a cache key: editing an
   * entry changes only the rules it names. Stable JSON of the entry's fields.
   */
  signatureFor(ruleId: string): string | null {
    const list = this.forRule(ruleId);
    if (list.length === 0) return null;
    return JSON.stringify(list.map((c) => [c.index, c.entry.rule, c.entry.checks ?? null, c.entry.items ?? null, c.entry.urls ?? null, c.entry.reason ?? null]));
  }

  /**
   * The entry that waives `ruleId` on this page outright (urls only, no items or
   * checks), or null. A page-scope rule is then not run on the page.
   */
  pageWaiver(ruleId: string, pageUrl: string): number | null {
    for (const c of this.forRule(ruleId)) {
      if (c.items || c.checks || c.urls.length === 0) continue;
      if (this.matchesUrls(c, pageUrl)) return c.index;
    }
    return null;
  }

  /** Whether any url matcher of the entry matches `page`, then notes an entry whose work budget just ran out. */
  private matchesUrls(c: CompiledEntry, page: string): boolean {
    const hit = c.urls.some((m) => m(page));
    this.noteTimeout(c);
    return hit;
  }

  /**
   * Report entries that ran out of regex work (once each). Fails closed: from here
   * they waive nothing. When the audit-wide budget is spent every entry is dead,
   * not just the one that took the last step, and each is reported.
   */
  private noteTimeout(c: CompiledEntry): void {
    // Only an entry with a regex or glob matcher depends on the budget (an exact-only entry
    // keeps waiving and is never reported), and only once it has been consulted: reported
    // when its own matchers answered "no" because the entry's or the audit's work ran out.
    if (!c.budget.metered || (!c.budget.dead && c.budget.total.left > 0)) return;
    c.budget.dead = true;
    if (this.timedOut.some((t) => t.entry === c.index)) return;
    const message = `[[ignore]] entry ${c.index + 1} (${c.entry.rule}) timed out: its regex or glob patterns ran over their work budget and stop matching (exact items still apply), so the findings they would hide stay`;
    this.timedOut.push({ entry: c.index, message });
    this.onTimeout?.(message, c.index);
  }

  /** The visible skipped check emitted in place of a rule run on a waived page. */
  waivedPageCheck(ruleId: string, entryIndex: number): CheckResult {
    const reason = this.entries[entryIndex]?.reason;
    return {
      name: ruleId,
      status: "skipped",
      message: `Skipped: this page is ignored for this rule by squirrel.toml${reason ? ` (${reason})` : ""}`,
      skipReason: IGNORED_SKIP_REASON,
      // Folds apart from any other skip of the same rule, like the noindex gate.
      details: { foldKey: IGNORED_SKIP_REASON, ignored: { pages: 1, entries: [entryIndex] } satisfies IgnoredDetails },
    };
  }

  /**
   * Apply the waivers that name `ruleId` to the checks it returned for `pageUrl`
   * (the page of a page rule; undefined for a site rule). Returns the same array
   * when nothing was waived.
   */
  filterChecks(ruleId: string, pageUrl: string | undefined, checks: CheckResult[]): CheckResult[] {
    const entries = this.forRule(ruleId);
    if (entries.length === 0) return checks;
    let changed = false;
    const out = checks.map((check) => {
      const next = this.filterCheck(ruleId, entries, pageUrl, check);
      if (next !== check) changed = true;
      return next;
    });
    return changed ? out : checks;
  }

  private filterCheck(
    ruleId: string,
    entries: readonly CompiledEntry[],
    pageUrl: string | undefined,
    check: CheckResult,
  ): CheckResult {
    if (check.status === "skipped" || check.status === "pass") return check;
    const applicable = entries.filter((c) => {
      if (!c.checks) return true;
      const hit = c.checks.some((m) => m(check.name));
      this.noteTimeout(c);
      return hit;
    });
    if (applicable.length === 0) return check;
    const checkPage = check.pageUrl ?? pageUrl;

    const touched = new Set<number>();
    let removedItems = 0;
    let removedPages = 0;

    if (check.items && check.items.length > 0) {
      const remaining: CheckItem[] = [];
      for (const item of check.items) {
        let current: CheckItem | null = item;
        for (const c of applicable) {
          if (!current) break;
          const result = this.applyToItem(c, current, checkPage);
          if (result === current) continue;
          touched.add(c.index);
          if (result === null) {
            removedItems++;
            current = null;
          } else {
            removedPages += (current.sourcePages?.length ?? 0) - (result.sourcePages?.length ?? 0);
            current = result;
          }
        }
        if (current) remaining.push(current);
      }
      if (touched.size === 0) return check;
      const ignored: IgnoredDetails = {
        ...(removedItems > 0 ? { items: removedItems } : {}),
        ...(removedPages > 0 ? { pages: removedPages } : {}),
        entries: [...touched].sort((a, b) => a - b),
      };
      const details = { ...(check.details ?? {}), ignored };
      if (remaining.length === 0) {
        // Everything this check found is waived: the rule ran and nothing actionable
        // is left, so it reads as a pass that says how much was waived.
        const { items: _items, pages: _pages, componentOccurrences: _c, componentEvidence: _ce, siteResourceOccurrences: _s, siteResourceEvidence: _se, ...rest } = check;
        return {
          ...rest,
          status: "pass",
          message: `${removedItems} waived by squirrel.toml: ${check.message}`,
          details,
        };
      }
      // Some items remain: the check keeps its status. Its message was built from the
      // full list, so say what was left out (and fix the count where the rule's
      // message starts with it).
      const base = this.countsItems(ruleId) ? check.message.replace(/\d+/, String(remaining.length)) : check.message;
      const waived = removedItems + removedPages;
      // Evidence that still counted the waived items must not outlive them: the additive
      // element and resource evidence is dropped (reports then group from `items`), and the
      // page list keeps only pages a remaining item sits on.
      const { componentOccurrences: _c, componentEvidence: _ce, siteResourceOccurrences: _s, siteResourceEvidence: _se, ...kept } = check;
      const pageSet = remaining.every((i) => i.sourcePages && i.sourcePages.length > 0)
        ? new Set(remaining.flatMap((i) => i.sourcePages!))
        : null;
      const pages = check.pages && pageSet ? check.pages.filter((p) => pageSet.has(p)) : check.pages;
      return { ...kept, ...(pages ? { pages } : {}), items: remaining, message: `${base} (${waived} ignored)`, details };
    }

    // A check without items is waived whole only for a page waiver (urls, no items) that matches its page.
    if (checkPage !== undefined) {
      for (const c of applicable) {
        if (c.items || c.urls.length === 0) continue;
        if (this.matchesUrls(c, checkPage)) {
          return {
            name: check.name,
            status: "skipped",
            message: `Skipped: this page is ignored for this check by squirrel.toml${c.entry.reason ? ` (${c.entry.reason})` : ""}`,
            skipReason: IGNORED_SKIP_REASON,
            ...(check.pageUrl ? { pageUrl: check.pageUrl } : {}),
            details: { foldKey: IGNORED_SKIP_REASON, ignored: { pages: 1, entries: [c.index] } satisfies IgnoredDetails },
          };
        }
      }
    }
    return check;
  }

  /** The item after one entry: unchanged (same object), narrowed (fewer source pages) or null (waived). */
  private applyToItem(c: CompiledEntry, item: CheckItem, checkPage: string | undefined): CheckItem | null {
    if (c.items) {
      const hit = c.items.some((m) => m(item.id) || (item.label !== undefined && m(item.label)));
      this.noteTimeout(c);
      if (!hit) return item;
    }
    if (c.urls.length === 0) return null;
    // Items AND urls: waived where the item sits on a matching page.
    if (item.sourcePages && item.sourcePages.length > 0) {
      const keep = item.sourcePages.filter((page) => !this.matchesUrls(c, page));
      if (keep.length === item.sourcePages.length) return item;
      if (keep.length === 0) return null;
      return { ...item, sourcePages: keep, ...(item.sources ? { sources: item.sources.filter((s) => keep.includes(s.page)) } : {}) };
    }
    if (checkPage !== undefined && this.matchesUrls(c, checkPage)) return null;
    return item;
  }
}
