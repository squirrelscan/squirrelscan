// Config schema — Zod schemas, types, and defaults for squirrelscan configuration.
// Shared across CLI, cloud runner, and any other consumer.
// TOML loading and file discovery are NOT here — those are CLI adapters.

import { isValidHeaderName, isValidHeaderValue } from "@squirrelscan/utils/headers";
import { z } from "zod";

// ============================================
// SUB-SCHEMAS
// ============================================

export const COVERAGE_MODES = ["quick", "surface", "full"] as const;
export type CoverageMode = (typeof COVERAGE_MODES)[number];

// Authoritative crawl-concurrency defaults (the CLI + cloud runner both derive
// from this schema). Named so the loopback fast path (#1068) can tell "user
// left the default" from "user picked a value" — zod erases that provenance.
// packages/crawler DEFAULT_CRAWLER_CONFIG mirrors these; keep in sync.
export const DEFAULT_CRAWLER_CONCURRENCY = 5;
export const DEFAULT_CRAWLER_PER_HOST_CONCURRENCY = 5;
export const DEFAULT_CRAWLER_PER_HOST_DELAY_MS = 50;

export const CrawlerConfigSchema = z.object({
  max_pages: z.number().default(100),
  // Optional crawl-depth ceiling (#318); unset = unlimited (preserves default behavior).
  max_depth: z.number().int().min(1).optional(),
  // Unset (optional, not defaulted) so the CLI can distinguish "user picked a
  // mode" from "use the auth-aware default" — signed-in paid plans default to
  // `surface` (cloud rules + summary), free/anonymous to `quick`. Resolved in
  // the audit/crawl commands; a config file value here is an explicit override.
  coverage: z.enum(COVERAGE_MODES).optional(),
  delay_ms: z.number().default(100),
  timeout_ms: z.number().default(30000),
  user_agent: z.string().default(""),
  // Custom HTTP request headers attached to EVERY crawl request (pages, assets,
  // robots.txt, sitemap). Use for authorized-crawler schemes (Shopify/Cloudflare
  // Web Bot Auth) that require signed headers. Values are treated as secrets —
  // redacted in logs/output. TOML: `[crawler] headers = { "Name" = "Value" }`.
  // Reject control chars in names/values — replayed onto outbound requests (#532).
  headers: z
    .record(
      z.string().max(255).refine(isValidHeaderName, { message: "Invalid header name" }),
      z.string().max(8192).refine(isValidHeaderValue, {
        message: "Header value contains control characters (CR/LF/NUL)",
      }),
    )
    .refine((h) => Object.keys(h).length <= 50, {
      message: "Too many custom headers (max 50)",
    })
    .default({}),
  follow_redirects: z.boolean().default(true),
  concurrency: z.number().default(DEFAULT_CRAWLER_CONCURRENCY),
  // Single-host bump (#265): per-host caps gate throughput; robots crawl-delay
  // overrides this only when respect_robots is true (#790), capped at 2s.
  per_host_concurrency: z.number().default(DEFAULT_CRAWLER_PER_HOST_CONCURRENCY),
  per_host_delay_ms: z.number().default(DEFAULT_CRAWLER_PER_HOST_DELAY_MS),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  allow_query_params: z.array(z.string()).default([]),
  drop_query_prefixes: z.array(z.string()).default(["utm_", "gclid", "fbclid"]),
  // Enforce robots.txt Disallow + Crawl-delay (capped at 2s). robots.txt is
  // always fetched regardless (sitemap discovery, crawl/robots-txt rule).
  // Default false (#790): audits are site-owner initiated, so directives
  // aimed at uninvited crawlers don't apply unless explicitly opted in.
  respect_robots: z.boolean().default(false),
  // Incremental re-scan: send conditional GETs (ETag/Last-Modified) so unchanged pages return 304; --refresh forces a full fetch. (#125)
  incremental: z.boolean().default(true),
  breadth_first: z.boolean().default(true),
  max_prefix_budget: z.number().min(0.1).max(1.0).default(0.25),
  /**
   * Browser-like caching: honor origin Cache-Control max-age / Expires to skip
   * re-requesting fresh pages across audits (only when incremental). Disable
   * with --refresh or by setting this false. (#106)
   */
  use_cache_control: z.boolean().default(true),
  /**
   * Hard cap (seconds) on how stale a "fresh" cached entry may be regardless of
   * the origin's declared max-age. Bounds trust in absurd max-age values within
   * a single audit. Default 24h. (#106)
   */
  max_staleness_seconds: z.number().int().min(0).default(86400),
});

export const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  domains: z.array(z.string()).default([]),
});

export const RulesConfigSchema = z.object({
  enable: z.array(z.string()).default(["*"]),
  disable: z.array(z.string()).default([]),
});

export const PluginCapabilitySchema = z.enum(["rules", "listeners"]);

export const PluginManifestItemSchema = z.object({
  id: z.string().min(1),
  entry: z.string().min(1),
  allow: z.array(PluginCapabilitySchema).default([]),
});

export const PluginsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  items: z.array(PluginManifestItemSchema).default([]),
});

export const ExternalLinksConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cache_ttl_days: z.number().int().min(1).default(7),
  timeout_ms: z.number().int().min(1000).max(60000).default(10000),
  concurrency: z.number().int().min(1).max(20).default(5),
});

export const OutputConfigSchema = z.object({
  format: z.enum(["json", "html", "console"]).default("console"),
  path: z.string().optional(),
});

export const CloudConfigSchema = z.object({
  /** Master switch — no-op when not logged in. */
  enabled: z.boolean().default(true),
  /**
   * Per-audit credit cap; prefetch truncates deterministically at the cap.
   * 0 = unlimited. Default 1000 (was 200): cloud browser rendering is now the
   * authed default (~2 credits/page), so the cap needs headroom to render a
   * normal crawl plus the other cloud rules. TTY runs above `confirm_threshold`
   * still prompt; `--yes`/non-TTY runs proceed unattended up to this cap.
   */
  max_credits_per_audit: z.number().int().min(0).default(1000),
  /** Estimated spend above this prompts for TTY confirmation. 0 = always confirm. */
  confirm_threshold: z.number().int().min(0).default(50),
  /** Pages per service request batch. */
  batch_size: z.number().int().min(1).max(20).default(20),
  /**
   * Technology fingerprinting (report-only, flat `tech_detect` credit charge).
   * Auto-runs for logged-in users; set false to skip. Cheap (5 credits) so it
   * normally runs silently below `confirm_threshold`.
   */
  technologies: z.boolean().default(true),
  /**
   * Editor's audit summary (report-only, flat `editor_summary` credit charge).
   * Credit-only since #684: any signed-in plan can run it (402 when out of credits).
   * Auto-runs for logged-in users; set false to skip. Cheap (8 credits) so
   * it normally runs silently below `confirm_threshold`.
   */
  editor_summary: z.boolean().default(true),
  /**
   * Domain-level SEO stats (#111, report-only, flat `domain_stats` credit charge).
   * Credit-only since #684: any signed-in plan can run it (402 when out of credits).
   * Auto-runs for logged-in users; set false to skip. Cheap (5 credits) and
   * 30-day cached per domain, so it normally runs silently below `confirm_threshold`.
   */
  domain_stats: z.boolean().default(true),
  /**
   * Crawl fetch mode. Explicit 'browser' renders every page via the cloud
   * browser (credit-priced); explicit 'http' forces plain HTTP. Left UNSET
   * (the default), the mode is resolved at runtime: authed users default to
   * cloud rendering (after a one-time consent prompt), everyone else gets
   * plain HTTP. Keep this optional — `undefined` means "auto", which is how
   * the CLI distinguishes an explicit `http` opt-out from no preference.
   */
  rendering: z.enum(["http", "browser"]).optional(),
  /**
   * Render strategy (#294) — the canonical knob; supersedes `rendering`:
   *   off  — plain HTTP only, never browser-render.
   *   auto — HTTP-first; render ONLY pages detected as client-side-rendered.
   *   all  — browser-render every HTML page.
   * robots.txt, XML sitemaps, and non-HTML assets are never rendered at any
   * level (always plain HTTP) — `all` means "every crawled HTML page". Left
   * UNSET, the strategy is coverage-driven (quick → auto, surface/full → all)
   * for authed users after the one-time consent prompt; everyone else gets
   * plain HTTP. Legacy `rendering` maps in when `render` is unset: http→off,
   * browser→all.
   */
  render: z.enum(["off", "auto", "all"]).optional(),
  /**
   * Concurrent in-flight cloud render jobs during a browser-rendered crawl.
   * Render jobs queue in our cloud, so CLI-side per-host throttling only
   * delays submission — but the render workers DO hit the target host, so
   * this stays capped (max 10, the Team plan ceiling).
   */
  render_concurrency: z.number().int().min(1).max(10).default(6),
  /**
   * Auto-publish the audit report to the user's dashboard when signed in +
   * online; set false to never auto-publish. Independent of cloud rendering.
   */
  publish: z.boolean().default(true),
  /** Default visibility for published reports. */
  visibility: z.enum(["public", "unlisted", "private"]).default("unlisted"),
});

// Per-provider threat-intel config (#117). Every provider is optional and behind
// its own key: `enabled` turns on a keyless feed, `api_key` activates a provider
// that needs one (and implies enabled). Mirrors @squirrelscan/threat-intel's
// ProviderConfig.
export const IntelProviderConfigSchema = z.object({
  enabled: z.boolean().optional(),
  api_key: z.string().optional(),
});

// Threat-intel feature (#117) — opt-in, API-keyed. OFF by default: enabling it
// (and configuring providers) makes audit-engine resolve feeds + lookups + kit
// signatures into `ctx.intel`, lighting up the integrity intel rules.
export const IntelConfigSchema = z.object({
  /** Master switch. Default false — the whole feature is opt-in. */
  enabled: z.boolean().default(false),
  /** Daily-pull feed cache TTL in hours. Default 24 (once per day). */
  feed_ttl_hours: z.number().int().min(1).default(24),
  /** Per-provider config keyed by provider id (safe-browsing, urlhaus, …). */
  providers: z
    .record(z.string(), IntelProviderConfigSchema)
    .default({}),
});

// Differential cloaking probe (integrity Phase 3, #118) — opt-in, bounded. When
// enabled the crawler re-fetches a capped set of SUSPICIOUS paths (orphan or
// recently-modified) with a Googlebot UA (and optionally an appended query token)
// and records both responses for the `integrity/cloaking` rule to compare. OFF by
// default — it does extra network requests, so it never runs unless asked.
export const CloakingProbeConfigSchema = z.object({
  /** Master switch. Default false — the probe is opt-in. */
  enabled: z.boolean().default(false),
  /**
   * Hard cap on how many suspicious paths get the differential re-fetch. Keeps
   * the probe from multiplying crawl cost on large/compromised sites.
   */
  max_pages: z.number().int().min(1).max(50).default(10),
  /** A sitemap/Last-Modified date within this many days counts as "recent". */
  recent_days: z.number().int().min(1).default(14),
  /** Also probe an appended query token to detect token-gated responses. */
  query_variation: z.boolean().default(true),
  /** UA string sent for the cloaking comparison fetch. */
  googlebot_user_agent: z
    .string()
    .default(
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    ),
});

// Soft-404 confirmation re-fetch (#1177). Before crawl/soft-404 warns, each
// flagged 2xx page is re-fetched once and re-detected so a transient/intermittent
// error shell isn't reported as a confident soft-404. ON by default (it prevents
// false findings); opt out on rate-limited/staging hosts, where flagged pages are
// then annotated "unconfirmed" instead of re-fetched.
export const Soft404ConfirmConfigSchema = z.object({
  /** Master switch. Default TRUE — the confirmation pass runs unless disabled. */
  enabled: z.boolean().default(true),
  /** Hard cap on confirmation fetches; extra candidates degrade to "unconfirmed". */
  max_confirmations: z.number().int().min(1).max(100).default(25),
  /** Overall wall-clock budget for the pass in ms; exhausted → "unconfirmed". */
  budget_ms: z.number().int().min(1000).default(60_000),
});

// Site-integrity feature config (#115). Holds the opt-in cloaking probe (#118)
// and the soft-404 confirmation pass (#1177); threat-intel lives under [intel].
export const IntegrityConfigSchema = z.object({
  cloaking_probe: CloakingProbeConfigSchema.default(
    CloakingProbeConfigSchema.parse({}),
  ),
  soft404_confirm: Soft404ConfirmConfigSchema.default(
    Soft404ConfirmConfigSchema.parse({}),
  ),
});

// Pre-compute defaults once at module load
const defaultProject = ProjectConfigSchema.parse({});
const defaultCrawler = CrawlerConfigSchema.parse({});
const defaultRules = RulesConfigSchema.parse({});
const defaultPlugins = PluginsConfigSchema.parse({});
const defaultExternalLinks = ExternalLinksConfigSchema.parse({});
const defaultOutput = OutputConfigSchema.parse({});
const defaultCloud = CloudConfigSchema.parse({});
const defaultIntel = IntelConfigSchema.parse({});
const defaultIntegrity = IntegrityConfigSchema.parse({});

// ============================================
// MAIN CONFIG SCHEMA
// ============================================

export const ConfigSchema = z.object({
  project: ProjectConfigSchema.default(defaultProject),
  crawler: CrawlerConfigSchema.default(defaultCrawler),
  rules: RulesConfigSchema.default(defaultRules),
  plugins: PluginsConfigSchema.default(defaultPlugins),
  external_links: ExternalLinksConfigSchema.default(defaultExternalLinks),
  output: OutputConfigSchema.default(defaultOutput),
  cloud: CloudConfigSchema.default(defaultCloud),
  // Threat-intel feature (#117) — opt-in, default disabled.
  intel: IntelConfigSchema.default(defaultIntel),
  // Site-integrity feature (#115) — holds the opt-in cloaking probe (#118).
  integrity: IntegrityConfigSchema.default(defaultIntegrity),
  rule_options: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /**
   * Smart audits (#110): persist per-page finding state across audits and score
   * over the UNION of all known non-removed pages, so a partial re-audit carries
   * forward issues on un-crawled pages instead of inflating the score. Local
   * SQLite store, gated. Optional (no schema default): UNSET lets the caller
   * resolve it — the CLI defaults it ON for signed-in users, OFF for anonymous
   * (#684). An explicit true/false in config always wins.
   */
  smart_audits: z.boolean().optional(),
});

// ============================================
// TYPE INFERENCE
// ============================================

export type Config = Omit<z.infer<typeof ConfigSchema>, "plugins"> & {
  plugins?: z.infer<typeof PluginsConfigSchema>;
};
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type CrawlerConfig = z.infer<typeof CrawlerConfigSchema>;
export type RulesConfig = z.infer<typeof RulesConfigSchema>;
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;
export type PluginManifestItem = z.infer<typeof PluginManifestItemSchema>;
export type PluginsConfig = z.infer<typeof PluginsConfigSchema>;
export type ExternalLinksConfig = z.infer<typeof ExternalLinksConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type CloudConfig = z.infer<typeof CloudConfigSchema>;
export type CloakingProbeConfig = z.infer<typeof CloakingProbeConfigSchema>;
export type IntegrityConfig = z.infer<typeof IntegrityConfigSchema>;

// ============================================
// DEFAULTS
// ============================================

export function getDefaultConfig(): Config {
  return ConfigSchema.parse({});
}
