// Category-grouped issues derived from rule results

import type { ReportRuleResult, CheckItem, CheckResult } from "./types";
import { KEY_SEPARATOR } from "./constants";
import { checkOccurrences } from "./occurrences";
import { checkAffectedPages } from "./affected-pages";
import { ruleMixedProvenanceNote, type MixedProvenanceCheck } from "./coverage";
import {
  isValidCategory,
  getCategoryName,
  getCategoryPriority,
  getCategoryGroup,
  getGroupName,
  getSubcategoryPriority,
  normalizeCategoryCode,
  deriveBlockingSubcategory,
  GROUP_CODES,
  OTHER_CATEGORY,
} from "./categories";

export interface GroupedCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "info" | "skipped";
  message: string;
  count: number;
  pages: string[];

  // Structured data (preferred)
  items?: CheckItem[];
  details?: Record<string, unknown>;

  // Legacy field (deprecated)
  value?: string;

  // Smart audits (#110): provenance of the merged checks. `carriedCount` =
  // merged checks that were carried forward (page not re-crawled this run);
  // `lastSeenAt` = most-recent epoch ms a carried instance was last observed.
  // Set only when `smart_audits` produced carried findings.
  carriedCount?: number;
  lastSeenAt?: number;
  // #1135: subset of this check's AFFECTED pages (pages + item.sourcePages /
  // page-URL item ids — same union as checkAffectedPages, NOT just `pages`)
  // that came from a carried (not re-crawled) check instance — lets renderers
  // tag individual affected-page rows as carried vs fresh instead of only a
  // check-level aggregate. Provenance is stamped per check BEFORE this merge,
  // so a page's membership here is exact (not inferred from the
  // carriedCount/count ratio).
  carriedPages?: string[];
}

export interface GroupedRule {
  id: string;
  name: string;
  description: string;
  solution?: string;
  severity: "error" | "warning" | "info";
  weight: number;
  /** Optional sub-group within the category (e.g. blocking → "ad" | "privacy"). */
  subcategory?: string;
  checks: GroupedCheck[];
  failCount: number;
  warnCount: number;
  // #1135: set when this rule passed fresh on every page checked this run but
  // still shows red only from pages carried forward (not re-crawled) — e.g.
  // "Fixed on all 75 pages checked this run; 28 pages pending re-check."
  mixedProvenanceNote?: string;
}

export interface GroupedCategory {
  code: string;
  name: string;
  /** Top-level group this category rolls up into (#626), e.g. "seo". */
  group: string;
  rules: GroupedRule[];
  failCount: number;
  warnCount: number;
}

/** A top-level group with its member categories (#626), for group → category → rules rendering. */
export interface GroupedGroup {
  code: string;
  name: string;
  categories: GroupedCategory[];
  failCount: number;
  warnCount: number;
}

/**
 * Sort rank for a rule's effective severity within a category: errors lead,
 * then recommendations (info), then warnings — product ordering is
 * "Error, Recommendation, Warning" top to bottom (info displays as
 * "Recommendation" in human renderers, see categories.ts `severityLabel`).
 */
const RULE_SEVERITY_RANK: Record<"error" | "info" | "warning", number> = {
  error: 0,
  info: 1,
  warning: 2,
};

/**
 * Group rule results by category for display
 * Only includes rules with issues (fail or warn)
 *
 * Accepts both Map and Record for compatibility with CLI and API.
 */
export function groupIssuesByCategory(
  ruleResults:
    | Record<string, ReportRuleResult>
    | Record<string, { meta: Record<string, unknown>; checks: Array<Record<string, unknown>> }>
    | Map<string, ReportRuleResult>
): GroupedCategory[] {
  const categoryMap = new Map<string, GroupedRule[]>();
  const entries =
    ruleResults instanceof Map
      ? ruleResults.entries()
      : Object.entries(ruleResults);

  for (const [ruleId, result] of entries) {
    const meta = result.meta as {
      category: string;
      subcategory?: string;
      name: string;
      description: string;
      solution?: string;
      severity: string;
      weight: number;
    };
    // Normalize legacy category codes (e.g. stored "adblock" → "blocking").
    const category = normalizeCategoryCode(meta.category);
    const categoryKey = isValidCategory(category) ? category : OTHER_CATEGORY;

    // Aggregate checks by name + status + normalized message
    // Normalize by replacing numbers so per-page counts don't prevent grouping
    // e.g. "Thin content: 233 words (min 300)" and "Thin content: 197 words (min 300)"
    // both normalize to "Thin content: # words (min #)" → same group
    const checkMap = new Map<
      string,
      GroupedCheck & { pageSet: Set<string>; itemSet: Set<string>; carriedPageSet: Set<string> }
    >();
    // #1135: the "fixed on all pages checked this run" note reads every
    // status (pass included), not just fail/warn — computed via the SAME
    // shared helper used by hosted report summaries as well. One implementation
    // in packages/report/src/coverage.ts backs both surfaces. The loose
    // `ruleResults` union this function accepts
    // (Map/Record, possibly untyped checks) is why this needs one cast —
    // same idiom as every other field read in this loop.
    const mixedProvenanceNote = ruleMixedProvenanceNote(
      result.checks as unknown as MixedProvenanceCheck[],
    );
    for (const check of result.checks) {
      const status = (check as { status: string }).status;
      const pageUrl = (check as { pageUrl?: string }).pageUrl;
      // Folded aggregate checks (#910) and site-scope checks carry their
      // affected pages in `pages` instead of a single pageUrl.
      const checkPages = (check as { pages?: string[] }).pages ?? [];
      const items = (check as { items?: CheckItem[] }).items;
      const isCarried = (check as { provenance?: string }).provenance === "carried";

      if (status !== "fail" && status !== "warn") continue;

      // #1135: affected pages for THIS check (pages + item.sourcePages /
      // page-URL item ids — the SAME definition ruleAffectedPageCount uses)
      // so a carried site-scope check (blocked-links, duplicate-title,
      // sitemap-*) whose pages live under `items` isn't undercounted in
      // GroupedCheck.carriedPages relative to the rule's total affected count.
      const allPages = checkAffectedPages({ pages: checkPages, items });
      if (pageUrl) allPages.add(pageUrl);

      const checkName = (check as { name: string }).name;
      const checkMessage = (check as { message: string }).message;
      const normalizedMessage = checkMessage.replace(/\d+/g, "#");

      const key = `${checkName}${KEY_SEPARATOR}${status}${KEY_SEPARATOR}${normalizedMessage}`;
      const existing = checkMap.get(key);

      const details = (check as { details?: Record<string, unknown> }).details;
      // A folded aggregate check (#910) stands in for `details.occurrences`
      // per-page checks — count them all so "×N" badges stay truthful.
      const occurrences = checkOccurrences({ details });
      const checkLastSeen = (check as { lastSeenAt?: number }).lastSeenAt;

      // When message contains numbers that differ per page, auto-generate
      // an item to preserve per-page detail (only if check has no explicit items)
      const messageWasNormalized = normalizedMessage !== checkMessage;
      const autoItem =
        messageWasNormalized && pageUrl && !items?.length
          ? { id: pageUrl, label: checkMessage }
          : undefined;

      if (existing) {
        existing.count += occurrences;
        if (isCarried) {
          existing.carriedCount = (existing.carriedCount ?? 0) + occurrences;
          if (checkLastSeen !== undefined) {
            existing.lastSeenAt = Math.max(
              existing.lastSeenAt ?? 0,
              checkLastSeen
            );
          }
        }
        // When merging checks whose original messages differ, use generic form
        if (existing.message !== checkMessage && messageWasNormalized) {
          existing.message = normalizedMessage.replace(/#/g, "N");
        }
        if (pageUrl && !existing.pageSet.has(pageUrl)) {
          existing.pages.push(pageUrl);
          existing.pageSet.add(pageUrl);
        }
        for (const page of checkPages) {
          if (!existing.pageSet.has(page)) {
            existing.pages.push(page);
            existing.pageSet.add(page);
          }
        }
        if (isCarried) {
          for (const page of allPages) {
            if (!existing.carriedPageSet.has(page)) {
              existing.carriedPages = existing.carriedPages ?? [];
              existing.carriedPages.push(page);
              existing.carriedPageSet.add(page);
            }
          }
        }
        // Merge explicit items
        if (items) {
          for (const item of items) {
            if (!existing.itemSet.has(item.id)) {
              existing.items = existing.items ?? [];
              existing.items.push(item);
              existing.itemSet.add(item.id);
            }
          }
        }
        // Merge auto-generated item from per-page message
        if (autoItem && !existing.itemSet.has(autoItem.id)) {
          existing.items = existing.items ?? [];
          existing.items.push(autoItem);
          existing.itemSet.add(autoItem.id);
        }
        if (details) {
          existing.details = { ...existing.details, ...details };
        }
      } else {
        const initialItems: CheckItem[] = items ? [...items] : [];
        const initialItemIds = new Set(initialItems.map((i) => i.id));
        // Add auto-generated item if not already covered by explicit items
        if (autoItem && !initialItemIds.has(autoItem.id)) {
          initialItems.push(autoItem);
          initialItemIds.add(autoItem.id);
        }
        const initialPages = pageUrl ? [pageUrl] : [];
        const initialPageSet = new Set(initialPages);
        for (const page of checkPages) {
          if (!initialPageSet.has(page)) {
            initialPages.push(page);
            initialPageSet.add(page);
          }
        }
        const initialCarriedPages = isCarried ? [...allPages] : [];
        const initialCarriedPageSet = new Set(initialCarriedPages);
        checkMap.set(key, {
          name: checkName,
          status: status as "fail" | "warn",
          message: checkMessage,
          count: occurrences,
          pages: initialPages,
          pageSet: initialPageSet,
          items: initialItems.length > 0 ? initialItems : undefined,
          itemSet: initialItemIds,
          carriedPages: initialCarriedPages.length > 0 ? initialCarriedPages : undefined,
          carriedPageSet: initialCarriedPageSet,
          details: details ? { ...details } : undefined,
          value: typeof (check as { value?: unknown }).value === "string"
            ? (check as { value: string }).value
            : undefined,
          carriedCount: isCarried ? occurrences : undefined,
          lastSeenAt: isCarried ? checkLastSeen : undefined,
        });
      }
    }

    // Strip internal Sets before output. Sort each check's pages/items by a
    // stable key so repeat audits emit affected-URL lists in identical order
    // (#150) — #114's bounded-concurrency rule execution otherwise leaves them
    // in nondeterministic insertion order, churning report diffs run-to-run.
    const checks = Array.from(checkMap.values()).map(
      ({ pageSet: _, itemSet: __, carriedPageSet: ___, ...check }) => {
        check.pages = [...check.pages].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        if (check.items) {
          check.items = [...check.items].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0
          );
        }
        if (check.carriedPages) {
          check.carriedPages = [...check.carriedPages].sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0
          );
        }
        return check;
      }
    );
    // Order the checks themselves deterministically too: checkMap preserves
    // first-seen insertion order, which depends on rule-execution order (#114),
    // so without this the per-rule check list still churns run-to-run (#150).
    checks.sort((a, b) => {
      const nameDiff = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      if (nameDiff !== 0) return nameDiff;
      const statusDiff =
        a.status < b.status ? -1 : a.status > b.status ? 1 : 0;
      if (statusDiff !== 0) return statusDiff;
      return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
    });
    const failCount = checks
      .filter((c) => c.status === "fail")
      .reduce((sum, c) => sum + c.count, 0);
    const warnCount = checks
      .filter((c) => c.status === "warn")
      .reduce((sum, c) => sum + c.count, 0);

    if (failCount === 0 && warnCount === 0) continue;

    // Effective severity derives from what actually happened: the rule's
    // meta severity only applies when a check failed. A rule with
    // severity "error" whose checks all came back "warn" is a warning —
    // reporting it as an error misstates the audit result.
    const metaSeverity = meta.severity as "error" | "warning" | "info";
    const severity: "error" | "warning" | "info" =
      failCount > 0 ? metaSeverity : metaSeverity === "error" ? "warning" : metaSeverity;

    const rule: GroupedRule = {
      id: ruleId,
      name: meta.name,
      description: meta.description,
      solution: meta.solution,
      severity,
      weight: meta.weight,
      // Fall back to deriving the sub-group for legacy reports whose meta
      // predates the subcategory field.
      subcategory:
        meta.subcategory ??
        (categoryKey === "blocking" ? deriveBlockingSubcategory(ruleId) : undefined),
      checks,
      failCount,
      warnCount,
      mixedProvenanceNote,
    };

    const rules = categoryMap.get(categoryKey) || [];
    rules.push(rule);
    categoryMap.set(categoryKey, rules);
  }

  const categories: GroupedCategory[] = [];
  for (const [code, rules] of categoryMap) {
    const failCount = rules.reduce((sum, r) => sum + r.failCount, 0);
    const warnCount = rules.reduce((sum, r) => sum + r.warnCount, 0);

    // Cluster by subcategory (higher priority first) so sub-grouped renderers
    // can emit a header on change; rules without a subcategory keep pure
    // weight ordering (all share priority 0).
    categories.push({
      code,
      name: getCategoryName(code),
      group: getCategoryGroup(code),
      rules: rules.sort((a, b) => {
        // Severity leads (error → recommendation/info → warning), then the
        // existing subcategory/weight/id tiebreakers within each severity.
        const sevDiff = RULE_SEVERITY_RANK[a.severity] - RULE_SEVERITY_RANK[b.severity];
        if (sevDiff !== 0) return sevDiff;
        const subDiff =
          getSubcategoryPriority(b.subcategory ?? "") -
          getSubcategoryPriority(a.subcategory ?? "");
        if (subDiff !== 0) return subDiff;
        const weightDiff = b.weight - a.weight;
        if (weightDiff !== 0) return weightDiff;
        // Tie-break EQUAL-weight, equal-subcategory rules by id so repeat audits
        // emit rules in a stable order (#150). Weight/subcategory stay the
        // PRIMARY keys — id only breaks exact ties.
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }),
      failCount,
      warnCount,
    });
  }

  return categories.sort((a, b) => {
    // Severity leads (error → recommendation/info → warning, #1017), matching
    // the per-rule ordering above and cloud's category-score ordering: a
    // category's rules are already severity-sorted, so rules[0] IS its most
    // severe rule. Falls back to the topic-priority table, then category
    // code, as before.
    const aSev = RULE_SEVERITY_RANK[a.rules[0].severity];
    const bSev = RULE_SEVERITY_RANK[b.rules[0].severity];
    if (aSev !== bSev) return aSev - bSev;

    const aPri = getCategoryPriority(a.code);
    const bPri = getCategoryPriority(b.code);
    const priDiff = bPri - aPri;
    if (priDiff !== 0) return priDiff;
    // Tie-break equal-priority categories by code so repeat audits emit
    // categories in a stable order (#150). categoryMap preserves first-seen
    // insertion order, which follows nondeterministic rule iteration.
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}

/**
 * Bucket already-grouped categories into their top-level groups (#626), for
 * renderers that show a group → category → rules tree. Groups are emitted in
 * canonical display order (GROUP_CODES); categories keep their incoming order
 * (severity-then-priority-sorted by {@link groupIssuesByCategory}, #1017).
 * Only groups with at least one category are returned.
 */
export function groupCategoriesByGroup(
  categories: GroupedCategory[]
): GroupedGroup[] {
  const byGroup = new Map<string, GroupedCategory[]>();
  for (const category of categories) {
    const list = byGroup.get(category.group) ?? [];
    list.push(category);
    byGroup.set(category.group, list);
  }

  const groups: GroupedGroup[] = [];
  for (const code of GROUP_CODES) {
    const cats = byGroup.get(code);
    if (!cats || cats.length === 0) continue;
    groups.push({
      code,
      name: getGroupName(code),
      categories: cats,
      failCount: cats.reduce((sum, c) => sum + c.failCount, 0),
      warnCount: cats.reduce((sum, c) => sum + c.warnCount, 0),
    });
  }
  return groups;
}
