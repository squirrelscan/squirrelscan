// Report-specific constants

// Grouping key separator (null byte - cannot appear in strings)
export const KEY_SEPARATOR = "\x00";

// Bump on any HTML renderer/CSS change (output/html.tsx) — the API folds this
// into the cached-HTML R2 key, so a bump invalidates cached reports (re-render on next view).
export const REPORT_HTML_VERSION = 12;

// Report output constants
export const REPORT_COLLAPSE_THRESHOLD = 3;
export const REPORT_ITEMS_COLLAPSE_THRESHOLD = 5;
// #1136: an opened "N pages affected" list shows this many links inline; the
// rest sit behind a nested "show all N" details so a 600-page rule doesn't
// dump 600 links the instant a reader expands the summary.
export const REPORT_PAGES_INLINE_CAP = 50;
// #1136: HARD ceiling on how many page URLs a single check materializes into
// the report HTML at all (inline + nested "more" + the copy textarea
// combined never exceed this). A public report on a large site can have a
// check affecting thousands of pages — without this, the "cap" above is only
// an initial-display cap: the nested details and the copy textarea would
// still embed every one of them, duplicated, blowing up the served HTML's
// size and parse/layout cost. Pages beyond this are disclosed as truncated,
// never silently dropped.
export const REPORT_PAGES_HARD_CAP = 200;
export const REPORT_TEXT_WRAP_WIDTH = 70;
export const REPORT_SOURCE_PAGES_PREVIEW = 3;
