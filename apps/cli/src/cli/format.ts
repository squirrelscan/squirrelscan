// Terminal formatting utilities with auto-detect color support

import { MAX_PAGES_CAP } from "@squirrelscan/core-contracts/limits";
import { SCORE_THRESHOLDS } from "@squirrelscan/core-contracts/scoring";

const USE_COLOR =
  process.stdout.isTTY && process.env.TERM !== "dumb" && !process.env.NO_COLOR;

// ANSI codes
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
} as const;

function wrap(text: string, code: string): string {
  return USE_COLOR ? `${code}${text}${ANSI.reset}` : text;
}

export const fmt = {
  bold: (s: string) => wrap(s, ANSI.bold),
  dim: (s: string) => wrap(s, ANSI.dim),
  red: (s: string) => wrap(s, ANSI.red),
  green: (s: string) => wrap(s, ANSI.green),
  yellow: (s: string) => wrap(s, ANSI.yellow),
  gray: (s: string) => wrap(s, ANSI.gray),
  cyan: (s: string) => wrap(s, ANSI.cyan),
};

export function icon(status: "pass" | "warn" | "fail" | "info"): string {
  switch (status) {
    case "pass":
      return fmt.green("✓");
    case "warn":
      return fmt.yellow("⚠");
    case "fail":
      return fmt.red("✗");
    case "info":
      return fmt.cyan("ℹ");
  }
}

export function scoreColor(score: number): (s: string) => string {
  if (score >= SCORE_THRESHOLDS.good) return fmt.green;
  if (score >= SCORE_THRESHOLDS.fair) return fmt.yellow;
  return fmt.red;
}

export function progressBar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return scoreColor(score)(bar);
}

export function truncateUrl(url: string, maxLen = 40): string {
  try {
    const u = new URL(url);
    let path = u.pathname;
    if (path.length <= maxLen) return path;
    return path.slice(0, maxLen - 3) + "...";
  } catch {
    if (url.length <= maxLen) return url;
    return url.slice(0, maxLen - 3) + "...";
  }
}

export function pathOnly(url: string): string {
  try {
    const u = new URL(url);
    return u.search ? `${u.pathname}${u.search}` : u.pathname;
  } catch {
    return url;
  }
}

/**
 * Build a one-line hint when a crawl stopped because it hit the page limit.
 * The page-cap override exists but is hard to discover (issue #124), so surface
 * it precisely when a user hits it. Returns `null` when the limit wasn't the
 * binding constraint, so callers can skip printing.
 *
 * Callers pass an already-computed `limitReached` (e.g. the crawl controller's
 * explicit flag, or `report.pages.length >= maxPages` for audits) so the
 * trigger matches each command's real stop condition.
 */
export function pageLimitHint(
  limitReached: boolean,
  maxPages: number
): string | null {
  if (!limitReached) return null;
  if (maxPages >= MAX_PAGES_CAP) {
    return `⚠ Reached the max pages cap (${MAX_PAGES_CAP}). This is the hard limit; split the audit by section (e.g. [crawler] include) to scan more.`;
  }
  return `⚠ Reached max pages (${maxPages}). Raise with --max-pages <N> or [crawler] max_pages (cap ${MAX_PAGES_CAP}); use -C full for full coverage.`;
}

export const divider = (char = "─", len = 50) => char.repeat(len);

export const box = {
  tl: "┌",
  bl: "└",
  v: "│",
  h: "─",
  header: (text: string) => `┌ ${text}`,
  line: (text: string) => `│ ${text}`,
  footer: (len = 48) => `└${"─".repeat(len)}`,
};
