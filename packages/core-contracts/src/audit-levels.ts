// Audit levels: the one definition of quick, surface and full.
//
// A level is a named bundle of audit settings. Picking a level fills in every
// setting; changing any setting afterwards makes the audit "custom", like a
// browser's standard / strict / custom tracking protection. The CLI, the cloud
// API, the MCP tools, the dashboard and the docs all read this module, so a
// level means the same thing everywhere. Nothing else may hardcode a level list
// or a per-level page count.
//
// The page budgets are COVERAGE_PAGE_LIMITS, the same numbers the crawler uses.
// A custom page limit is validated against AUDIT_MAX_PAGES, the hard ceiling on
// one audit; a plan can set a lower ceiling (see plans.ts).

import { COVERAGE_PAGE_LIMITS, REPORT_LIMITS } from "./limits";

export const AUDIT_LEVELS = ["quick", "surface", "full"] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];

/** A level, or `custom` once any setting differs from the level it started from. */
export type AuditLevelId = AuditLevel | "custom";

/** Hard ceiling on the pages of a single audit, whatever the level or plan. */
export const AUDIT_MAX_PAGES = REPORT_LIMITS.maxPages;

/**
 * How the crawl picks pages.
 * - `seed-and-sitemap`: the seed URL and the sitemaps, no link following (links
 *   are followed anyway when the sitemap yields nothing crawlable).
 * - `sampled`: follows links, but takes one page per URL pattern first
 *   (`/blog/{slug}`), so a large archive does not eat the budget.
 * - `all`: every page it can reach, up to the page budget.
 */
export type CrawlStrategy = "seed-and-sitemap" | "sampled" | "all";

/** `off` fetches over HTTP only, `auto` renders pages that need JavaScript, `all` renders every page. */
export type RenderPolicy = "off" | "auto" | "all";

/** How hard an audit may poke beyond what the crawl fetched. `aggressive` is never a level default. */
export type ProbeIntensity = "passive" | "active" | "aggressive";

/** The settings a level sets. Every key is one a user can override. */
export interface AuditSettings {
  /** Page budget, 1 to AUDIT_MAX_PAGES. */
  pages: number;
  crawlStrategy: CrawlStrategy;
  /** Cloud-backed checks: AI and authority signals, the editor's summary, tech detection, domain stats. */
  cloudChecks: boolean;
  render: RenderPolicy;
  /** Check links that leave the site. In the cloud each destination costs a credit. */
  externalLinks: boolean;
  probe: ProbeIntensity;
}

export type AuditSettingKey = keyof AuditSettings;

/** The setting keys, in the order a settings form lists them. */
export const AUDIT_SETTING_KEYS = [
  "pages",
  "crawlStrategy",
  "cloudChecks",
  "render",
  "externalLinks",
  "probe",
] as const satisfies readonly AuditSettingKey[];

export const AUDIT_LEVEL_PRESETS: Readonly<Record<AuditLevel, Readonly<AuditSettings>>> = {
  quick: {
    pages: COVERAGE_PAGE_LIMITS.quick,
    crawlStrategy: "seed-and-sitemap",
    cloudChecks: false,
    render: "auto",
    externalLinks: false,
    probe: "passive",
  },
  surface: {
    pages: COVERAGE_PAGE_LIMITS.surface,
    crawlStrategy: "sampled",
    cloudChecks: true,
    render: "all",
    externalLinks: true,
    probe: "active",
  },
  full: {
    pages: COVERAGE_PAGE_LIMITS.full,
    crawlStrategy: "all",
    cloudChecks: true,
    render: "all",
    externalLinks: true,
    probe: "active",
  },
};

/** Words for a level, shared by every surface that names one. */
export const AUDIT_LEVEL_COPY: Readonly<
  Record<AuditLevel | "custom", { label: string; summary: string }>
> = {
  quick: {
    label: "Quick",
    summary: "A fast look at the seed page and sitemaps. Local rules only, no credits.",
  },
  surface: {
    label: "Surface",
    summary: "One page per URL pattern, with the cloud checks. The default for most sites.",
  },
  full: {
    label: "Full",
    summary: "Every page up to the budget, with the cloud checks.",
  },
  custom: {
    label: "Custom",
    summary: "Your own settings, started from a level.",
  },
};

export const DEFAULT_AUDIT_LEVEL: AuditLevel = "surface";

export interface ResolvedAuditSettings {
  /** The level these settings are: a preset's name, or `custom` when anything differs. */
  level: AuditLevelId;
  /** The level the settings started from. */
  basedOn: AuditLevel;
  settings: AuditSettings;
  /** Keys that differ from the level `basedOn`, in form order. Empty unless `level` is `custom`. */
  changes: AuditSettingKey[];
}

/** Settings of a level with overrides applied. Pages are clamped to 1..AUDIT_MAX_PAGES. */
export function resolveAuditSettings(
  basedOn: AuditLevel,
  overrides: Partial<AuditSettings> = {},
): ResolvedAuditSettings {
  const preset = AUDIT_LEVEL_PRESETS[basedOn];
  const merged: AuditSettings = { ...preset };
  for (const key of AUDIT_SETTING_KEYS) {
    const value = overrides[key];
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  merged.pages = clampAuditPages(merged.pages);
  const changes = AUDIT_SETTING_KEYS.filter((key) => merged[key] !== preset[key]);
  return {
    level: changes.length === 0 ? basedOn : "custom",
    basedOn,
    settings: merged,
    changes,
  };
}

/** Which level a full set of settings is: a preset's name when it matches one exactly, else `custom`. */
export function levelOfSettings(settings: AuditSettings): AuditLevelId {
  for (const level of AUDIT_LEVELS) {
    const preset = AUDIT_LEVEL_PRESETS[level];
    if (AUDIT_SETTING_KEYS.every((key) => settings[key] === preset[key])) return level;
  }
  return "custom";
}

export function clampAuditPages(pages: number): number {
  if (!Number.isFinite(pages)) return AUDIT_LEVEL_PRESETS[DEFAULT_AUDIT_LEVEL].pages;
  return Math.min(AUDIT_MAX_PAGES, Math.max(1, Math.trunc(pages)));
}

/**
 * Parse a level name from a flag, config value or API field. Case-insensitive.
 * `fast` is the old name for `quick` and is still accepted. Anything else is null,
 * never a guess: callers must reject an unknown value, not fall back silently.
 */
export function parseAuditLevel(raw: string): AuditLevel | null {
  const value = raw.trim().toLowerCase();
  const aliased = value === "fast" ? "quick" : value;
  return (AUDIT_LEVELS as readonly string[]).includes(aliased) ? (aliased as AuditLevel) : null;
}

/**
 * The cloud's old four scan depths, kept so existing websites and API callers keep
 * working. Each is the full set of settings it resolved to before audit levels
 * existed (pages, engine coverage mode, cloud checks, rendering, external links),
 * so migrating a website to these values changes nothing it does or costs. They
 * are `custom` settings by construction, except where they happen to equal a level.
 */
export const LEGACY_CLOUD_DEPTH_PROFILES = ["fast", "surface", "deep", "full"] as const;
export type LegacyCloudDepthProfile = (typeof LEGACY_CLOUD_DEPTH_PROFILES)[number];

const LEGACY_CLOUD_DEPTHS: Readonly<
  Record<LegacyCloudDepthProfile, { basedOn: AuditLevel; settings: AuditSettings }>
> = {
  fast: {
    basedOn: "quick",
    settings: {
      pages: 10,
      crawlStrategy: "seed-and-sitemap",
      cloudChecks: true,
      render: "all",
      externalLinks: false,
      probe: "passive",
    },
  },
  surface: {
    basedOn: "surface",
    settings: {
      pages: 50,
      crawlStrategy: "sampled",
      cloudChecks: true,
      render: "all",
      externalLinks: false,
      probe: "passive",
    },
  },
  deep: {
    basedOn: "surface",
    settings: {
      pages: 250,
      crawlStrategy: "sampled",
      cloudChecks: true,
      render: "all",
      externalLinks: false,
      probe: "passive",
    },
  },
  full: {
    basedOn: "full",
    settings: {
      pages: 500,
      crawlStrategy: "all",
      cloudChecks: true,
      render: "all",
      externalLinks: false,
      probe: "passive",
    },
  },
};

/** Parse an old cloud depth name, or null. */
export function parseLegacyCloudDepth(raw: string): LegacyCloudDepthProfile | null {
  const value = raw.trim().toLowerCase();
  return (LEGACY_CLOUD_DEPTH_PROFILES as readonly string[]).includes(value)
    ? (value as LegacyCloudDepthProfile)
    : null;
}

/** The settings an old cloud depth name stood for, and the level it was closest to. */
export function legacyCloudDepthSettings(profile: LegacyCloudDepthProfile): ResolvedAuditSettings {
  const { basedOn, settings } = LEGACY_CLOUD_DEPTHS[profile];
  return resolveAuditSettings(basedOn, settings);
}

/** What a plan and a balance allow. Absent keys do not limit. */
export interface AuditLimits {
  /** The plan's `maxPagesPerAudit`. */
  planMaxPages?: number;
  /** The most pages the credit balance can pay for, when it covers fewer than the settings ask for. */
  affordablePages?: number;
}

export type AuditPageLimitedBy = "plan" | "balance";

export interface EffectiveAuditSettings {
  settings: AuditSettings;
  /** What the settings asked for, before any limit. */
  requestedPages: number;
  /** Set when pages were lowered, and by what. A balance limit applies after the plan's. */
  pagesLimitedBy: AuditPageLimitedBy | null;
}

/**
 * The settings an audit will actually run with: the requested settings, with the
 * page budget lowered to the plan's ceiling and then to what the balance covers.
 * The level never changes: a Full audit on a small balance is still Full, run on
 * fewer pages, and says so through `pagesLimitedBy`.
 */
export function effectiveAuditSettings(
  settings: AuditSettings,
  limits: AuditLimits = {},
): EffectiveAuditSettings {
  let pages = clampAuditPages(settings.pages);
  let pagesLimitedBy: AuditPageLimitedBy | null = null;
  if (limits.planMaxPages !== undefined && pages > limits.planMaxPages) {
    pages = Math.max(1, limits.planMaxPages);
    pagesLimitedBy = "plan";
  }
  if (limits.affordablePages !== undefined && pages > limits.affordablePages) {
    pages = Math.max(1, limits.affordablePages);
    pagesLimitedBy = "balance";
  }
  return { settings: { ...settings, pages }, requestedPages: settings.pages, pagesLimitedBy };
}
