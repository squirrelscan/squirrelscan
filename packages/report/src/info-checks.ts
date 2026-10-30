// Info checks for the JSON and LLM reports (#669).
//
// A check with status `info` is a note, not a finding: it never fails or warns,
// so the grouped issue list (which keeps only fail and warn) drops it, and an
// agent reading the report could not see it or learn which pages it is about.
// This lists them on their own, next to the skipped checks, and they never
// change the score.

import type { ReportRuleResult } from "./types";

/** Pages listed per info check; `pagesCount` is the true number. */
export const INFO_CHECK_PAGES_LIMIT = 10;

/** Longest message kept; a rule's message can embed page content. */
export const INFO_CHECK_MESSAGE_LIMIT = 500;

function clip(message: string): string {
  return message.length > INFO_CHECK_MESSAGE_LIMIT
    ? `${message.slice(0, INFO_CHECK_MESSAGE_LIMIT)}...`
    : message;
}

export interface InfoCheck {
  ruleId: string;
  /** Rule display name. */
  name: string;
  /** Check name within the rule, e.g. "redundant-noindex". */
  check: string;
  /** The check's message; the first one seen when the same check repeats. */
  message: string;
  /** Pages the check is about: a sample when `pagesHasMore`. */
  pages: string[];
  /** Authoritative number of pages. */
  pagesCount: number;
  /** `pagesCount` > `pages.length`. */
  pagesHasMore: boolean;
}

/**
 * Info checks grouped by rule and check name, ordered by rule id then check
 * name, with sorted pages so the output is stable across runs. A per-page check
 * contributes its `pageUrl`; an aggregate contributes every page in `pages`.
 */
export function collectInfoChecks(ruleResults: Record<string, ReportRuleResult>): InfoCheck[] {
  const out: InfoCheck[] = [];
  for (const ruleId of Object.keys(ruleResults).sort()) {
    const result = ruleResults[ruleId];
    if (!result) continue;
    const groups = new Map<string, { message: string; pages: Set<string>; total: number }>();
    for (const check of result.checks) {
      if (check.status !== "info") continue;
      // The run-level summaries of a rule that timed out or threw (`<rule>-timeouts`,
      // `<rule>-errors`) are not notes about the site: the skipped rows already
      // report them, in `skippedChecks` and `notChecked`.
      if (check.name === `${ruleId}-errors` || check.name === `${ruleId}-timeouts`) continue;
      let group = groups.get(check.name);
      if (!group) {
        group = { message: check.message, pages: new Set(), total: 0 };
        groups.set(check.name, group);
      }
      const before = group.pages.size;
      if (check.pageUrl) group.pages.add(check.pageUrl);
      for (const page of check.pages ?? []) group.pages.add(page);
      const truncated = check.details?.pagesTruncated;
      const listed = group.pages.size - before;
      group.total +=
        typeof truncated === "number" && truncated > listed ? Math.floor(truncated) : listed;
    }
    for (const [check, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const all = [...g.pages].sort();
      const pages = all.slice(0, INFO_CHECK_PAGES_LIMIT);
      const total = Math.max(g.total, all.length);
      out.push({
        ruleId,
        name: result.meta.name,
        check,
        message: clip(g.message),
        pages,
        pagesCount: total,
        pagesHasMore: total > pages.length,
      });
    }
  }
  return out;
}
