/**
 * What a `[[ignore]]` waiver (#1262) leaves in a result and in a report.
 *
 * The engine drops waived items before a finding is counted, and says so: each
 * affected check carries {@link IgnoredDetails} in `details.ignored` (`details`
 * is already persisted with a check, so a replayed or rebuilt result keeps it),
 * and a report carries one {@link IgnoreSummary}. Nothing is dropped silently.
 *
 * Leaf module, no imports.
 */

/** The `skipReason` of a check skipped because its page is waived for the rule. */
export const IGNORED_SKIP_REASON = "ignored";

/** `details.ignored` on a check the engine changed. */
export interface IgnoredDetails {
  /** Items removed from the check. */
  items?: number;
  /** Pages waived: the rule skipped on a page, or pages removed from an item's `sourcePages`. */
  pages?: number;
  /** Indexes into the config's `[[ignore]]` list that did it. */
  entries: number[];
}

/** One `[[ignore]]` entry as a report describes it. */
export interface IgnoredEntrySummary {
  /** Position in the config's `[[ignore]]` list (0-based). */
  index: number;
  rule: string;
  reason?: string;
  items: number;
  pages: number;
}

/** `report.ignored`: what the config's waivers removed from this audit. */
export interface IgnoreSummary {
  /** Waived items across the audit. */
  items: number;
  /** Waived pages across the audit. */
  pages: number;
  /** Waived items and pages per rule id. */
  byRule: Record<string, { items: number; pages: number }>;
  /** Every entry, with what it waived; one that waived nothing has zeros. */
  entries: IgnoredEntrySummary[];
  /** The audit ran with `--no-ignore`: the table was present and not applied. */
  disabled?: boolean;
  /**
   * The `[[ignore]]` list changed since the previous audit of this project, and this
   * one carried findings forward from pages it did not crawl. Those were recorded under
   * the old list and may include items the new list waives.
   */
  carriedStale?: boolean;
  /** Entries (indexes) that ran over their regex work budget and stopped waiving: their findings were NOT ignored from that point. */
  timedOutEntries?: number[];
}

/** `details.ignored` of a check, validated, or null. Untrusted: a stored or published report may hold anything. */
export function readIgnoredDetails(details: unknown): IgnoredDetails | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as { ignored?: unknown }).ignored;
  if (typeof raw !== "object" || raw === null) return null;
  const { items, pages, entries } = raw as Record<string, unknown>;
  const count = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  const list = Array.isArray(entries)
    ? entries.filter((n): n is number => Number.isInteger(n) && n >= 0).slice(0, 200)
    : [];
  const out: IgnoredDetails = { entries: list };
  if (count(items) > 0) out.items = count(items);
  if (count(pages) > 0) out.pages = count(pages);
  return out.items === undefined && out.pages === undefined ? null : out;
}
