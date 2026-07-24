// One random tip per run, shown under the audit preamble. Pure UI chrome —
// see shouldShowTip() for when they're suppressed.

import { COVERAGE_FULL_MAX_PAGES } from "@/constants";

export const TIPS: readonly string[] = [
  "New rules ship all the time. `squirrel self update` gets you the latest.",
  "Give your coding agent audit superpowers: `squirrel mcp` is a full MCP server → docs.squirrelscan.com/developers/mcp",
  "Teach your agent to fix sites: `squirrel skills install` works with Claude Code, Cursor, Codex and friends.",
  "Something rough? Something great? `squirrel feedback` goes straight to the team.",
  `This scratches the surface. \`--coverage full\` goes deep: up to ${COVERAGE_FULL_MAX_PAGES} pages.`,
  "Big site? `--incremental` only re-crawls what changed since your last audit.",
  "Suspect stale pages? `--refresh` ignores the cache and fetches everything fresh.",
  '`--format llm` renders the report for agents: pipe it to Claude and say "fix it".',
  "The fix loop: audit, let your agent fix, re-audit → docs.squirrelscan.com/guides/fix-your-site-with-an-ai-agent",
  "Client-side rendered? Browser rendering audits what browsers (and Google) actually see → docs.squirrelscan.com/guides/browser-rendering",
  "Pro: scheduled cloud audits watch your sites while you sleep → docs.squirrelscan.com/cloud/scheduled-audits",
  "Tweaking config? `squirrel analyze` re-runs rules on the stored crawl. No re-crawl needed.",
  "`squirrel report list` shows every past audit. Re-render any of them in any format.",
  "Audit this site often? `squirrel init` writes a squirrel.toml so your flags become defaults.",
  "Run squirrel in CI: `squirrel keys create` mints an org API key → docs.squirrelscan.com/guides/ci",
  "Weird behavior? `squirrel self doctor` checks your install, auth, and connectivity.",
  "`squirrel credits` shows your balance and what each cloud feature costs. No surprises.",
  "Staging behind a login or bot wall? Send custom headers with the crawl → docs.squirrelscan.com/guides/web-bot-auth",
  "Robots read your site too. The ax rules score agent experience, not just SEO.",
  "Signed-in audits track every issue across runs in your dashboard. Regressions get caught.",
] as const;

/** Uniformly random tip. No rotation/persistence — every run is a fresh draw. */
export function pickTip(): string {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
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
