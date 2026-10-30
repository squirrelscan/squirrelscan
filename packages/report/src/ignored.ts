// `[[ignore]]` waivers in a report (#1262): the summary a report carries and the
// lines every renderer prints from it. Nothing waived is dropped silently: a
// report says that findings were ignored, how many, by which entries (with their
// reasons), and which entries matched nothing.
//
// The stored report is untrusted input (a slim JSON file, a cloud report), so
// every field is validated and every string stripped of control characters and
// bounded before it reaches a renderer.

import type { AuditReport, CheckResult } from "@squirrelscan/core-contracts";
import { stripControlChars } from "@squirrelscan/core-contracts/control-chars";
import {
  readIgnoredDetails,
  type IgnoredEntrySummary,
  type IgnoreSummary,
} from "@squirrelscan/core-contracts/ignore";

const MAX_TEXT = 120;
const MAX_ENTRIES = 200;
const MAX_RULES = 500;

const clean = (value: unknown, max = MAX_TEXT): string =>
  stripControlChars(typeof value === "string" ? value : "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * The summary for an audit: what the waivers removed (read from `details.ignored`
 * on the checks the engine changed) joined with the config's entries as the audit
 * ran them. Undefined when the config had no waivers and nothing was waived.
 */
export function summarizeIgnored(
  checksByRule: Iterable<[string, readonly CheckResult[]]>,
  scope?: { entries: Array<{ rule: string; reason?: string }>; disabled?: boolean; timedOut?: number[]; carriedStale?: boolean },
): IgnoreSummary | undefined {
  const entries: IgnoredEntrySummary[] = (scope?.entries ?? []).slice(0, MAX_ENTRIES).map((e, index) => ({
    index,
    rule: clean(e.rule),
    ...(e.reason ? { reason: clean(e.reason, 200) } : {}),
    items: 0,
    pages: 0,
  }));
  const byRule: IgnoreSummary["byRule"] = {};
  let items = 0;
  let pages = 0;
  for (const [ruleId, checks] of checksByRule) {
    for (const check of checks) {
      const ignored = readIgnoredDetails(check.details);
      if (!ignored) continue;
      items += ignored.items ?? 0;
      pages += ignored.pages ?? 0;
      const slot = (byRule[ruleId] ??= { items: 0, pages: 0 });
      slot.items += ignored.items ?? 0;
      slot.pages += ignored.pages ?? 0;
      // An entry that took part is credited once per check, with the check's whole count
      // when one entry did it and an even share when several did.
      const share = Math.max(ignored.entries.length, 1);
      for (const index of ignored.entries) {
        const entry = entries[index];
        if (!entry) continue;
        entry.items += Math.round((ignored.items ?? 0) / share);
        entry.pages += Math.round((ignored.pages ?? 0) / share);
      }
    }
  }
  if (entries.length === 0 && items === 0 && pages === 0 && !scope?.disabled) return undefined;
  const timedOutEntries = (scope?.timedOut ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < entries.length).slice(0, MAX_ENTRIES);
  return {
    items,
    pages,
    byRule,
    entries,
    ...(scope?.disabled ? { disabled: true as const } : {}),
    ...(timedOutEntries.length > 0 ? { timedOutEntries } : {}),
    ...(scope?.carriedStale === true ? { carriedStale: true as const } : {}),
  };
}

/** The summary of a report, validated, or null. */
export function safeIgnored(report: Pick<AuditReport, "ignored">): IgnoreSummary | null {
  const raw = report.ignored;
  if (!raw || typeof raw !== "object") return null;
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const entries: IgnoredEntrySummary[] = Array.isArray(raw.entries)
    ? raw.entries.slice(0, MAX_ENTRIES).map((e, i) => ({
        index: Number.isInteger(e?.index) ? e.index : i,
        rule: clean(e?.rule),
        ...(e?.reason ? { reason: clean(e.reason, 200) } : {}),
        items: count(e?.items),
        pages: count(e?.pages),
      }))
    : [];
  const byRule: IgnoreSummary["byRule"] = {};
  for (const [id, v] of Object.entries(raw.byRule ?? {}).slice(0, MAX_RULES)) {
    byRule[clean(id, 80)] = { items: count(v?.items), pages: count(v?.pages) };
  }
  return {
    items: count(raw.items),
    pages: count(raw.pages),
    byRule,
    entries,
    ...(raw.disabled === true ? { disabled: true as const } : {}),
    ...(raw.carriedStale === true ? { carriedStale: true as const } : {}),
    ...(Array.isArray(raw.timedOutEntries)
      ? {
          // Zero-based indexes into `entries`, like `entries[].index`; the line prints them one-based.
          timedOutEntries: [...new Set(raw.timedOutEntries)]
            .filter((i): i is number => Number.isInteger(i) && i >= 0 && i < entries.length)
            .slice(0, MAX_ENTRIES),
        }
      : {}),
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The scan-details line: `Ignored by squirrel.toml: 3 findings and 5 pages on 2 rules
 * (2 of 3 entries matched).` Null when the config has no waivers.
 */
export function ignoredLine(report: Pick<AuditReport, "ignored">): string | null {
  const s = safeIgnored(report);
  if (!s) return null;
  if (s.disabled) {
    return `Ignore entries are off for this run (--no-ignore): ${plural(s.entries.length, "entry", "entries")} in squirrel.toml were not applied.`;
  }
  const rules = Object.keys(s.byRule).length;
  const matched = s.entries.filter((e) => e.items > 0 || e.pages > 0).length;
  const parts: string[] = [];
  if (s.items > 0) parts.push(plural(s.items, "finding", "findings"));
  if (s.pages > 0) parts.push(plural(s.pages, "page", "pages"));
  const what = parts.length > 0 ? `${parts.join(" and ")} on ${plural(rules, "rule", "rules")}` : "nothing";
  const entryNote = s.entries.length > 0 ? ` (${matched} of ${plural(s.entries.length, "entry", "entries")} matched)` : "";
  const stale = s.carriedStale
    ? " The ignore list changed since the last audit, and findings carried from pages this run did not crawl may still include waived items: re-run without a page limit or with --refresh."
    : "";
  const timedOut =
    s.timedOutEntries && s.timedOutEntries.length > 0
      ? ` ${plural(s.timedOutEntries.length, "entry", "entries")} (${s.timedOutEntries.map((i) => i + 1).join(", ")}) timed out on a pattern, which stopped matching partway through, so some findings it would have hidden are shown: simplify the regex.`
      : "";
  return `Ignored by squirrel.toml: ${what}${entryNote}. Run with --no-ignore to see them.${stale}${timedOut}`;
}

/** One line per entry for verbose output: its rule, its reason, what it waived. */
export function ignoredEntryLines(report: Pick<AuditReport, "ignored">): string[] {
  const s = safeIgnored(report);
  if (!s || s.disabled) return [];
  return s.entries.map((e) => {
    const waived: string[] = [];
    if (e.items > 0) waived.push(plural(e.items, "finding", "findings"));
    if (e.pages > 0) waived.push(plural(e.pages, "page", "pages"));
    const did = waived.length > 0 ? waived.join(" and ") : "matched nothing";
    return `Ignore entry ${e.index + 1} (${e.rule})${e.reason ? `, ${e.reason}` : ""}: ${did}`;
  });
}

/** The entries that waived nothing: the guard against a waiver that quietly stopped matching. */
export function unusedIgnoreEntries(report: Pick<AuditReport, "ignored">): IgnoredEntrySummary[] {
  const s = safeIgnored(report);
  if (!s || s.disabled) return [];
  return s.entries.filter((e) => e.items === 0 && e.pages === 0);
}
