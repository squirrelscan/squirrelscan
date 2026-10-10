// Audit levels on the command line: `--level quick|surface|full` (aliases
// `-C` / `--coverage`, config `[crawler] coverage`).
//
// A level is a named set of audit settings, defined once in
// @squirrelscan/core-contracts/audit-levels: page budget, crawl strategy, cloud
// checks, rendering, external link checks and probing. Picking a level fills in
// every setting; the existing flags and config values then override single
// settings, and any override that changes a value makes the run `custom`. The
// banner says so: `custom (surface + max_pages 200)`.
//
// The flag is a free string (citty has no enum), so it is parsed here. An
// unknown value like `fast` once flowed through a lying `as CoverageMode` cast,
// made the page-budget lookup `undefined`, and so a NaN cap and an unbounded
// crawl (every `pages.length >= NaN` check is false).

import {
  AUDIT_LEVEL_PRESETS,
  AUDIT_LEVELS,
  type AuditLevel,
  type AuditSettingKey,
  type AuditSettings,
  type CrawlStrategy,
  crawlStrategyCoverageMode,
  DEFAULT_AUDIT_LEVEL,
  parseAuditLevel,
  type ProbeIntensity,
  type RenderPolicy,
  type ResolvedAuditSettings,
  resolveAuditSettings,
} from "@squirrelscan/core-contracts/audit-levels";

export { AUDIT_LEVELS, parseAuditLevel, type AuditLevel };

/** The error for a value that is not a level. Names the three levels. */
export function unknownLevelMessage(raw: string): string {
  return `unknown audit level '${raw}'. Valid: ${AUDIT_LEVELS.join(", ")} (fast is accepted as quick).`;
}

/**
 * A level flag's raw value as citty delivered it. citty hands a repeated flag
 * over as an array; that is refused with its own error rather than resolved
 * to one of the values.
 */
function flagText(
  value: unknown,
  name: string
): { ok: true; text: string | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null)
    return { ok: true, text: undefined };
  if (Array.isArray(value)) {
    return {
      ok: false,
      error: `${name} was given more than once (${value.map(String).join(", ")}). Pass one level.`,
    };
  }
  return { ok: true, text: String(value) };
}

/**
 * The level the command line asked for: `--level`, or its older spelling
 * `--coverage` / `-C`. Both at once must agree; two different levels are
 * refused, never silently resolved.
 */
export function readLevelFlag(args: {
  level?: unknown;
  coverage?: unknown;
}): { ok: true; raw: string | undefined } | { ok: false; error: string } {
  const levelFlag = flagText(args.level, "--level");
  if (!levelFlag.ok) return levelFlag;
  const coverageFlag = flagText(args.coverage, "--coverage");
  if (!coverageFlag.ok) return coverageFlag;
  const level = levelFlag.text;
  const coverage = coverageFlag.text;
  if (level !== undefined && coverage !== undefined) {
    const a = parseAuditLevel(level);
    const b = parseAuditLevel(coverage);
    if (a === null || b === null || a !== b) {
      return {
        ok: false,
        error: `--level ${level} and --coverage ${coverage} name different levels. Pass one (--coverage and -C are the old names for --level).`,
      };
    }
  }
  return { ok: true, raw: level ?? coverage };
}

// Default when no --level flag or config: any signed-in plan (free OR paid) →
// surface (cloud checks + summary, pro-parity demo #684); anonymous → quick.
export function defaultAuditLevel(
  accountPlan: "anonymous" | "free" | "paid"
): AuditLevel {
  return accountPlan === "anonymous" ? "quick" : DEFAULT_AUDIT_LEVEL;
}

// Default for smart audits (#684) when config doesn't set `smart_audits`: ON
// for any evidence of an account, OFF only for true anonymous. The finding
// store is local SQLite and needs no cloud, so an auth hiccup must not flip it
// off between runs (union scoring would make scores jump): "unreachable" keeps
// the signed-in default via the level plan collapse, and an EXPIRED token
// still proves an account exists.
export function defaultSmartAudits(
  accountPlan: "anonymous" | "free" | "paid",
  cloudOutage: "expired" | "unreachable" | null
): boolean {
  return accountPlan !== "anonymous" || cloudOutage !== null;
}

/** Default page budget for a level. */
export function levelMaxPages(level: AuditLevel): number {
  return AUDIT_LEVEL_PRESETS[level].pages;
}

/**
 * The settings a local run uses: the level's, with each value the user set by
 * flag or config laid over it. Pass only what the user chose; an omitted key
 * keeps the level's value. A value equal to the level's own is not a change.
 *
 * Crawl strategy and cloud checks have no override on the command line, so
 * they always follow the level. Signed out or `--offline`, the cloud checks
 * and rendering cannot run at all; that is a limit on this run, not a change
 * to its settings, so it does not make the level custom.
 */
export function resolveLocalAuditLevel(
  level: AuditLevel,
  overrides: {
    pages?: number;
    render?: RenderPolicy;
    externalLinks?: boolean;
    probe?: ProbeIntensity;
  } = {}
): ResolvedAuditSettings {
  return resolveAuditSettings(level, overrides);
}

/** The schema default of `[crawler] max_pages`, which reads as "unset". */
export const CONFIG_MAX_PAGES_DEFAULT = 100;

/**
 * `[crawler] max_pages` when the config chose it, or undefined when it is the
 * schema default `squirrel init` writes, which leaves the level's page budget
 * in place. The one place `audit`, `crawl` and the MCP tools read that rule.
 */
export function configMaxPagesChoice(config: {
  crawler: { max_pages: number };
}): number | undefined {
  return config.crawler.max_pages !== CONFIG_MAX_PAGES_DEFAULT
    ? config.crawler.max_pages
    : undefined;
}

/**
 * The level settings a config file overrides. `squirrel init` writes every
 * schema default into squirrel.toml, so a value equal to its default reads as
 * unset and leaves the level's own value in place: `max_pages = 100` and
 * `[external_links] enabled = true` change nothing. Only a different value is
 * a choice: another `max_pages`, or `enabled = false`, which turns external
 * link checks off at every level.
 */
export function configLevelOverrides(config: {
  crawler: { max_pages: number };
  external_links: { enabled: boolean };
}): { pages?: number; externalLinks?: false } {
  const pages = configMaxPagesChoice(config);
  return {
    ...(pages !== undefined ? { pages } : {}),
    ...(config.external_links.enabled === false
      ? { externalLinks: false as const }
      : {}),
  };
}

/** The crawler mode that crawls the way these settings ask. */
export function levelCoverageMode(resolved: ResolvedAuditSettings): AuditLevel {
  return crawlStrategyCoverageMode(resolved.settings.crawlStrategy);
}

const onOff = (value: boolean): string => (value ? "on" : "off");

/** A changed setting as the banner names it: the config key's words, then the value. */
const CHANGE_LABELS: Record<AuditSettingKey, (s: AuditSettings) => string> = {
  pages: (s) => `max_pages ${s.pages}`,
  crawlStrategy: (s) => `crawl ${s.crawlStrategy}`,
  cloudChecks: (s) => `cloud_checks ${onOff(s.cloudChecks)}`,
  render: (s) => `render ${s.render}`,
  externalLinks: (s) => `external_links ${onOff(s.externalLinks)}`,
  probe: (s) => `probe ${s.probe}`,
};

/**
 * The level as one phrase: `surface`, or `custom (surface + max_pages 200)`
 * with every changed setting listed, in settings-form order.
 */
export function describeAuditLevel(resolved: ResolvedAuditSettings): string {
  if (resolved.level !== "custom") return resolved.level;
  const changes = resolved.changes
    .map((key) => CHANGE_LABELS[key](resolved.settings))
    .join(", ");
  return `custom (${resolved.basedOn} + ${changes})`;
}

/**
 * The run banner's `Level` value, split so the caller can dim the detail:
 *   Level     surface · max 100 pages
 *   Level     custom (surface + max_pages 200)
 *   Level     custom (surface + render off) · max 100 pages
 * The page count is left out when it is itself one of the changes, since the
 * phrase already says it.
 */
export function levelBannerParts(resolved: ResolvedAuditSettings): {
  level: string;
  detail?: string;
} {
  const level = describeAuditLevel(resolved);
  if (resolved.changes.includes("pages")) return { level };
  return { level, detail: `· max ${resolved.settings.pages} pages` };
}

/** Banner text without colour, for tests and plain output. */
export function levelBannerValue(resolved: ResolvedAuditSettings): string {
  const { level, detail } = levelBannerParts(resolved);
  return detail ? `${level} ${detail}` : level;
}

const STRATEGY_WORDS: Record<CrawlStrategy, string> = {
  "seed-and-sitemap": "seed and sitemaps",
  sampled: "one page per URL pattern",
  all: "every page",
};

/**
 * One line per level for `--help`, built from the preset table so the help
 * can never disagree with what runs, e.g.
 * `quick (25 pages, seed and sitemaps, no cloud checks)`.
 */
export function levelHelpList(): string {
  return AUDIT_LEVELS.map((level) => {
    const s = AUDIT_LEVEL_PRESETS[level];
    const checks = s.cloudChecks ? "cloud checks" : "no cloud checks";
    return `${level} (${s.pages} pages, ${STRATEGY_WORDS[s.crawlStrategy]}, ${checks})`;
  }).join(", ");
}
