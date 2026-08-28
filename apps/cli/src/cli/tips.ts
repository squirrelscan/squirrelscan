// One random tip per run, shown under the audit preamble. Pure UI chrome —
// see shouldShowTip() for when they're suppressed.

import { COVERAGE_FULL_MAX_PAGES } from "@/constants";

interface Tip {
  text: string;
  /**
   * Sells a plan. Only shown to an account that could actually act on it: a
   * paid account already has the feature, and an unmetered (enterprise) account
   * cannot buy a plan at all — pitching one there reads as a mis-sold upsell and
   * leaks an internal plan's existence into a promo.
   */
  sales?: boolean;
}

const ALL_TIPS: readonly Tip[] = [
  {
    text: "New rules ship all the time. `squirrel self update` gets you the latest.",
  },
  {
    text: "Give your coding agent audit superpowers: `squirrel mcp` is a full MCP server → docs.squirrelscan.com/developers/mcp",
  },
  {
    text: "Teach your agent to fix sites: `squirrel skills install` works with Claude Code, Cursor, Codex and friends.",
  },
  {
    text: "Something rough? Something great? `squirrel feedback` goes straight to the team.",
  },
  {
    text: `This scratches the surface. \`--coverage full\` goes deep: up to ${COVERAGE_FULL_MAX_PAGES} pages.`,
  },
  {
    text: "Big site? `--incremental` only re-crawls what changed since your last audit.",
  },
  {
    text: "Suspect stale pages? `--refresh` ignores the cache and fetches everything fresh.",
  },
  {
    text: '`--format llm` renders the report for agents: pipe it to Claude and say "fix it".',
  },
  {
    text: "The fix loop: audit, let your agent fix, re-audit → docs.squirrelscan.com/guides/fix-your-site-with-an-ai-agent",
  },
  {
    text: "Client-side rendered? Browser rendering audits what browsers (and Google) actually see → docs.squirrelscan.com/guides/browser-rendering",
  },
  {
    text: "Pro: scheduled cloud audits watch your sites while you sleep → docs.squirrelscan.com/cloud/scheduled-audits",
    // Sells a plan a paid account already has and an unmetered one can never buy.
    sales: true,
  },
  {
    text: "Tweaking config? `squirrel analyze` re-runs rules on the stored crawl. No re-crawl needed.",
  },
  {
    text: "`squirrel report list` shows every past audit. Re-render any of them in any format.",
  },
  {
    text: "Audit this site often? `squirrel init` writes a squirrel.toml so your flags become defaults.",
  },
  {
    text: "Run squirrel in CI: `squirrel keys create` mints an org API key → docs.squirrelscan.com/guides/ci",
  },
  {
    text: "Weird behavior? `squirrel self doctor` checks your install, auth, and connectivity.",
  },
  {
    text: "`squirrel credits` shows your balance and what each cloud feature costs. No surprises.",
  },
  {
    text: "Staging behind a login or bot wall? Send custom headers with the crawl → docs.squirrelscan.com/guides/web-bot-auth",
  },
  {
    text: "Robots read your site too. The ax rules score agent experience, not just SEO.",
  },
  {
    text: "Signed-in audits track every issue across runs in your dashboard. Regressions get caught.",
  },
] as const;

/** Every tip's text, in order. The visible surface, for tests and docs. */
export const TIPS: readonly string[] = ALL_TIPS.map((tip) => tip.text);

/**
 * Uniformly random tip. No rotation/persistence — every run is a fresh draw.
 *
 * `includeSales` defaults to FALSE: a plan pitch has to be opted into by a
 * caller that knows the account can act on it, so a caller which forgets to
 * pass the plan through shows no promo rather than the wrong one.
 */
export function pickTip(opts: { includeSales?: boolean } = {}): string {
  const pool = opts.includeSales
    ? ALL_TIPS
    : ALL_TIPS.filter((tip) => !tip.sales);
  return pool[Math.floor(Math.random() * pool.length)]!.text;
}

export interface TipVisibilityOptions {
  tipsEnabled: boolean;
  stderrIsTTY: boolean;
  isConsoleFormat: boolean;
  outputPath: string | undefined;
}

/**
 * Tips are for a human watching an interactive console run. Agents, CI, and
 * anything consuming a machine format or writing the report to a file must
 * never see them.
 */
export function shouldShowTip(options: TipVisibilityOptions): boolean {
  if (!options.tipsEnabled) return false;
  if (!options.stderrIsTTY) return false;
  if (!options.isConsoleFormat) return false;
  // Redundant with isConsoleFormat today (console never writes a file on its
  // own) — kept as a deliberate second guard, not dead logic, against a
  // future console+--output combination writing the report out.
  if (options.outputPath) return false;
  return true;
}

// "🐿️" occupies 2 terminal columns but its trailing variation selector
// (U+FE0F) is zero-width while still counting toward .length, so the label
// is padded by hand instead of the length-based `label.padEnd(10)` every
// other preamble row uses — that would under-pad this row by one column.
export function tipLabel(): string {
  // Respect NO_COLOR (https://no-color.org/) the same way banner.ts does —
  // the emoji prefix degrades to plain "Tip" alongside the rest of the
  // styled output. Read per-call (not cached at module load) so it reacts to
  // NO_COLOR changes within a process, e.g. in tests.
  const useEmoji = !process.env.NO_COLOR;
  return useEmoji ? "🐿️ Tip    " : "Tip".padEnd(10);
}
