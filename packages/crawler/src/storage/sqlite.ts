/// <reference path="../types/bun-sqlite.d.ts" />

// SQLite storage implementation for the crawler
// Best for medium to large sites (1000+ pages)
// Uses bun:sqlite for native SQLite bindings

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { Effect } from "effect";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { isCacheHitReason } from "@squirrelscan/core-contracts";
import { urlHostKey } from "@squirrelscan/utils/url";

import type {
  CrawlStorage,
  CrawlMetadata,
  CrawlStats,
  PageRecord,
  FrontierRecord,
  FrontierStatus,
  LinkRecord,
  LinkAppearanceRecord,
  ImageRecord,
  ImageAppearanceRecord,
  LlmsTxtRecord,
  MarkdownProbeRecord,
  RobotsTxtRecord,
  WellKnownProbeRecord,
  AgentAccessRecord,
  RslRecord,
  SitemapRecord,
  SitemapUrlRecord,
  ResourceSizeRecord,
  CachedResourceRecord,
  SitemapUrlStatusRecord,
  PaginationOptions,
  ResponseHeaders,
  SecurityHeaders,
  PublishedReportRecord,
  PageFindingRecord,
  SitePageRecord,
  CompactFindingsOptions,
  PageFeatureRow,
  PageFeatureDuplicateField,
  DuplicateGroup,
  TemplateCluster,
} from "./types";

import { StorageError } from "./types";

/** Injectable content store for HTML deduplication + compression.
 *  CLI provides the global content store; cloud runner passes nothing (HTML stored inline). */
export interface ContentStoreAdapter {
  put(content: string, contentType: string): string;
  getString(hash: string): string | null;
}

// Schema version - increment when schema changes
const SCHEMA_VERSION = 19;

// Migrations to run when upgrading from older versions
const MIGRATIONS: Record<number, string[]> = {
  // Version 2: Add ttfb and download_time columns
  2: [
    "ALTER TABLE pages ADD COLUMN ttfb INTEGER",
    "ALTER TABLE pages ADD COLUMN download_time INTEGER",
  ],
  // Version 3: Add final_url column for correct relative URL resolution after redirects
  3: [
    "ALTER TABLE pages ADD COLUMN final_url TEXT",
    "CREATE INDEX IF NOT EXISTS idx_pages_final_url ON pages(final_url)",
  ],
  // Version 4: Add seed_url and original_url for tracking redirects on seed URL
  4: [
    "ALTER TABLE crawls ADD COLUMN seed_url TEXT",
    "ALTER TABLE crawls ADD COLUMN original_url TEXT",
  ],
  // Version 5: Add items, details, pages, skip_reason columns to rule_results for CheckResult fields
  5: [
    "ALTER TABLE rule_results ADD COLUMN items TEXT DEFAULT NULL",
    "ALTER TABLE rule_results ADD COLUMN details TEXT DEFAULT NULL",
    "ALTER TABLE rule_results ADD COLUMN pages TEXT DEFAULT NULL",
    "ALTER TABLE rule_results ADD COLUMN skip_reason TEXT DEFAULT NULL",
  ],
  // Version 6: Add redirect_chain column for redirect context
  6: ["ALTER TABLE pages ADD COLUMN redirect_chain TEXT"],
  // Version 7: Persist resource size data and sitemap status results
  7: [
    `CREATE TABLE IF NOT EXISTS resource_sizes (
      crawl_id TEXT NOT NULL,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      status INTEGER,
      error TEXT,
      content_type TEXT,
      size_bytes INTEGER,
      source_pages TEXT NOT NULL,
      PRIMARY KEY (crawl_id, type, url),
      FOREIGN KEY (crawl_id) REFERENCES crawls(id)
    )`,
    `CREATE TABLE IF NOT EXISTS sitemap_url_statuses (
      crawl_id TEXT NOT NULL,
      url TEXT NOT NULL,
      status INTEGER,
      error TEXT,
      PRIMARY KEY (crawl_id, url),
      FOREIGN KEY (crawl_id) REFERENCES crawls(id)
    )`,
  ],
  // Version 8: Add parsed_data column for storing parsed page data
  8: ["ALTER TABLE pages ADD COLUMN parsed_data TEXT"],
  // Version 9: Add WAF detection columns to links table
  9: [
    "ALTER TABLE links ADD COLUMN waf_blocked INTEGER",
    "ALTER TABLE links ADD COLUMN waf_provider TEXT",
  ],
  // Version 10: Add published_reports table for tracking published reports
  10: [
    `CREATE TABLE IF NOT EXISTS published_reports (
      crawl_id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      url TEXT NOT NULL,
      visibility TEXT NOT NULL,
      published_at TEXT NOT NULL,
      FOREIGN KEY (crawl_id) REFERENCES crawls(id)
    )`,
  ],
  // Version 11: Store request headers for Vary-aware cache keying (browser-cache emulation)
  11: ["ALTER TABLE pages ADD COLUMN request_headers TEXT"],
  // Version 12: Smart audits — site-scoped, cross-crawl finding + page store (#110).
  // ADDITIVE: new tables only (no column changes), gated at runtime behind the
  // `smart_audits` config flag. Local sqlite only — NOT a prod migration.
  12: [
    `CREATE TABLE IF NOT EXISTS page_findings (
      site_key TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      check_name TEXT NOT NULL,
      locator TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      value TEXT,
      expected TEXT,
      payload TEXT,
      fingerprint TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_crawl_id TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (site_key, normalized_url, rule_id, check_name, locator)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_page_findings_site ON page_findings(site_key)`,
    // Composite index for compactFindings' terminal-row prune (filters
    // site_key + state + last_seen_at). Leftmost prefix also serves site_key /
    // (site_key, state) lookups, so it covers the cap's count + ORDER BY too.
    `CREATE INDEX IF NOT EXISTS idx_page_findings_compact ON page_findings(site_key, state, last_seen_at)`,
    `CREATE TABLE IF NOT EXISTS site_pages (
      site_key TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      last_status INTEGER NOT NULL,
      state TEXT NOT NULL,
      last_seen_crawl_id TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (site_key, normalized_url)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_site_pages_site ON site_pages(site_key)`,
    // Composite index for compactFindings' removed-page prune (site_key + state + last_seen_at).
    `CREATE INDEX IF NOT EXISTS idx_site_pages_compact ON site_pages(site_key, state, last_seen_at)`,
  ],
  // Version 13: Sub-resource compression + caching metadata (#107).
  // Renumbered from 12 → 13 after #194 (smart audits) claimed step 12. A v11
  // store migrates through step 12 (smart-audit tables) then step 13 (these).
  13: [
    "ALTER TABLE resource_sizes ADD COLUMN content_encoding TEXT",
    "ALTER TABLE resource_sizes ADD COLUMN transfer_bytes INTEGER",
    "ALTER TABLE resource_sizes ADD COLUMN cache_control TEXT",
    "ALTER TABLE resource_sizes ADD COLUMN etag TEXT",
    "ALTER TABLE resource_sizes ADD COLUMN last_modified TEXT",
    "ALTER TABLE resource_sizes ADD COLUMN vary TEXT",
    "ALTER TABLE resource_sizes ADD COLUMN cache_reason TEXT",
    // Covers the getCachedResources() cross-crawl lookup (#107): the anti-join
    // correlates prior records by (type, url) and tie-breaks on crawl_id, so
    // without this it degrades to a full-table anti-join scan per row.
    "CREATE INDEX IF NOT EXISTS idx_resource_sizes_lookup ON resource_sizes(type, url, crawl_id)",
  ],
  // Version 14: Persist per-page fetch egress/method + fallback reason (#512).
  // Local sqlite only (crawler's own store) — NOT a prod migration.
  14: [
    "ALTER TABLE pages ADD COLUMN fetcher_id TEXT",
    "ALTER TABLE pages ADD COLUMN fallback_reason TEXT",
  ],
  // Version 15: Normalized-source fingerprint for render reuse (#839).
  // Local sqlite only (crawler's own store) — NOT a prod migration.
  15: ["ALTER TABLE pages ADD COLUMN source_hash TEXT"],
  // Version 16: Project-scoped key/value meta — sticky user-agent (#875).
  // Local sqlite only (crawler's own store) — NOT a prod migration.
  16: [
    `CREATE TABLE IF NOT EXISTS project_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ],
  // Version 17: Persist the ax/markdown-response header fingerprints (Vary,
  // Cloudflare x-markdown-tokens/x-original-tokens, Link rel=alternate).
  // Local sqlite only (crawler's own store) — NOT a prod migration.
  17: [
    "ALTER TABLE markdown_response ADD COLUMN negotiated_vary TEXT",
    "ALTER TABLE markdown_response ADD COLUMN markdown_tokens_header TEXT",
    "ALTER TABLE markdown_response ADD COLUMN original_tokens_header TEXT",
    "ALTER TABLE markdown_response ADD COLUMN alternate_markdown_url TEXT",
  ],
  // Version 18: page_features accumulator — one row/URL of the per-page scalars
  // the site rules read, so streaming rules can query bounded SQL aggregates
  // instead of holding every parsed page resident (#1022). ADDITIVE: new table +
  // indexes only, nothing reads it yet. Local sqlite only — NOT a prod migration.
  // Existing ~/.squirrel crawl stores migrate by creating the table on open.
  18: [
    `CREATE TABLE IF NOT EXISTS page_features (
      crawl_id TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      status INTEGER NOT NULL,
      depth INTEGER NOT NULL,
      title TEXT,
      title_hash TEXT,
      description TEXT,
      desc_hash TEXT,
      content_hash TEXT,
      word_count INTEGER,
      page_type TEXT,
      schema_types TEXT,
      robots_noindex INTEGER,
      canonical TEXT,
      visible_author INTEGER,
      visible_date INTEGER,
      transfer_bytes INTEGER,
      template_fp TEXT,
      secret_hits INTEGER,
      PRIMARY KEY (crawl_id, normalized_url),
      FOREIGN KEY (crawl_id) REFERENCES crawls(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_page_features_title_hash ON page_features(crawl_id, title_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_page_features_desc_hash ON page_features(crawl_id, desc_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_page_features_content_hash ON page_features(crawl_id, content_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_page_features_template ON page_features(crawl_id, template_fp)`,
    `CREATE INDEX IF NOT EXISTS idx_page_features_type ON page_features(crawl_id, page_type, normalized_url)`,
  ],
  // Version 19: page_features indexability scalars — meta-only noindex + the
  // meta/header isPageIndexable reasons + rich-result @types, so the noindex /
  // schema-noindex site rules can query them instead of re-deriving from every
  // parsed page (#1022, PR-D). ADDITIVE columns; ALTER is idempotent (the runner
  // swallows "duplicate column name"). Local sqlite only.
  //
  // No backfill: the new columns are nullable and read as false/[] when NULL. That
  // is safe because page_features is still DARK — `extractPageFeatures` is its
  // first and only writer and always lands a FULL row (all v19 columns) via
  // INSERT OR REPLACE keyed by (crawl_id, normalized_url). No pre-v19 populated
  // rows exist, and each crawl writes its own crawl_id's rows, so a prior crawl's
  // rows are never read. E-E MUST (re)extract every scored page in the current run
  // rather than read a stale prior crawl's page_features.
  19: [
    `ALTER TABLE page_features ADD COLUMN meta_noindex INTEGER`,
    `ALTER TABLE page_features ADD COLUMN indexable_reasons TEXT`,
    `ALTER TABLE page_features ADD COLUMN rich_result_types TEXT`,
  ],
};

// Nullable columns added to `pages` via ALTER migrations over time, with the
// types they were added with. `reconcilePagesColumns` re-adds any that are
// missing on open, INDEPENDENT of the schema_version counter — because a
// migration renumbering collision can leave a DB recorded at the current
// version yet missing a column. It happened: a beta bumped SCHEMA_VERSION to 16
// with migration 15 = project_meta (#875); the release redefined 15 =
// source_hash (#839), so DBs already at 16 skip migration 15 forever and every
// `upsertPage` INSERT throws "no column named source_hash" → the crawl stores 0
// pages and grinds to the backstop. Any new ALTER-added `pages` column MUST be
// listed here too, so the version counter is never the sole guard of its
// existence.
const PAGES_ALTER_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "ttfb", type: "INTEGER" },
  { name: "download_time", type: "INTEGER" },
  { name: "final_url", type: "TEXT" },
  { name: "redirect_chain", type: "TEXT" },
  { name: "parsed_data", type: "TEXT" },
  { name: "request_headers", type: "TEXT" },
  { name: "fetcher_id", type: "TEXT" },
  { name: "fallback_reason", type: "TEXT" },
  { name: "source_hash", type: "TEXT" },
];

const SCHEMA = `
-- Crawl sessions
CREATE TABLE IF NOT EXISTS crawls (
  id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,
  config TEXT NOT NULL,
  stats TEXT NOT NULL
);

-- Pages
CREATE TABLE IF NOT EXISTS pages (
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  final_url TEXT,
  depth INTEGER NOT NULL,
  parent_url TEXT,
  redirect_chain TEXT,
  status INTEGER NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  load_time_ms INTEGER NOT NULL,
  ttfb INTEGER,
  download_time INTEGER,
  fetched_at INTEGER NOT NULL,
  etag TEXT,
  last_modified TEXT,
  content_hash TEXT NOT NULL,
  html TEXT,
  parsed_data TEXT,
  headers TEXT NOT NULL,
  security_headers TEXT NOT NULL,
  request_headers TEXT,
  fetcher_id TEXT,
  fallback_reason TEXT,
  source_hash TEXT,
  PRIMARY KEY (crawl_id, normalized_url),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_pages_crawl ON pages(crawl_id);
CREATE INDEX IF NOT EXISTS idx_pages_final_url ON pages(final_url);

-- Frontier (URL queue)
CREATE TABLE IF NOT EXISTS frontier (
  crawl_id TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  raw_url TEXT NOT NULL,
  depth INTEGER NOT NULL,
  parent_url TEXT,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  fetched_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  PRIMARY KEY (crawl_id, normalized_url),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_frontier_pending
  ON frontier(crawl_id, status, priority, enqueued_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_frontier_status
  ON frontier(crawl_id, status);

-- Links
CREATE TABLE IF NOT EXISTS links (
  crawl_id TEXT NOT NULL,
  href TEXT NOT NULL,
  is_internal INTEGER NOT NULL,
  status INTEGER,
  error TEXT,
  checked_at INTEGER,
  waf_blocked INTEGER,
  waf_provider TEXT,
  PRIMARY KEY (crawl_id, href),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_links_crawl ON links(crawl_id);
CREATE INDEX IF NOT EXISTS idx_links_unchecked ON links(crawl_id) WHERE status IS NULL;

-- Link appearances
CREATE TABLE IF NOT EXISTS link_appearances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  href TEXT NOT NULL,
  page_url TEXT NOT NULL,
  anchor_text TEXT NOT NULL,
  position TEXT NOT NULL,
  rel TEXT,
  is_nofollow INTEGER NOT NULL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_link_appearances_href
  ON link_appearances(crawl_id, href);

CREATE INDEX IF NOT EXISTS idx_link_appearances_target
  ON link_appearances(crawl_id, href);

-- Images
CREATE TABLE IF NOT EXISTS images (
  crawl_id TEXT NOT NULL,
  src TEXT NOT NULL,
  status INTEGER,
  error TEXT,
  checked_at INTEGER,
  content_type TEXT,
  size INTEGER,
  PRIMARY KEY (crawl_id, src),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_images_crawl ON images(crawl_id);

-- Image appearances
CREATE TABLE IF NOT EXISTS image_appearances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  src TEXT NOT NULL,
  page_url TEXT NOT NULL,
  alt TEXT,
  width TEXT,
  height TEXT,
  is_lazy_loaded INTEGER NOT NULL,
  in_figure INTEGER NOT NULL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_image_appearances_src
  ON image_appearances(crawl_id, src);

-- Robots.txt
CREATE TABLE IF NOT EXISTS robots_txt (
  crawl_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  found INTEGER NOT NULL,
  content TEXT,
  size_bytes INTEGER NOT NULL,
  sitemaps TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- llms.txt + llms-full.txt root fetch
CREATE TABLE IF NOT EXISTS llms_txt (
  crawl_id TEXT PRIMARY KEY,
  llms_url TEXT NOT NULL,
  llms_found INTEGER NOT NULL,
  llms_content TEXT,
  llms_size_bytes INTEGER NOT NULL,
  full_url TEXT NOT NULL,
  full_found INTEGER NOT NULL,
  full_content TEXT,
  full_size_bytes INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- Homepage markdown content-negotiation + .md variant probe
CREATE TABLE IF NOT EXISTS markdown_response (
  crawl_id TEXT PRIMARY KEY,
  negotiated_url TEXT NOT NULL,
  negotiated_content_type TEXT,
  serves_markdown INTEGER NOT NULL,
  md_variant_url TEXT NOT NULL,
  md_variant_exists INTEGER NOT NULL,
  md_variant_content_type TEXT,
  negotiated_vary TEXT,
  markdown_tokens_header TEXT,
  original_tokens_header TEXT,
  alternate_markdown_url TEXT,
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- AX: fixed-list well-known/agent-file probes (JSON blob per crawl)
CREATE TABLE IF NOT EXISTS agent_well_known (
  crawl_id TEXT PRIMARY KEY,
  probes TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- AX: homepage access probes under browser + GPTBot + Claude-User UAs
CREATE TABLE IF NOT EXISTS agent_access (
  crawl_id TEXT PRIMARY KEY,
  probes TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- AX: robots.txt-derived RSL licensing fetch
CREATE TABLE IF NOT EXISTS agent_rsl (
  crawl_id TEXT PRIMARY KEY,
  license_urls TEXT NOT NULL,
  robots_has_license INTEGER NOT NULL,
  link_header_present INTEGER NOT NULL,
  documents TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- Sitemaps
CREATE TABLE IF NOT EXISTS sitemaps (
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL,
  url_count INTEGER NOT NULL,
  child_sitemaps TEXT NOT NULL,
  errors TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (crawl_id, url),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_sitemaps_crawl ON sitemaps(crawl_id);

-- Sitemap URLs
CREATE TABLE IF NOT EXISTS sitemap_urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  sitemap_url TEXT NOT NULL,
  loc TEXT NOT NULL,
  lastmod TEXT,
  changefreq TEXT,
  priority REAL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_sitemap_urls_sitemap
  ON sitemap_urls(crawl_id, sitemap_url);

-- Rule results
CREATE TABLE IF NOT EXISTS rule_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crawl_id TEXT NOT NULL,
  page_url TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  value TEXT,
  expected TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_rule_results_crawl ON rule_results(crawl_id);
CREATE INDEX IF NOT EXISTS idx_rule_results_page ON rule_results(crawl_id, page_url);

-- Resource size checks
CREATE TABLE IF NOT EXISTS resource_sizes (
  crawl_id TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  error TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  source_pages TEXT NOT NULL,
  content_encoding TEXT,
  transfer_bytes INTEGER,
  cache_control TEXT,
  etag TEXT,
  last_modified TEXT,
  vary TEXT,
  cache_reason TEXT,
  PRIMARY KEY (crawl_id, type, url),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_resource_sizes_crawl
  ON resource_sizes(crawl_id, type);

-- Covers the getCachedResources() cross-crawl anti-join (#107):
-- correlate prior records by (type, url) + tie-break on crawl_id.
CREATE INDEX IF NOT EXISTS idx_resource_sizes_lookup
  ON resource_sizes(type, url, crawl_id);

-- Sitemap URL status cache
CREATE TABLE IF NOT EXISTS sitemap_url_statuses (
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  error TEXT,
  PRIMARY KEY (crawl_id, url),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- Smart audits: site-scoped (cross-crawl) per-page finding store (#110)
CREATE TABLE IF NOT EXISTS page_findings (
  site_key TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  check_name TEXT NOT NULL,
  locator TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  value TEXT,
  expected TEXT,
  payload TEXT,
  fingerprint TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_crawl_id TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (site_key, normalized_url, rule_id, check_name, locator)
);

CREATE INDEX IF NOT EXISTS idx_page_findings_site ON page_findings(site_key);

-- Smart audits: site-scoped known-page registry (#110)
CREATE TABLE IF NOT EXISTS site_pages (
  site_key TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  last_status INTEGER NOT NULL,
  state TEXT NOT NULL,
  last_seen_crawl_id TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (site_key, normalized_url)
);

CREATE INDEX IF NOT EXISTS idx_site_pages_site ON site_pages(site_key);

-- Project-scoped key/value meta (sticky user-agent, #875)
CREATE TABLE IF NOT EXISTS project_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Page-features accumulator: one row/URL of the per-page scalars site rules
-- read, so streaming rules query bounded SQL aggregates instead of holding
-- every parsed page resident (#1022). Purely additive — nothing reads it yet.
CREATE TABLE IF NOT EXISTS page_features (
  crawl_id TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  status INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  title TEXT,
  title_hash TEXT,
  description TEXT,
  desc_hash TEXT,
  content_hash TEXT,
  word_count INTEGER,
  page_type TEXT,
  schema_types TEXT,
  robots_noindex INTEGER,
  canonical TEXT,
  visible_author INTEGER,
  visible_date INTEGER,
  transfer_bytes INTEGER,
  template_fp TEXT,
  secret_hits INTEGER,
  meta_noindex INTEGER,
  indexable_reasons TEXT,
  rich_result_types TEXT,
  PRIMARY KEY (crawl_id, normalized_url),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- Duplicate-title / -description / -content grouping (GROUP BY hash within a crawl).
CREATE INDEX IF NOT EXISTS idx_page_features_title_hash
  ON page_features(crawl_id, title_hash);
CREATE INDEX IF NOT EXISTS idx_page_features_desc_hash
  ON page_features(crawl_id, desc_hash);
CREATE INDEX IF NOT EXISTS idx_page_features_content_hash
  ON page_features(crawl_id, content_hash);
-- Template clustering (GROUP BY template_fp within a crawl).
CREATE INDEX IF NOT EXISTS idx_page_features_template
  ON page_features(crawl_id, template_fp);
-- pagesByType lookups: crawl_id + page_type filter, normalized_url order.
CREATE INDEX IF NOT EXISTS idx_page_features_type
  ON page_features(crawl_id, page_type, normalized_url);
`;

const SQLITE_BUSY_TIMEOUT_MS = 15000;

// Conservative hardcoded compaction bounds (#197). No squirrel.toml surface in
// v1 — these are the only defaults `compactFindings` uses unless a test overrides.
const COMPACT_DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // ~90 days
const COMPACT_DEFAULT_MAX_TERMINAL_FINDINGS = 5000;

// Bounded-aggregate caps for the page_features read API (#1022). Site rules
// pre-materialize duplicate/template groups, so the result must never grow
// O(pages): the CTE bounds the number of groups and the ROW_NUMBER filter bounds
// the URLs sampled per group. Method callers can override for tests.
const PAGE_FEATURE_DEFAULT_MAX_GROUPS = 1000;
const PAGE_FEATURE_DEFAULT_MAX_URLS_PER_GROUP = 200;
// Default page size for the getPageFeaturesPage keyset cursor.
const PAGE_FEATURE_DEFAULT_PAGE_SIZE = 500;

// Injection-safe whitelist mapping the typed duplicate-scan field to fixed
// column names. The raw `field` is NEVER interpolated into SQL — only these
// constant column names / the NULL literal are ever spliced into the query.
const DUP_FIELD_COLUMNS: Record<
  PageFeatureDuplicateField,
  { hash: string; value: string }
> = {
  title: { hash: "title_hash", value: "title" },
  description: { hash: "desc_hash", value: "description" },
  // Content-hash groups carry no scalar text sample.
  content: { hash: "content_hash", value: "NULL" },
};

// Keep at most `perHostLimit` rows per host, preserving priority order (#440).
// Single-host windows are returned untouched: capping there would only defer
// rows to the next pop (extra churn) without any diversity gain. Tradeoff: this
// only narrows the existing priority window, it never widens the SELECT to
// backfill, so a skewed multi-host batch can come back under `count` (the next
// pop continues from where this one stopped).
function capBatchPerHost(
  candidates: Record<string, unknown>[],
  perHostLimit?: number
): Record<string, unknown>[] {
  if (
    perHostLimit === undefined ||
    perHostLimit <= 0 ||
    candidates.length <= perHostLimit
  ) {
    return candidates;
  }

  const hosts = candidates.map((row) =>
    urlHostKey(row.normalized_url as string)
  );
  if (new Set(hosts).size <= 1) return candidates;

  const perHost = new Map<string, number>();
  const kept: Record<string, unknown>[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const host = hosts[i]!;
    const seen = perHost.get(host) ?? 0;
    if (seen >= perHostLimit) continue;
    perHost.set(host, seen + 1);
    kept.push(candidates[i]!);
  }
  return kept;
}

export class SQLiteStorage implements CrawlStorage {
  private db: Database | null = null;
  private readonly path: string;
  private readonly contentStore: ContentStoreAdapter | null;

  constructor(path: string = ":memory:", contentStore?: ContentStoreAdapter) {
    this.path = path;
    this.contentStore = contentStore ?? null;
  }

  /**
   * Execute a function within a SQLite transaction
   * Commits on success, rolls back on error
   */
  transaction<T>(fn: () => T): Effect.Effect<T, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const txn = db.transaction(() => fn());
        return txn();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  // Lifecycle
  init(): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        this.db = new Database(this.path);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA wal_autocheckpoint = 1000"); // Checkpoint every 1000 pages to limit WAL growth
        this.db.exec("PRAGMA synchronous = NORMAL");
        this.db.exec("PRAGMA cache_size = -64000"); // 64MB cache
        this.db.exec("PRAGMA temp_store = MEMORY");
        this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
        this.db.exec(SCHEMA);
        this.runMigrations();
      },
      catch: (e) => StorageError.init(e),
    });
  }

  /**
   * Run pending schema migrations
   */
  private runMigrations(): void {
    const db = this.getDb();

    // Create schema_version table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      )
    `);

    // Get current version (0 if table is empty = fresh install with new schema)
    const row = db
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined;

    // If no version row exists, check if pages table has old schema
    let currentVersion: number;
    if (!row) {
      // Check if pages table exists (has any columns)
      const tableInfo = db.prepare("PRAGMA table_info(pages)").all();
      if (tableInfo.length > 0) {
        // Existing DB without schema_version - run all migrations from v1
        // Duplicate-column guards will skip already-applied migrations
        currentVersion = 1;
      } else {
        // Fresh install
        currentVersion = SCHEMA_VERSION;
      }
    } else {
      currentVersion = row.version;
    }

    // Run migrations + version update in a transaction
    // If process crashes mid-migration, transaction rolls back and we retry next time
    if (currentVersion < SCHEMA_VERSION) {
      db.exec("BEGIN TRANSACTION");
      try {
        for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
          const statements = MIGRATIONS[v];
          if (statements) {
            for (const sql of statements) {
              try {
                db.exec(sql);
              } catch (e) {
                // Only ignore "duplicate column" errors (idempotent)
                // Rethrow everything else (locked DB, permissions, disk full, etc.)
                const msg = e instanceof Error ? e.message : String(e);
                if (!msg.includes("duplicate column name")) {
                  throw e;
                }
              }
            }
          }
        }

        // Update version only after all migrations succeed
        db.exec("DELETE FROM schema_version");
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
          SCHEMA_VERSION
        );

        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }

    // Self-heal: re-add any `pages` column a version-number collision skipped.
    // Runs unconditionally (PRAGMA table_info is the source of truth, not the
    // schema_version counter), so a DB stuck at the current version with a
    // missing column recovers instead of throwing on every upsertPage. See
    // PAGES_ALTER_COLUMNS.
    this.reconcilePagesColumns();
  }

  /**
   * Add any expected `pages` column that is missing, regardless of the recorded
   * schema version. Guards against migration renumbering collisions that leave
   * a DB recorded as current but missing a column the INSERT references — which
   * otherwise fails every page write and stores 0 pages. Idempotent and cheap
   * (one PRAGMA read + at most one ALTER per missing column).
   */
  private reconcilePagesColumns(): void {
    const db = this.getDb();
    const existing = new Set(
      (db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    // No pages table yet (shouldn't happen — SCHEMA creates it first) → nothing
    // to reconcile; a fresh CREATE TABLE already has every column.
    if (existing.size === 0) return;

    for (const col of PAGES_ALTER_COLUMNS) {
      if (existing.has(col.name)) continue;
      try {
        db.exec(`ALTER TABLE pages ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {
        // Idempotent: tolerate a concurrent add; surface anything else.
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("duplicate column name")) throw e;
      }
    }
  }

  close(): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        if (this.db) {
          this.db.close();
          this.db = null;
        }
      },
      catch: (e) => StorageError.close(e),
    });
  }

  private getDb(): Database {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    return this.db;
  }

  // Crawl session
  createCrawl(
    metadata: Omit<CrawlMetadata, "id">
  ): Effect.Effect<string, StorageError, never> {
    return Effect.try({
      try: () => {
        const id = randomUUID();
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT INTO crawls (id, base_url, seed_url, original_url, started_at, completed_at, status, config, stats)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          id,
          metadata.baseUrl,
          metadata.seedUrl ?? null,
          metadata.originalUrl ?? null,
          metadata.startedAt,
          metadata.completedAt ?? null,
          metadata.status,
          JSON.stringify(metadata.config),
          JSON.stringify(metadata.stats)
        );
        return id;
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getCrawl(
    id: string
  ): Effect.Effect<CrawlMetadata | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM crawls WHERE id = ?");
        const row = stmt.get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        return this.rowToCrawlMetadata(row);
      },
      catch: (e) => StorageError.read(e),
    });
  }

  updateCrawl(
    id: string,
    updates: Partial<Omit<CrawlMetadata, "id">>
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const sets: string[] = [];
        const values: unknown[] = [];

        if (updates.baseUrl !== undefined) {
          sets.push("base_url = ?");
          values.push(updates.baseUrl);
        }
        if (updates.seedUrl !== undefined) {
          sets.push("seed_url = ?");
          values.push(updates.seedUrl);
        }
        if (updates.originalUrl !== undefined) {
          sets.push("original_url = ?");
          values.push(updates.originalUrl);
        }
        if (updates.startedAt !== undefined) {
          sets.push("started_at = ?");
          values.push(updates.startedAt);
        }
        if (updates.completedAt !== undefined) {
          sets.push("completed_at = ?");
          values.push(updates.completedAt);
        }
        if (updates.status !== undefined) {
          sets.push("status = ?");
          values.push(updates.status);
        }
        if (updates.config !== undefined) {
          sets.push("config = ?");
          values.push(JSON.stringify(updates.config));
        }
        if (updates.stats !== undefined) {
          sets.push("stats = ?");
          values.push(JSON.stringify(updates.stats));
        }

        if (sets.length > 0) {
          values.push(id);
          const stmt = db.prepare(
            `UPDATE crawls SET ${sets.join(", ")} WHERE id = ?`
          );
          stmt.run(...(values as (string | number | null)[]));
        }
      },
      catch: (e) => StorageError.write(e),
    });
  }

  listCrawls(
    limit?: number
  ): Effect.Effect<CrawlMetadata[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        let query = "SELECT * FROM crawls ORDER BY started_at DESC";
        if (limit !== undefined) {
          query += ` LIMIT ${limit}`;
        }
        const stmt = db.prepare(query);
        const rows = stmt.all() as Record<string, unknown>[];
        return rows.map((row) => this.rowToCrawlMetadata(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  private safeJsonParse<T>(json: string, fallback: T): T {
    try {
      return JSON.parse(json) as T;
    } catch {
      return fallback;
    }
  }

  /**
   * Map a resource_sizes row to a ResourceSizeRecord, validating the
   * persisted-string fields rather than trusting a bare cast (#107):
   * `type` falls back to "image" if unknown, and `cache_reason` is checked
   * against the known CacheHitReason set (anything else → null).
   */
  private rowToResourceSizeRecord(
    row: Record<string, unknown>
  ): ResourceSizeRecord {
    const type = row.type === "css" ? "css" : "image";
    const rawReason = row.cache_reason as string | null;
    const cacheReason = isCacheHitReason(rawReason) ? rawReason : null;
    return {
      type,
      url: row.url as string,
      status: (row.status as number | null) ?? null,
      error: (row.error as string | null) ?? null,
      contentType: (row.content_type as string | null) ?? null,
      sizeBytes: (row.size_bytes as number | null) ?? null,
      sourcePages: this.safeJsonParse(
        row.source_pages as string,
        [] as string[]
      ),
      contentEncoding: (row.content_encoding as string | null) ?? null,
      transferBytes: (row.transfer_bytes as number | null) ?? null,
      cacheControl: (row.cache_control as string | null) ?? null,
      etag: (row.etag as string | null) ?? null,
      lastModified: (row.last_modified as string | null) ?? null,
      vary: (row.vary as string | null) ?? null,
      cacheReason,
    };
  }

  private rowToCrawlMetadata(row: Record<string, unknown>): CrawlMetadata {
    return {
      id: row.id as string,
      baseUrl: row.base_url as string,
      seedUrl: (row.seed_url as string | null) ?? undefined,
      originalUrl: (row.original_url as string | null) ?? undefined,
      startedAt: row.started_at as number,
      completedAt: (row.completed_at as number | null) ?? undefined,
      status: row.status as CrawlMetadata["status"],
      config: this.safeJsonParse(
        row.config as string,
        {} as CrawlMetadata["config"]
      ),
      stats: this.safeJsonParse(row.stats as string, {
        pagesTotal: 0,
        pagesFetched: 0,
        pagesFailed: 0,
        pagesSkipped: 0,
        pagesUnchanged: 0,
        linksTotal: 0,
        imagesTotal: 0,
        bytesTotal: 0,
        avgLoadTimeMs: 0,
      }),
    };
  }

  // Pages
  upsertPage(
    crawlId: string,
    page: PageRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();

        // When content store is available, store HTML externally for deduplication + compression.
        // When not available (cloud), store HTML inline in the DB.
        let htmlToStore: string | null = page.html;
        let contentHashToStore = page.contentHash;
        if (page.html && this.contentStore) {
          const htmlHash = this.contentStore.put(page.html, "text/html");
          contentHashToStore = htmlHash;
          htmlToStore = null; // HTML is in content-store, not local DB
        }

        const stmt = db.prepare(`
          INSERT OR REPLACE INTO pages (
            crawl_id, url, normalized_url, final_url, depth, parent_url,
            redirect_chain, status, content_type, size_bytes, load_time_ms, ttfb, download_time, fetched_at,
            etag, last_modified, content_hash, html, parsed_data, headers, security_headers, request_headers,
            fetcher_id, fallback_reason, source_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          page.url,
          page.normalizedUrl,
          page.finalUrl,
          page.depth,
          page.parentUrl ?? null,
          page.redirectChain ? JSON.stringify(page.redirectChain) : null,
          page.status,
          page.contentType,
          page.sizeBytes,
          page.loadTimeMs,
          page.ttfb ?? null,
          page.downloadTime ?? null,
          page.fetchedAt,
          page.etag,
          page.lastModified,
          contentHashToStore, // Use HTML hash for retrieval
          htmlToStore, // null - HTML stored in content-store
          page.parsedData,
          JSON.stringify(page.headers),
          JSON.stringify(page.securityHeaders),
          page.requestHeaders ? JSON.stringify(page.requestHeaders) : null,
          page.fetcherId ?? null,
          page.fallbackReason ?? null,
          page.sourceHash ?? null
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getPage(
    crawlId: string,
    normalizedUrl: string
  ): Effect.Effect<PageRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM pages WHERE crawl_id = ? AND normalized_url = ?"
        );
        const row = stmt.get(crawlId, normalizedUrl) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return this.rowToPageRecord(row);
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getPages(
    crawlId: string,
    options?: PaginationOptions
  ): Effect.Effect<PageRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // Deterministic order so repeat audits emit pages/affected-URLs in a
        // stable order (#150) — normalized_url is the per-page primary key and
        // how findings are keyed, so sorting by it keeps report diffs minimal.
        let query =
          "SELECT * FROM pages WHERE crawl_id = ? ORDER BY normalized_url ASC";
        const params: unknown[] = [crawlId];

        if (options?.limit) {
          query += " LIMIT ?";
          params.push(options.limit);
        }
        if (options?.offset) {
          query += " OFFSET ?";
          params.push(options.offset);
        }

        const stmt = db.prepare(query);
        const rows = stmt.all(
          ...(params as (string | number | null)[])
        ) as Record<string, unknown>[];
        return rows.map((row) => this.rowToPageRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getPageCount(crawlId: string): Effect.Effect<number, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT COUNT(*) as count FROM pages WHERE crawl_id = ?"
        );
        const row = stmt.get(crawlId) as { count: number };
        return row.count;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  hasPage(
    crawlId: string,
    normalizedUrl: string
  ): Effect.Effect<boolean, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT 1 FROM pages WHERE crawl_id = ? AND normalized_url = ?"
        );
        return stmt.get(crawlId, normalizedUrl) !== undefined;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getCachedPage(
    normalizedUrl: string
  ): Effect.Effect<PageRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // Get most recent page by fetched_at across all crawls. `rowid DESC` is
        // a deterministic tie-break (#846): reuseCachedPage copies a cached row
        // into the current crawl without bumping fetched_at, so a hash_match
        // reuse (which persists a freshly-computed source_hash onto the copy)
        // ties the original row on fetched_at. Without the tie-break, SQLite's
        // pick between tied rows is unspecified and can return the older row,
        // shadowing the just-persisted source_hash. `rowid` tracks insert order
        // for this retained, append-like pages table (it isn't WITHOUT ROWID),
        // so DESC prefers the most recently written row on a tie.
        const stmt = db.prepare(`
          SELECT * FROM pages
          WHERE normalized_url = ?
          ORDER BY fetched_at DESC, rowid DESC
          LIMIT 1
        `);
        const row = stmt.get(normalizedUrl) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return this.rowToPageRecord(row);
      },
      catch: (e) => StorageError.read(e),
    });
  }

  private rowToPageRecord(row: Record<string, unknown>): PageRecord {
    const defaultHeaders: ResponseHeaders = {
      contentType: null,
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    };
    const defaultSecurityHeaders: SecurityHeaders = {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    };

    // Try to retrieve HTML from content-store if not in local DB
    let html = row.html as string | null;
    const contentHash = row.content_hash as string;
    if (!html && contentHash && this.contentStore) {
      html = this.contentStore.getString(contentHash);
    }

    return {
      url: row.url as string,
      normalizedUrl: row.normalized_url as string,
      finalUrl: (row.final_url as string | null) ?? (row.url as string),
      depth: row.depth as number,
      parentUrl: (row.parent_url as string | null) ?? undefined,
      redirectChain: row.redirect_chain
        ? this.safeJsonParse(row.redirect_chain as string, undefined)
        : undefined,
      status: row.status as number,
      contentType: row.content_type as string | null,
      sizeBytes: row.size_bytes as number,
      loadTimeMs: row.load_time_ms as number,
      ttfb: (row.ttfb as number | null) ?? undefined,
      downloadTime: (row.download_time as number | null) ?? undefined,
      fetchedAt: row.fetched_at as number,
      etag: row.etag as string | null,
      lastModified: row.last_modified as string | null,
      contentHash,
      html, // Retrieved from content-store if not in local DB
      parsedData: row.parsed_data as string | null,
      headers: this.safeJsonParse(row.headers as string, defaultHeaders),
      securityHeaders: this.safeJsonParse(
        row.security_headers as string,
        defaultSecurityHeaders
      ),
      requestHeaders: row.request_headers
        ? this.safeJsonParse<Record<string, string>>(
            row.request_headers as string,
            {}
          )
        : null,
      fetcherId: (row.fetcher_id as string | null) ?? undefined,
      fallbackReason: (row.fallback_reason as string | null) ?? undefined,
      sourceHash: (row.source_hash as string | null) ?? null,
    };
  }

  // Frontier
  upsertFrontier(
    crawlId: string,
    entry: FrontierRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO frontier (
            crawl_id, normalized_url, raw_url, depth, parent_url,
            priority, status, source, enqueued_at, fetched_at, retry_count, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          entry.normalizedUrl,
          entry.rawUrl,
          entry.depth,
          entry.parentUrl ?? null,
          entry.priority,
          entry.status,
          entry.source,
          entry.enqueuedAt,
          entry.fetchedAt ?? null,
          entry.retryCount,
          entry.reason ?? null
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getFrontierEntry(
    crawlId: string,
    normalizedUrl: string
  ): Effect.Effect<FrontierRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM frontier WHERE crawl_id = ? AND normalized_url = ?"
        );
        const row = stmt.get(crawlId, normalizedUrl) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return this.rowToFrontierRecord(row);
      },
      catch: (e) => StorageError.read(e),
    });
  }

  popNextUrl(
    crawlId: string
  ): Effect.Effect<FrontierRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();

        // Get next pending URL with highest priority (lowest priority value)
        const selectStmt = db.prepare(`
          SELECT * FROM frontier
          WHERE crawl_id = ? AND status = 'pending'
          ORDER BY priority ASC, enqueued_at ASC
          LIMIT 1
        `);
        const row = selectStmt.get(crawlId) as
          | Record<string, unknown>
          | undefined;

        if (!row) return null;

        // Update status to fetching
        const updateStmt = db.prepare(`
          UPDATE frontier SET status = 'fetching'
          WHERE crawl_id = ? AND normalized_url = ?
        `);
        updateStmt.run(crawlId, row.normalized_url as string);

        const record = this.rowToFrontierRecord(row);
        return { ...record, status: "fetching" as const };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Pop multiple URLs at once for parallel processing.
   * Returns up to `count` pending URLs and marks them as fetching.
   * `perHostLimit` (#440): cap URLs per host within the batch so one busy host
   * can't crowd out the others while its per-host throttle stalls the workers.
   */
  popNextUrls(
    crawlId: string,
    count: number,
    perHostLimit?: number
  ): Effect.Effect<FrontierRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();

        // Get next N pending URLs with highest priority
        const selectStmt = db.prepare(`
          SELECT * FROM frontier
          WHERE crawl_id = ? AND status = 'pending'
          ORDER BY priority ASC, enqueued_at ASC
          LIMIT ?
        `);
        const candidates = selectStmt.all(crawlId, count) as Record<
          string,
          unknown
        >[];

        if (candidates.length === 0) return [];

        const rows = capBatchPerHost(candidates, perHostLimit);

        // Update all selected to fetching in one transaction
        const updateStmt = db.prepare(`
          UPDATE frontier SET status = 'fetching'
          WHERE crawl_id = ? AND normalized_url = ?
        `);
        const updateAll = db.transaction(() => {
          for (const row of rows) {
            updateStmt.run(crawlId, row.normalized_url as string);
          }
        });
        updateAll();

        return rows.map((row) => ({
          ...this.rowToFrontierRecord(row),
          status: "fetching" as const,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getPendingCount(crawlId: string): Effect.Effect<number, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT COUNT(*) as count FROM frontier WHERE crawl_id = ? AND status = 'pending'"
        );
        const row = stmt.get(crawlId) as { count: number };
        return row.count;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getFetchingCount(
    crawlId: string
  ): Effect.Effect<number, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT COUNT(*) as count FROM frontier WHERE crawl_id = ? AND status = 'fetching'"
        );
        const row = stmt.get(crawlId) as { count: number };
        return row.count;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  updateFrontierStatus(
    crawlId: string,
    normalizedUrl: string,
    status: FrontierStatus,
    reason?: string
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const fetchedAt =
          status === "done" || status === "failed" ? Date.now() : null;

        if (reason !== undefined) {
          const stmt = db.prepare(`
            UPDATE frontier
            SET status = ?, reason = ?, fetched_at = COALESCE(?, fetched_at)
            WHERE crawl_id = ? AND normalized_url = ?
          `);
          stmt.run(status, reason, fetchedAt, crawlId, normalizedUrl);
        } else {
          const stmt = db.prepare(`
            UPDATE frontier
            SET status = ?, fetched_at = COALESCE(?, fetched_at)
            WHERE crawl_id = ? AND normalized_url = ?
          `);
          stmt.run(status, fetchedAt, crawlId, normalizedUrl);
        }
      },
      catch: (e) => StorageError.write(e),
    });
  }

  resetStaleFetching(
    crawlId: string
  ): Effect.Effect<number, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          UPDATE frontier
          SET status = 'pending', reason = NULL, fetched_at = NULL
          WHERE crawl_id = ? AND status = 'fetching'
        `);
        const result = stmt.run(crawlId);
        return result.changes;
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getAllFrontierEntries(
    crawlId: string
  ): Effect.Effect<FrontierRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM frontier WHERE crawl_id = ?");
        const rows = stmt.all(crawlId) as Record<string, unknown>[];
        return rows.map((row) => this.rowToFrontierRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  clearFrontier(crawlId: string): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        db.prepare("DELETE FROM frontier WHERE crawl_id = ?").run(crawlId);
      },
      catch: (e) => StorageError.write(e),
    });
  }

  clearCrawlData(crawlId: string): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // Clear all derived data, but keep pages for conditional GET cache
        // Pages will be upserted (updated) during re-crawl
        db.prepare("DELETE FROM rule_results WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM image_appearances WHERE crawl_id = ?").run(
          crawlId
        );
        db.prepare("DELETE FROM images WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM link_appearances WHERE crawl_id = ?").run(
          crawlId
        );
        db.prepare("DELETE FROM links WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM sitemap_urls WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM sitemaps WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM robots_txt WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM llms_txt WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM markdown_response WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM agent_well_known WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM agent_access WHERE crawl_id = ?").run(crawlId);
        db.prepare("DELETE FROM agent_rsl WHERE crawl_id = ?").run(crawlId);
        // NOTE: pages intentionally NOT cleared - used for conditional GET cache
        db.prepare("DELETE FROM frontier WHERE crawl_id = ?").run(crawlId);
      },
      catch: (e) => StorageError.write(e),
    });
  }

  private rowToFrontierRecord(row: Record<string, unknown>): FrontierRecord {
    return {
      normalizedUrl: row.normalized_url as string,
      rawUrl: row.raw_url as string,
      depth: row.depth as number,
      parentUrl: (row.parent_url as string | null) ?? undefined,
      priority: row.priority as number,
      status: row.status as FrontierStatus,
      source: row.source as FrontierRecord["source"],
      enqueuedAt: row.enqueued_at as number,
      fetchedAt: (row.fetched_at as number | null) ?? undefined,
      retryCount: row.retry_count as number,
      reason: (row.reason as string | null) ?? undefined,
    };
  }

  // Links
  upsertLink(
    crawlId: string,
    link: LinkRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO links (crawl_id, href, is_internal, status, error, checked_at, waf_blocked, waf_provider)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          link.href,
          link.isInternal ? 1 : 0,
          link.status ?? null,
          link.error ?? null,
          link.checkedAt ?? null,
          link.wafBlocked ? 1 : null,
          link.wafProvider ?? null
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getLink(
    crawlId: string,
    href: string
  ): Effect.Effect<LinkRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM links WHERE crawl_id = ? AND href = ?"
        );
        const row = stmt.get(crawlId, href) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return this.rowToLinkRecord(row);
      },
      catch: (e) => StorageError.read(e),
    });
  }

  addLinkAppearance(
    crawlId: string,
    appearance: LinkAppearanceRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT INTO link_appearances (crawl_id, href, page_url, anchor_text, position, rel, is_nofollow)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          appearance.href,
          appearance.pageUrl,
          appearance.anchorText,
          appearance.position,
          appearance.rel ? JSON.stringify(appearance.rel) : null,
          appearance.isNofollow ? 1 : 0
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /**
   * Batch insert link appearances in a single transaction.
   * Much faster than individual inserts for pages with many links.
   */
  addLinkAppearancesBatch(
    crawlId: string,
    appearances: LinkAppearanceRecord[]
  ): Effect.Effect<void, StorageError, never> {
    if (appearances.length === 0) {
      return Effect.void;
    }
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT INTO link_appearances (crawl_id, href, page_url, anchor_text, position, rel, is_nofollow)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertAll = db.transaction(() => {
          for (const appearance of appearances) {
            stmt.run(
              crawlId,
              appearance.href,
              appearance.pageUrl,
              appearance.anchorText,
              appearance.position,
              appearance.rel ? JSON.stringify(appearance.rel) : null,
              appearance.isNofollow ? 1 : 0
            );
          }
        });
        insertAll();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getLinks(
    crawlId: string,
    options?: { unchecked?: boolean }
  ): Effect.Effect<LinkRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        let query = "SELECT * FROM links WHERE crawl_id = ?";
        if (options?.unchecked) {
          query += " AND status IS NULL";
        }
        // Deterministic order so repeat audits emit affected-URL lists in a
        // stable order (#150). href is the per-link primary key here (the
        // links table has no normalized_url column).
        query += " ORDER BY href ASC";
        const stmt = db.prepare(query);
        const rows = stmt.all(crawlId) as Record<string, unknown>[];
        return rows.map((row) => this.rowToLinkRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getLinkAppearances(
    crawlId: string,
    href: string
  ): Effect.Effect<LinkAppearanceRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM link_appearances WHERE crawl_id = ? AND href = ?"
        );
        const rows = stmt.all(crawlId, href) as Record<string, unknown>[];
        return rows.map((row) => this.rowToLinkAppearanceRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getIncomingLinkCount(
    crawlId: string,
    normalizedUrl: string
  ): Effect.Effect<number, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT COUNT(*) as count FROM link_appearances WHERE crawl_id = ? AND href = ?"
        );
        const row = stmt.get(crawlId, normalizedUrl) as { count: number };
        return row.count;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get all incoming link counts in a single query.
   * Eliminates N+1 queries when prioritizing URLs during crawl.
   */
  getAllIncomingLinkCounts(
    crawlId: string
  ): Effect.Effect<Map<string, number>, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          SELECT href, COUNT(*) as count
          FROM link_appearances
          WHERE crawl_id = ?
          GROUP BY href
        `);
        const rows = stmt.all(crawlId) as Array<{
          href: string;
          count: number;
        }>;
        const map = new Map<string, number>();
        for (const row of rows) {
          map.set(row.href, row.count);
        }
        return map;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getLinksByPage(
    pageUrl: string
  ): Effect.Effect<LinkRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // Get links that appear on this page (most recent crawl that has them)
        const stmt = db.prepare(`
          SELECT DISTINCT l.* FROM links l
          INNER JOIN link_appearances la ON l.crawl_id = la.crawl_id AND l.href = la.href
          WHERE la.page_url = ?
          ORDER BY l.crawl_id DESC
        `);
        const rows = stmt.all(pageUrl) as Record<string, unknown>[];
        return rows.map((row) => this.rowToLinkRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  private rowToLinkRecord(row: Record<string, unknown>): LinkRecord {
    return {
      href: row.href as string,
      isInternal: (row.is_internal as number) === 1,
      status: (row.status as number | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
      checkedAt: (row.checked_at as number | null) ?? undefined,
      wafBlocked: (row.waf_blocked as number | null) === 1 ? true : undefined,
      wafProvider: (row.waf_provider as string | null) ?? undefined,
    };
  }

  private rowToLinkAppearanceRecord(
    row: Record<string, unknown>
  ): LinkAppearanceRecord {
    return {
      href: row.href as string,
      pageUrl: row.page_url as string,
      anchorText: row.anchor_text as string,
      position: row.position as LinkAppearanceRecord["position"],
      rel: row.rel
        ? this.safeJsonParse<string[]>(row.rel as string, [])
        : undefined,
      isNofollow: (row.is_nofollow as number) === 1,
    };
  }

  // Images
  upsertImage(
    crawlId: string,
    image: ImageRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO images (crawl_id, src, status, error, checked_at, content_type, size)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          image.src,
          image.status ?? null,
          image.error ?? null,
          image.checkedAt ?? null,
          image.contentType ?? null,
          image.size ?? null
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getImage(
    crawlId: string,
    src: string
  ): Effect.Effect<ImageRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM images WHERE crawl_id = ? AND src = ?"
        );
        const row = stmt.get(crawlId, src) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return this.rowToImageRecord(row);
      },
      catch: (e) => StorageError.read(e),
    });
  }

  addImageAppearance(
    crawlId: string,
    appearance: ImageAppearanceRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT INTO image_appearances (crawl_id, src, page_url, alt, width, height, is_lazy_loaded, in_figure)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          appearance.src,
          appearance.pageUrl,
          appearance.alt ?? null,
          appearance.width ?? null,
          appearance.height ?? null,
          appearance.isLazyLoaded ? 1 : 0,
          appearance.inFigure ? 1 : 0
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getImages(
    crawlId: string
  ): Effect.Effect<ImageRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // Deterministic order so repeat audits emit affected-URL lists in a
        // stable order (#150). src is the per-image primary key here (the
        // images table has no normalized_url column).
        const stmt = db.prepare(
          "SELECT * FROM images WHERE crawl_id = ? ORDER BY src ASC"
        );
        const rows = stmt.all(crawlId) as Record<string, unknown>[];
        return rows.map((row) => this.rowToImageRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getImageAppearances(
    crawlId: string,
    src: string
  ): Effect.Effect<ImageAppearanceRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM image_appearances WHERE crawl_id = ? AND src = ?"
        );
        const rows = stmt.all(crawlId, src) as Record<string, unknown>[];
        return rows.map((row) => this.rowToImageAppearanceRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getImagesByPage(
    pageUrl: string
  ): Effect.Effect<ImageRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // Get images that appear on this page (most recent crawl that has them)
        const stmt = db.prepare(`
          SELECT DISTINCT i.* FROM images i
          INNER JOIN image_appearances ia ON i.crawl_id = ia.crawl_id AND i.src = ia.src
          WHERE ia.page_url = ?
          ORDER BY i.crawl_id DESC
        `);
        const rows = stmt.all(pageUrl) as Record<string, unknown>[];
        return rows.map((row) => this.rowToImageRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  private rowToImageRecord(row: Record<string, unknown>): ImageRecord {
    return {
      src: row.src as string,
      status: (row.status as number | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
      checkedAt: (row.checked_at as number | null) ?? undefined,
      contentType: (row.content_type as string | null) ?? undefined,
      size: (row.size as number | null) ?? undefined,
    };
  }

  private rowToImageAppearanceRecord(
    row: Record<string, unknown>
  ): ImageAppearanceRecord {
    return {
      src: row.src as string,
      pageUrl: row.page_url as string,
      alt: (row.alt as string | null) ?? undefined,
      width: (row.width as string | null) ?? undefined,
      height: (row.height as string | null) ?? undefined,
      isLazyLoaded: (row.is_lazy_loaded as number) === 1,
      inFigure: (row.in_figure as number) === 1,
    };
  }

  // Robots & Sitemaps
  setRobotsTxt(
    crawlId: string,
    robots: RobotsTxtRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO robots_txt (crawl_id, url, found, content, size_bytes, sitemaps, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          robots.url,
          robots.exists ? 1 : 0,
          robots.content,
          robots.sizeBytes,
          JSON.stringify(robots.sitemaps),
          robots.fetchedAt
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getRobotsTxt(
    crawlId: string
  ): Effect.Effect<RobotsTxtRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM robots_txt WHERE crawl_id = ?");
        const row = stmt.get(crawlId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          url: row.url as string,
          exists: (row.found as number) === 1,
          content: row.content as string | null,
          sizeBytes: row.size_bytes as number,
          sitemaps: this.safeJsonParse<string[]>(row.sitemaps as string, []),
          fetchedAt: row.fetched_at as number,
        };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  setLlmsTxt(crawlId: string, llms: LlmsTxtRecord): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO llms_txt (crawl_id, llms_url, llms_found, llms_content, llms_size_bytes, full_url, full_found, full_content, full_size_bytes, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          llms.llmsTxt.url,
          llms.llmsTxt.exists ? 1 : 0,
          llms.llmsTxt.content,
          llms.llmsTxt.sizeBytes,
          llms.llmsFullTxt.url,
          llms.llmsFullTxt.exists ? 1 : 0,
          llms.llmsFullTxt.content,
          llms.llmsFullTxt.sizeBytes,
          llms.fetchedAt
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getLlmsTxt(crawlId: string): Effect.Effect<LlmsTxtRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM llms_txt WHERE crawl_id = ?");
        const row = stmt.get(crawlId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          llmsTxt: {
            url: row.llms_url as string,
            exists: (row.llms_found as number) === 1,
            content: row.llms_content as string | null,
            sizeBytes: row.llms_size_bytes as number,
          },
          llmsFullTxt: {
            url: row.full_url as string,
            exists: (row.full_found as number) === 1,
            content: row.full_content as string | null,
            sizeBytes: row.full_size_bytes as number,
          },
          fetchedAt: row.fetched_at as number,
        };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  setMarkdownProbe(
    crawlId: string,
    probe: MarkdownProbeRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO markdown_response (crawl_id, negotiated_url, negotiated_content_type, serves_markdown, md_variant_url, md_variant_exists, md_variant_content_type, negotiated_vary, markdown_tokens_header, original_tokens_header, alternate_markdown_url, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          probe.negotiatedUrl,
          probe.negotiatedContentType,
          probe.servesMarkdown ? 1 : 0,
          probe.mdVariantUrl,
          probe.mdVariantExists ? 1 : 0,
          probe.mdVariantContentType,
          probe.negotiatedVary ?? null,
          probe.markdownTokensHeader ?? null,
          probe.originalTokensHeader ?? null,
          probe.alternateMarkdownUrl ?? null,
          probe.fetchedAt
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getMarkdownProbe(
    crawlId: string
  ): Effect.Effect<MarkdownProbeRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM markdown_response WHERE crawl_id = ?");
        const row = stmt.get(crawlId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          negotiatedUrl: row.negotiated_url as string,
          negotiatedContentType: row.negotiated_content_type as string | null,
          servesMarkdown: (row.serves_markdown as number) === 1,
          mdVariantUrl: row.md_variant_url as string,
          mdVariantExists: (row.md_variant_exists as number) === 1,
          mdVariantContentType: row.md_variant_content_type as string | null,
          // Columns added in schema v17 — undefined (not null) on rows persisted
          // before this migration ran, since `row.x` is `undefined` for a column
          // SQLite has no value for yet vs. a column that exists and is NULL.
          negotiatedVary: (row.negotiated_vary as string | null | undefined) ?? null,
          markdownTokensHeader: (row.markdown_tokens_header as string | null | undefined) ?? null,
          originalTokensHeader: (row.original_tokens_header as string | null | undefined) ?? null,
          alternateMarkdownUrl: (row.alternate_markdown_url as string | null | undefined) ?? null,
          fetchedAt: row.fetched_at as number,
        };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  // AX: well-known/agent-file probes — JSON blob per crawl.
  setWellKnownProbe(
    crawlId: string,
    probe: WellKnownProbeRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO agent_well_known (crawl_id, probes, fetched_at)
          VALUES (?, ?, ?)
        `);
        stmt.run(crawlId, JSON.stringify(probe.probes), probe.fetchedAt);
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getWellKnownProbe(
    crawlId: string
  ): Effect.Effect<WellKnownProbeRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM agent_well_known WHERE crawl_id = ?");
        const row = stmt.get(crawlId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          probes: this.safeJsonParse<WellKnownProbeRecord["probes"]>(row.probes as string, []),
          fetchedAt: row.fetched_at as number,
        };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  // AX: homepage access probes (browser/gptbot/claude-user) — JSON blob per crawl.
  setAgentAccess(
    crawlId: string,
    access: AgentAccessRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO agent_access (crawl_id, probes, fetched_at)
          VALUES (?, ?, ?)
        `);
        stmt.run(crawlId, JSON.stringify(access.probes), access.fetchedAt);
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getAgentAccess(
    crawlId: string
  ): Effect.Effect<AgentAccessRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM agent_access WHERE crawl_id = ?");
        const row = stmt.get(crawlId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          probes: this.safeJsonParse<AgentAccessRecord["probes"]>(row.probes as string, []),
          fetchedAt: row.fetched_at as number,
        };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  // AX: robots.txt-derived RSL licensing fetch.
  setRsl(crawlId: string, rsl: RslRecord): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO agent_rsl (crawl_id, license_urls, robots_has_license, link_header_present, documents, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          JSON.stringify(rsl.licenseUrls),
          rsl.robotsHasLicense ? 1 : 0,
          rsl.linkHeaderPresent ? 1 : 0,
          JSON.stringify(rsl.documents),
          rsl.fetchedAt
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getRsl(crawlId: string): Effect.Effect<RslRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM agent_rsl WHERE crawl_id = ?");
        const row = stmt.get(crawlId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          licenseUrls: this.safeJsonParse<string[]>(row.license_urls as string, []),
          robotsHasLicense: (row.robots_has_license as number) === 1,
          linkHeaderPresent: (row.link_header_present as number) === 1,
          documents: this.safeJsonParse<RslRecord["documents"]>(row.documents as string, []),
          fetchedAt: row.fetched_at as number,
        };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  addSitemap(
    crawlId: string,
    sitemap: SitemapRecord
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO sitemaps (crawl_id, url, type, url_count, child_sitemaps, errors, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          sitemap.url,
          sitemap.type,
          sitemap.urlCount,
          JSON.stringify(sitemap.childSitemaps),
          JSON.stringify(sitemap.errors),
          sitemap.fetchedAt
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getSitemaps(
    crawlId: string
  ): Effect.Effect<SitemapRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM sitemaps WHERE crawl_id = ?");
        const rows = stmt.all(crawlId) as Record<string, unknown>[];
        return rows.map((row) => ({
          url: row.url as string,
          type: row.type as SitemapRecord["type"],
          urlCount: row.url_count as number,
          childSitemaps: this.safeJsonParse<string[]>(
            row.child_sitemaps as string,
            []
          ),
          errors: this.safeJsonParse<string[]>(row.errors as string, []),
          fetchedAt: row.fetched_at as number,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  addSitemapUrls(
    crawlId: string,
    urls: SitemapUrlRecord[]
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT INTO sitemap_urls (crawl_id, sitemap_url, loc, lastmod, changefreq, priority)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        const transaction = db.transaction(() => {
          for (const url of urls) {
            stmt.run(
              crawlId,
              url.sitemapUrl,
              url.loc,
              url.lastmod ?? null,
              url.changefreq ?? null,
              url.priority ?? null
            );
          }
        });
        transaction();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getSitemapUrls(
    crawlId: string,
    sitemapUrl: string
  ): Effect.Effect<SitemapUrlRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM sitemap_urls WHERE crawl_id = ? AND sitemap_url = ?"
        );
        const rows = stmt.all(crawlId, sitemapUrl) as Record<string, unknown>[];
        return rows.map((row) => ({
          sitemapUrl: row.sitemap_url as string,
          loc: row.loc as string,
          lastmod: (row.lastmod as string | null) ?? undefined,
          changefreq: (row.changefreq as string | null) ?? undefined,
          priority: (row.priority as number | null) ?? undefined,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  // Stats
  updateStats(
    crawlId: string,
    updates: Partial<CrawlStats>
  ): Effect.Effect<void, StorageError, never> {
    return Effect.gen(this, function* () {
      const crawl = yield* this.getCrawl(crawlId);
      if (!crawl) return;

      const newStats = { ...crawl.stats, ...updates };
      yield* this.updateCrawl(crawlId, { stats: newStats });
    });
  }

  getStats(
    crawlId: string
  ): Effect.Effect<CrawlStats | null, StorageError, never> {
    return Effect.gen(this, function* () {
      const crawl = yield* this.getCrawl(crawlId);
      return crawl?.stats ?? null;
    });
  }

  saveResourceSizes(
    crawlId: string,
    records: ResourceSizeRecord[]
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        if (records.length === 0) return;
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO resource_sizes (
            crawl_id, type, url, status, error, content_type, size_bytes, source_pages,
            content_encoding, transfer_bytes, cache_control, etag, last_modified, vary, cache_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const transaction = db.transaction(() => {
          for (const record of records) {
            stmt.run(
              crawlId,
              record.type,
              record.url,
              record.status,
              record.error,
              record.contentType,
              record.sizeBytes,
              JSON.stringify(record.sourcePages),
              record.contentEncoding ?? null,
              record.transferBytes ?? null,
              record.cacheControl ?? null,
              record.etag ?? null,
              record.lastModified ?? null,
              record.vary ?? null,
              record.cacheReason ?? null
            );
          }
        });
        transaction();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getResourceSizes(
    crawlId: string
  ): Effect.Effect<ResourceSizeRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM resource_sizes WHERE crawl_id = ?"
        );
        const rows = stmt.all(crawlId) as Record<string, unknown>[];
        return rows.map((row) => this.rowToResourceSizeRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getCachedResources(
    crawlId: string
  ): Effect.Effect<CachedResourceRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // The single most-recent resource per (type, url) across all OTHER
        // crawls, paired with that crawl's start time (resource_sizes has no
        // per-row timestamp). "Most recent" is ordered by (started_at, crawl_id)
        // so ties on started_at resolve deterministically to ONE row — exactly
        // one row per (type, url), no dupes. Expressed as a NOT EXISTS
        // anti-join (no window functions) for the bun:sqlite version in use.
        const stmt = db.prepare(`
          SELECT rs.*, c.started_at AS started_at
          FROM resource_sizes rs
          JOIN crawls c ON c.id = rs.crawl_id
          WHERE rs.crawl_id != ?
            AND NOT EXISTS (
              SELECT 1
              FROM resource_sizes rs2
              JOIN crawls c2 ON c2.id = rs2.crawl_id
              WHERE rs2.type = rs.type
                AND rs2.url = rs.url
                AND rs2.crawl_id != ?
                AND (
                  c2.started_at > c.started_at
                  OR (c2.started_at = c.started_at AND rs2.crawl_id > rs.crawl_id)
                )
            )
        `);
        const rows = stmt.all(crawlId, crawlId) as Record<string, unknown>[];
        return rows.map((row) => ({
          ...this.rowToResourceSizeRecord(row),
          fetchedAt: (row.started_at as number | null) ?? 0,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  saveSitemapUrlStatuses(
    crawlId: string,
    statuses: SitemapUrlStatusRecord[]
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        if (statuses.length === 0) return;
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO sitemap_url_statuses (
            crawl_id, url, status, error
          ) VALUES (?, ?, ?, ?)
        `);
        const transaction = db.transaction(() => {
          for (const status of statuses) {
            stmt.run(crawlId, status.url, status.status, status.error);
          }
        });
        transaction();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getSitemapUrlStatuses(
    crawlId: string
  ): Effect.Effect<SitemapUrlStatusRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM sitemap_url_statuses WHERE crawl_id = ?"
        );
        const rows = stmt.all(crawlId) as Record<string, unknown>[];
        return rows.map((row) => ({
          url: row.url as string,
          status: (row.status as number | null) ?? null,
          error: (row.error as string | null) ?? null,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  // Rule results
  saveRuleResults(
    crawlId: string,
    pageUrl: string,
    ruleId: string,
    checks: CheckResult[]
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT INTO rule_results (
            crawl_id, page_url, rule_id, check_name, status, message,
            value, expected, items, details, pages, skip_reason, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const timestamp = Date.now();
        const transaction = db.transaction(() => {
          for (const check of checks) {
            stmt.run(
              crawlId,
              pageUrl,
              ruleId,
              check.name,
              check.status,
              check.message,
              check.value !== undefined ? String(check.value) : null,
              check.expected !== undefined ? String(check.expected) : null,
              check.items ? JSON.stringify(check.items) : null,
              check.details ? JSON.stringify(check.details) : null,
              check.pages ? JSON.stringify(check.pages) : null,
              check.skipReason || null,
              timestamp
            );
          }
        });
        transaction();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getRuleResults(
    crawlId: string,
    pageUrl?: string
  ): Effect.Effect<CheckResult[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        let query = "SELECT * FROM rule_results WHERE crawl_id = ?";
        const params: unknown[] = [crawlId];

        if (pageUrl !== undefined) {
          query += " AND page_url = ?";
          params.push(pageUrl);
        }

        const stmt = db.prepare(query);
        const rows = stmt.all(
          ...(params as (string | number | null)[])
        ) as Record<string, unknown>[];

        return rows.map((row) => ({
          name: row.check_name as string,
          status: row.status as CheckResult["status"],
          message: row.message as string,
          value:
            row.value !== null ? (row.value as string | number) : undefined,
          expected:
            row.expected !== null
              ? (row.expected as string | number)
              : undefined,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Batch save rule results for multiple pages in a single transaction
   */
  saveRuleResultsBatch(
    crawlId: string,
    pageResults: Map<string, { ruleId: string; checks: CheckResult[] }[]>
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT INTO rule_results (
            crawl_id, page_url, rule_id, check_name, status, message,
            value, expected, items, details, pages, skip_reason, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const timestamp = Date.now();
        const transaction = db.transaction(() => {
          for (const [pageUrl, results] of pageResults) {
            for (const { ruleId, checks } of results) {
              for (const check of checks) {
                stmt.run(
                  crawlId,
                  pageUrl,
                  ruleId,
                  check.name,
                  check.status,
                  check.message,
                  check.value !== undefined ? String(check.value) : null,
                  check.expected !== undefined ? String(check.expected) : null,
                  check.items ? JSON.stringify(check.items) : null,
                  check.details ? JSON.stringify(check.details) : null,
                  check.pages ? JSON.stringify(check.pages) : null,
                  check.skipReason || null,
                  timestamp
                );
              }
            }
          }
        });
        transaction();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /**
   * Get all link appearances grouped by page URL
   * Returns Map<pageUrl, LinkAppearanceRecord[]>
   */
  getAllLinkAppearancesByPage(
    crawlId: string
  ): Effect.Effect<Map<string, LinkAppearanceRecord[]>, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM link_appearances WHERE crawl_id = ? ORDER BY page_url"
        );
        const rows = stmt.all(crawlId) as Record<string, unknown>[];

        const result = new Map<string, LinkAppearanceRecord[]>();
        for (const row of rows) {
          const record = this.rowToLinkAppearanceRecord(row);
          const existing = result.get(record.pageUrl) ?? [];
          existing.push(record);
          result.set(record.pageUrl, existing);
        }
        return result;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get all image appearances grouped by page URL
   * Returns Map<pageUrl, ImageAppearanceRecord[]>
   */
  getAllImageAppearancesByPage(
    crawlId: string
  ): Effect.Effect<Map<string, ImageAppearanceRecord[]>, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM image_appearances WHERE crawl_id = ? ORDER BY page_url"
        );
        const rows = stmt.all(crawlId) as Record<string, unknown>[];

        const result = new Map<string, ImageAppearanceRecord[]>();
        for (const row of rows) {
          const record = this.rowToImageAppearanceRecord(row);
          const existing = result.get(record.pageUrl) ?? [];
          existing.push(record);
          result.set(record.pageUrl, existing);
        }
        return result;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get all link appearances grouped by href
   * Returns Map<href, LinkAppearanceRecord[]>
   * Used to batch-lookup appearances for multiple links in one query
   */
  getAllLinkAppearancesByHref(
    crawlId: string
  ): Effect.Effect<Map<string, LinkAppearanceRecord[]>, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM link_appearances WHERE crawl_id = ? ORDER BY href"
        );
        const rows = stmt.all(crawlId) as Record<string, unknown>[];

        const result = new Map<string, LinkAppearanceRecord[]>();
        for (const row of rows) {
          const record = this.rowToLinkAppearanceRecord(row);
          const existing = result.get(record.href) ?? [];
          existing.push(record);
          result.set(record.href, existing);
        }
        return result;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get all image appearances grouped by src
   * Returns Map<src, ImageAppearanceRecord[]>
   * Used to batch-lookup appearances for multiple images in one query
   */
  getAllImageAppearancesBySrc(
    crawlId: string
  ): Effect.Effect<Map<string, ImageAppearanceRecord[]>, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM image_appearances WHERE crawl_id = ? ORDER BY src"
        );
        const rows = stmt.all(crawlId) as Record<string, unknown>[];

        const result = new Map<string, ImageAppearanceRecord[]>();
        for (const row of rows) {
          const record = this.rowToImageAppearanceRecord(row);
          const existing = result.get(record.src) ?? [];
          existing.push(record);
          result.set(record.src, existing);
        }
        return result;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get link appearances for a specific page (uses index on page_url)
   */
  getLinkAppearancesForPage(
    crawlId: string,
    pageUrl: string
  ): Effect.Effect<LinkAppearanceRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM link_appearances WHERE crawl_id = ? AND page_url = ?"
        );
        const rows = stmt.all(crawlId, pageUrl) as Record<string, unknown>[];
        return rows.map((row) => this.rowToLinkAppearanceRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get image appearances for a specific page (uses index on page_url)
   */
  getImageAppearancesForPage(
    crawlId: string,
    pageUrl: string
  ): Effect.Effect<ImageAppearanceRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM image_appearances WHERE crawl_id = ? AND page_url = ?"
        );
        const rows = stmt.all(crawlId, pageUrl) as Record<string, unknown>[];
        return rows.map((row) => this.rowToImageAppearanceRecord(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get rule results grouped by page URL
   * Returns Map<pageUrl, CheckResult[]>
   */
  getRuleResultsByPage(
    crawlId: string
  ): Effect.Effect<Map<string, CheckResult[]>, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM rule_results WHERE crawl_id = ? ORDER BY page_url"
        );
        const rows = stmt.all(crawlId) as Record<string, unknown>[];

        const result = new Map<string, CheckResult[]>();
        for (const row of rows) {
          const pageUrl = row.page_url as string;
          const check: CheckResult = {
            name: row.check_name as string,
            status: row.status as CheckResult["status"],
            message: row.message as string,
            value:
              row.value !== null ? (row.value as string | number) : undefined,
            expected:
              row.expected !== null
                ? (row.expected as string | number)
                : undefined,
            pageUrl: pageUrl || undefined,
            items: row.items ? JSON.parse(row.items as string) : undefined,
            details: row.details
              ? JSON.parse(row.details as string)
              : undefined,
            pages: row.pages ? JSON.parse(row.pages as string) : undefined,
            skipReason: row.skip_reason
              ? (row.skip_reason as string)
              : undefined,
          };
          const existing = result.get(pageUrl) ?? [];
          existing.push(check);
          result.set(pageUrl, existing);
        }
        return result;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get rule results grouped by rule_id
   * Returns Map<ruleId, CheckResult[]>
   */
  getRuleResultsByRuleId(
    crawlId: string
  ): Effect.Effect<Map<string, CheckResult[]>, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM rule_results WHERE crawl_id = ? ORDER BY rule_id"
        );
        const rows = stmt.all(crawlId) as Record<string, unknown>[];

        const result = new Map<string, CheckResult[]>();
        for (const row of rows) {
          const ruleId = row.rule_id as string;
          const pageUrl = row.page_url as string;
          const check: CheckResult = {
            name: row.check_name as string,
            status: row.status as CheckResult["status"],
            message: row.message as string,
            value:
              row.value !== null ? (row.value as string | number) : undefined,
            expected:
              row.expected !== null
                ? (row.expected as string | number)
                : undefined,
            pageUrl: pageUrl || undefined,
            items: row.items ? JSON.parse(row.items as string) : undefined,
            details: row.details
              ? JSON.parse(row.details as string)
              : undefined,
            pages: row.pages ? JSON.parse(row.pages as string) : undefined,
            skipReason: row.skip_reason
              ? (row.skip_reason as string)
              : undefined,
          };
          const existing = result.get(ruleId) ?? [];
          existing.push(check);
          result.set(ruleId, existing);
        }
        return result;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getCrawlByUrl(
    baseUrl: string
  ): Effect.Effect<CrawlMetadata | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM crawls WHERE base_url = ? ORDER BY started_at DESC LIMIT 1"
        );
        const row = stmt.get(baseUrl) as Record<string, unknown> | undefined;
        if (!row) return null;
        return this.rowToCrawlMetadata(row);
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get crawls matching an ID prefix (first 8 hex chars)
   * Returns up to 2 matches to detect ambiguity
   */
  getCrawlsByPrefix(
    prefix: string
  ): Effect.Effect<CrawlMetadata[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare("SELECT * FROM crawls WHERE id LIKE ? LIMIT 2");
        const rows = stmt.all(`${prefix}%`) as Record<string, unknown>[];
        return rows.map((row) => this.rowToCrawlMetadata(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  // ============================================
  // PUBLISHED REPORTS
  // ============================================

  /**
   * Save published report metadata
   */
  savePublishedReport(
    crawlId: string,
    reportId: string,
    url: string,
    visibility: string,
    publishedAt: string
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO published_reports (crawl_id, report_id, url, visibility, published_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(crawlId, reportId, url, visibility, publishedAt);
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /**
   * Get published report for a crawl
   */
  getPublishedReport(
    crawlId: string
  ): Effect.Effect<PublishedReportRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(
          "SELECT * FROM published_reports WHERE crawl_id = ?"
        );
        const row = stmt.get(crawlId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          crawlId: row.crawl_id as string,
          reportId: row.report_id as string,
          url: row.url as string,
          visibility: row.visibility as PublishedReportRecord["visibility"],
          publishedAt: row.published_at as string,
        };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Get published reports for multiple crawls (batch query to avoid N+1)
   */
  getPublishedReportsBatch(
    crawlIds: string[]
  ): Effect.Effect<Map<string, PublishedReportRecord>, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const result = new Map<string, PublishedReportRecord>();

        if (crawlIds.length === 0) return result;

        // Use parameterized query with placeholders
        const placeholders = crawlIds.map(() => "?").join(",");
        const stmt = db.prepare(
          `SELECT * FROM published_reports WHERE crawl_id IN (${placeholders})`
        );
        const rows = stmt.all(...crawlIds) as Array<Record<string, unknown>>;

        for (const row of rows) {
          const record: PublishedReportRecord = {
            crawlId: row.crawl_id as string,
            reportId: row.report_id as string,
            url: row.url as string,
            visibility: row.visibility as PublishedReportRecord["visibility"],
            publishedAt: row.published_at as string,
          };
          result.set(record.crawlId, record);
        }

        return result;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  // ============================================
  // SMART AUDITS — SITE-SCOPED FINDING STORE (#110)
  // ============================================

  /**
   * Upsert merged findings. Idempotent on the PK
   * (site_key, normalized_url, rule_id, check_name, locator).
   */
  upsertFindings(
    findings: PageFindingRecord[]
  ): Effect.Effect<void, StorageError, never> {
    if (findings.length === 0) return Effect.void;
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO page_findings (
            site_key, normalized_url, rule_id, check_name, locator,
            status, severity, message, value, expected, payload, fingerprint,
            first_seen_at, last_seen_crawl_id, last_seen_at, provenance, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertAll = db.transaction(() => {
          for (const f of findings) {
            stmt.run(
              f.siteKey,
              f.normalizedUrl,
              f.ruleId,
              f.checkName,
              f.locator,
              f.status,
              f.severity,
              f.message,
              f.value,
              f.expected,
              f.payload,
              f.fingerprint,
              f.firstSeenAt,
              f.lastSeenCrawlId,
              f.lastSeenAt,
              f.provenance,
              f.state
            );
          }
        });
        insertAll();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getFindings(
    siteKey: string,
    states?: PageFindingRecord["state"][]
  ): Effect.Effect<PageFindingRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // Optional state filter — the merge hot-path passes ["open"] so it never
        // scans the resolved/stale history (can be large on churny sites, #197).
        // Deterministic order so repeat audits emit findings in a stable order
        // (#150) — normalized_url is how findings are keyed (diff-friendly);
        // the rest of the primary key tie-breaks for total determinism.
        const orderBy =
          " ORDER BY normalized_url ASC, rule_id ASC, check_name ASC, locator ASC";
        if (states && states.length > 0) {
          const placeholders = states.map(() => "?").join(",");
          const stmt = db.prepare(
            `SELECT * FROM page_findings WHERE site_key = ? AND state IN (${placeholders})${orderBy}`
          );
          const rows = stmt.all(siteKey, ...states) as Record<
            string,
            unknown
          >[];
          return rows.map((row) => this.rowToPageFinding(row));
        }
        const stmt = db.prepare(
          `SELECT * FROM page_findings WHERE site_key = ?${orderBy}`
        );
        const rows = stmt.all(siteKey) as Record<string, unknown>[];
        return rows.map((row) => this.rowToPageFinding(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Mark a page removed (404/410) and stale all its findings. Both writes
   * happen in one transaction so a partial state can never persist.
   */
  markPageRemoved(
    siteKey: string,
    normalizedUrl: string,
    crawlId: string,
    lastStatus: number
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const now = Date.now();
        const tx = db.transaction(() => {
          db.prepare(
            `INSERT OR REPLACE INTO site_pages
              (site_key, normalized_url, last_status, state, last_seen_crawl_id, last_seen_at)
             VALUES (?, ?, ?, 'removed', ?, ?)`
          ).run(siteKey, normalizedUrl, lastStatus, crawlId, now);
          db.prepare(
            `UPDATE page_findings SET state = 'stale', last_seen_crawl_id = ?, last_seen_at = ?
             WHERE site_key = ? AND normalized_url = ?`
          ).run(crawlId, now, siteKey, normalizedUrl);
        });
        tx();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  upsertSitePages(
    pages: SitePageRecord[]
  ): Effect.Effect<void, StorageError, never> {
    if (pages.length === 0) return Effect.void;
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO site_pages (
            site_key, normalized_url, last_status, state, last_seen_crawl_id, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        const insertAll = db.transaction(() => {
          for (const p of pages) {
            stmt.run(
              p.siteKey,
              p.normalizedUrl,
              p.lastStatus,
              p.state,
              p.lastSeenCrawlId,
              p.lastSeenAt
            );
          }
        });
        insertAll();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  getSitePages(
    siteKey: string
  ): Effect.Effect<SitePageRecord[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // Deterministic order so repeat audits emit pages in a stable order
        // (#150) — normalized_url is the per-page key here.
        const stmt = db.prepare(
          "SELECT * FROM site_pages WHERE site_key = ? ORDER BY normalized_url ASC"
        );
        const rows = stmt.all(siteKey) as Record<string, unknown>[];
        return rows.map((row) => ({
          siteKey: row.site_key as string,
          normalizedUrl: row.normalized_url as string,
          lastStatus: row.last_status as number,
          state: row.state as SitePageRecord["state"],
          lastSeenCrawlId: row.last_seen_crawl_id as string,
          lastSeenAt: row.last_seen_at as number,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Bounded single-site hygiene for churny sites (#197). Prunes ONLY terminal
   * rows for `siteKey`:
   *   - page_findings in state 'resolved' or 'stale'
   *   - site_pages in state 'removed'
   * age-bounded (older than maxAgeMs by last_seen_at), plus an optional
   * per-siteKey cap on terminal findings (keep the NEWEST maxTerminalFindings).
   *
   * The WHERE clauses NEVER match 'open' findings or 'active' pages, so the #110
   * carry-indefinitely invariant holds regardless of age or volume. Runs both
   * deletes in one transaction. Returns total rows deleted.
   */
  compactFindings(
    siteKey: string,
    opts?: CompactFindingsOptions
  ): Effect.Effect<number, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const now = opts?.now ?? Date.now();
        const maxAgeMs = opts?.maxAgeMs ?? COMPACT_DEFAULT_MAX_AGE_MS;
        const maxTerminalFindings =
          opts?.maxTerminalFindings ?? COMPACT_DEFAULT_MAX_TERMINAL_FINDINGS;
        const cutoff = now - maxAgeMs;

        const tx = db.transaction(() => {
          let deleted = 0;

          // 1. Age-prune terminal findings. `state IN ('resolved','stale')`
          //    guarantees 'open' (carried) rows are untouched.
          deleted += db
            .prepare(
              `DELETE FROM page_findings
               WHERE site_key = ?
                 AND state IN ('resolved', 'stale')
                 AND last_seen_at < ?`
            )
            .run(siteKey, cutoff).changes;

          // 2. Age-prune removed site_pages. `state = 'removed'` guarantees
          //    'active' pages are untouched.
          deleted += db
            .prepare(
              `DELETE FROM site_pages
               WHERE site_key = ?
                 AND state = 'removed'
                 AND last_seen_at < ?`
            )
            .run(siteKey, cutoff).changes;

          // 3. Cap terminal findings per site, keeping the NEWEST. Scoped to
          //    terminal states in BOTH the count and the delete so 'open' rows
          //    never count toward the cap nor get pruned. Keyed on the implicit
          //    `rowid` (page_findings is not WITHOUT ROWID) — simpler and faster
          //    than a 4-column tuple NOT IN. rowid is stable within this tx.
          const terminalCount = (
            db
              .prepare(
                `SELECT COUNT(*) AS c FROM page_findings
                 WHERE site_key = ? AND state IN ('resolved', 'stale')`
              )
              .get(siteKey) as { c: number }
          ).c;

          if (terminalCount > maxTerminalFindings) {
            deleted += db
              .prepare(
                `DELETE FROM page_findings
                 WHERE site_key = ?
                   AND state IN ('resolved', 'stale')
                   AND rowid NOT IN (
                     SELECT rowid FROM page_findings
                     WHERE site_key = ? AND state IN ('resolved', 'stale')
                     ORDER BY last_seen_at DESC, rowid DESC
                     LIMIT ?
                   )`
              )
              .run(siteKey, siteKey, maxTerminalFindings).changes;
          }

          return deleted;
        });

        return tx();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  // Project meta — cross-crawl key/value store (sticky user-agent, #875)
  getProjectMeta(
    key: string
  ): Effect.Effect<string | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const row = db
          .prepare("SELECT value FROM project_meta WHERE key = ?")
          .get(key) as { value: string } | undefined;
        return row?.value ?? null;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  setProjectMeta(
    key: string,
    value: string
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        db.prepare(
          `INSERT INTO project_meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(key, value, Date.now());
      },
      catch: (e) => StorageError.write(e),
    });
  }

  private rowToPageFinding(row: Record<string, unknown>): PageFindingRecord {
    return {
      siteKey: row.site_key as string,
      normalizedUrl: row.normalized_url as string,
      ruleId: row.rule_id as string,
      checkName: row.check_name as string,
      locator: (row.locator as string) ?? "",
      status: row.status as string,
      severity: row.severity as string,
      message: row.message as string,
      value: (row.value as string | null) ?? null,
      expected: (row.expected as string | null) ?? null,
      payload: (row.payload as string | null) ?? null,
      fingerprint: row.fingerprint as string,
      firstSeenAt: row.first_seen_at as number,
      lastSeenCrawlId: row.last_seen_crawl_id as string,
      lastSeenAt: row.last_seen_at as number,
      provenance: row.provenance as PageFindingRecord["provenance"],
      state: row.state as PageFindingRecord["state"],
    };
  }

  // ============================================
  // PAGE FEATURES ACCUMULATOR (#1022)
  // ============================================
  //
  // Additive read/write surface over the page_features table. Nothing in the v1
  // pipeline reads these rows yet — the streaming rule loop (PR-E) will. Methods
  // are SQLite-only (not on the CrawlStorage interface), matching the existing
  // getAllLinkAppearancesByHref / getRuleResultsByPage precedent.

  private static readonly PAGE_FEATURES_INSERT_SQL = `
    INSERT OR REPLACE INTO page_features (
      crawl_id, normalized_url, status, depth,
      title, title_hash, description, desc_hash, content_hash,
      word_count, page_type, schema_types, robots_noindex, canonical,
      visible_author, visible_date, transfer_bytes, template_fp, secret_hits,
      meta_noindex, indexable_reasons, rich_result_types
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  private pageFeatureParams(
    crawlId: string,
    row: PageFeatureRow
  ): (string | number | null)[] {
    return [
      crawlId,
      row.normalizedUrl,
      row.status,
      row.depth,
      row.title,
      row.titleHash,
      row.description,
      row.descHash,
      row.contentHash,
      row.wordCount ?? null,
      row.pageType,
      row.schemaTypes.length > 0 ? JSON.stringify(row.schemaTypes) : null,
      row.robotsNoindex ? 1 : 0,
      row.canonical,
      row.visibleAuthor ? 1 : 0,
      row.visibleDate ? 1 : 0,
      row.transferBytes ?? null,
      row.templateFp,
      row.secretHits ?? null,
      row.metaNoindex ? 1 : 0,
      row.indexableReasons.length > 0 ? JSON.stringify(row.indexableReasons) : null,
      row.richResultTypes.length > 0 ? JSON.stringify(row.richResultTypes) : null,
    ];
  }

  /** Upsert a single page-features row (PK conflict on (crawl_id, url) → replace). */
  upsertPageFeatures(
    crawlId: string,
    row: PageFeatureRow
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        db.prepare(SQLiteStorage.PAGE_FEATURES_INSERT_SQL).run(
          ...this.pageFeatureParams(crawlId, row)
        );
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /** Batch upsert page-features rows in one transaction (stream-loop write path). */
  upsertPageFeaturesBatch(
    crawlId: string,
    rows: PageFeatureRow[]
  ): Effect.Effect<void, StorageError, never> {
    if (rows.length === 0) return Effect.void;
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.prepare(SQLiteStorage.PAGE_FEATURES_INSERT_SQL);
        const insertAll = db.transaction(() => {
          for (const row of rows) {
            stmt.run(...this.pageFeatureParams(crawlId, row));
          }
        });
        insertAll();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /** Fetch one page-features row, or null when absent. */
  getPageFeatures(
    crawlId: string,
    normalizedUrl: string
  ): Effect.Effect<PageFeatureRow | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const row = db
          .prepare(
            "SELECT * FROM page_features WHERE crawl_id = ? AND normalized_url = ?"
          )
          .get(crawlId, normalizedUrl) as Record<string, unknown> | undefined;
        return row ? this.rowToPageFeature(row) : null;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /** Count of accumulated page-features rows for the crawl (SiteQuery.pageCount). */
  getPageFeaturesCount(
    crawlId: string
  ): Effect.Effect<number, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const row = db
          .prepare(
            "SELECT COUNT(*) as count FROM page_features WHERE crawl_id = ?"
          )
          .get(crawlId) as { count: number };
        return row.count;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * The homepage row = the shallowest crawled page (depth 0 seed), tie-broken by
   * normalized_url for determinism. Null on an empty crawl. (SiteQuery.homepage)
   */
  getHomepageFeature(
    crawlId: string
  ): Effect.Effect<PageFeatureRow | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const row = db
          .prepare(
            "SELECT * FROM page_features WHERE crawl_id = ? ORDER BY depth ASC, normalized_url ASC LIMIT 1"
          )
          .get(crawlId) as Record<string, unknown> | undefined;
        return row ? this.rowToPageFeature(row) : null;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Keyset-paginated page scan (the cursor primitive PR-E wraps into
   * SiteQuery.pagesMatching). Ordered by normalized_url ASC; pass the last
   * returned `normalizedUrl` as `after` to fetch the next page. Never returns a
   * full resident array — the caller bounds residency by consuming page-by-page.
   */
  getPageFeaturesPage(
    crawlId: string,
    opts?: { after?: string; limit?: number }
  ): Effect.Effect<PageFeatureRow[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const limit = opts?.limit ?? PAGE_FEATURE_DEFAULT_PAGE_SIZE;
        const params: (string | number)[] = [crawlId];
        let query = "SELECT * FROM page_features WHERE crawl_id = ?";
        if (opts?.after !== undefined) {
          query += " AND normalized_url > ?";
          params.push(opts.after);
        }
        query += " ORDER BY normalized_url ASC LIMIT ?";
        params.push(limit);
        const rows = db.prepare(query).all(...params) as Record<
          string,
          unknown
        >[];
        return rows.map((row) => this.rowToPageFeature(row));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /** Normalized URLs of pages classified as `pageType`, ordered deterministically. */
  getPageFeaturesByType(
    crawlId: string,
    pageType: string
  ): Effect.Effect<string[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const rows = db
          .prepare(
            "SELECT normalized_url FROM page_features WHERE crawl_id = ? AND page_type = ? ORDER BY normalized_url ASC"
          )
          .all(crawlId, pageType) as Array<{ normalized_url: string }>;
        return rows.map((r) => r.normalized_url);
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /** Sum of per-page transfer bytes across the crawl (SiteQuery.sumTransferBytes). */
  sumPageFeatureTransferBytes(
    crawlId: string
  ): Effect.Effect<number, StorageError, never> {
    return this.sumPageFeatureColumn(crawlId, "transfer_bytes");
  }

  /** Sum of per-page leaked-secret hit counts (SiteQuery.sumSecretHits). */
  sumPageFeatureSecretHits(
    crawlId: string
  ): Effect.Effect<number, StorageError, never> {
    return this.sumPageFeatureColumn(crawlId, "secret_hits");
  }

  // `column` is only ever a class-internal constant string (never user input),
  // so splicing it into the SUM is injection-safe.
  private sumPageFeatureColumn(
    crawlId: string,
    column: "transfer_bytes" | "secret_hits"
  ): Effect.Effect<number, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(${column}), 0) as total FROM page_features WHERE crawl_id = ?`
          )
          .get(crawlId) as { total: number };
        return row.total;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * URL sets sharing an identical title/description/content hash (count > 1),
   * bounded to `maxGroups` groups and `maxUrlsPerGroup` sampled URLs each.
   * (SiteQuery.duplicateGroups)
   */
  getPageFeatureDuplicateGroups(
    crawlId: string,
    field: PageFeatureDuplicateField,
    opts?: { maxGroups?: number; maxUrlsPerGroup?: number }
  ): Effect.Effect<DuplicateGroup[], StorageError, never> {
    return Effect.try({
      try: () => {
        const cols = DUP_FIELD_COLUMNS[field];
        if (!cols) throw new Error(`unknown duplicate field: ${field}`);
        const groups = this.groupedByColumn(
          crawlId,
          cols.hash,
          cols.value,
          opts?.maxGroups ?? PAGE_FEATURE_DEFAULT_MAX_GROUPS,
          opts?.maxUrlsPerGroup ?? PAGE_FEATURE_DEFAULT_MAX_URLS_PER_GROUP
        );
        return groups.map((g) => ({
          hash: g.key,
          sample: g.sample,
          urls: g.urls,
          count: g.count,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * URL sets sharing one template fingerprint (count > 1), bounded like
   * duplicate groups. (SiteQuery.templateClusters)
   */
  getPageFeatureTemplateClusters(
    crawlId: string,
    opts?: { maxGroups?: number; maxUrlsPerGroup?: number }
  ): Effect.Effect<TemplateCluster[], StorageError, never> {
    return Effect.try({
      try: () => {
        const groups = this.groupedByColumn(
          crawlId,
          "template_fp",
          "NULL",
          opts?.maxGroups ?? PAGE_FEATURE_DEFAULT_MAX_GROUPS,
          opts?.maxUrlsPerGroup ?? PAGE_FEATURE_DEFAULT_MAX_URLS_PER_GROUP
        );
        return groups.map((g) => ({
          fp: g.key,
          urls: g.urls,
          count: g.count,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Shared GROUP BY-hash scan for duplicate/template aggregates. The inner CTE
   * caps the number of groups (LIMIT) and the ROW_NUMBER filter caps URLs per
   * group, so the result set is bounded regardless of crawl size. `hashCol` and
   * `valueExpr` are ONLY ever class-internal constants (DUP_FIELD_COLUMNS /
   * "template_fp" / "NULL") — never user input — so splicing them is
   * injection-safe.
   */
  private groupedByColumn(
    crawlId: string,
    hashCol: string,
    valueExpr: string,
    maxGroups: number,
    maxUrlsPerGroup: number
  ): Array<{ key: string; sample: string | null; urls: string[]; count: number }> {
    const db = this.getDb();
    const stmt = db.prepare(`
      SELECT hash, sample, cnt, normalized_url FROM (
        SELECT g.hash AS hash, g.sample AS sample, g.cnt AS cnt,
               pf.normalized_url AS normalized_url,
               ROW_NUMBER() OVER (
                 PARTITION BY g.hash ORDER BY pf.normalized_url ASC
               ) AS rn
        FROM (
          SELECT ${hashCol} AS hash, COUNT(*) AS cnt, MAX(${valueExpr}) AS sample
          FROM page_features
          WHERE crawl_id = ? AND ${hashCol} IS NOT NULL AND ${hashCol} != ''
          GROUP BY ${hashCol}
          HAVING cnt > 1
          ORDER BY cnt DESC, hash ASC
          LIMIT ?
        ) g
        JOIN page_features pf
          ON pf.crawl_id = ? AND pf.${hashCol} = g.hash
      )
      WHERE rn <= ?
      ORDER BY cnt DESC, hash ASC, rn ASC
    `);
    const rows = stmt.all(
      crawlId,
      maxGroups,
      crawlId,
      maxUrlsPerGroup
    ) as Array<{
      hash: string;
      sample: string | null;
      cnt: number;
      normalized_url: string;
    }>;
    const groups: Array<{
      key: string;
      sample: string | null;
      urls: string[];
      count: number;
    }> = [];
    let current: {
      key: string;
      sample: string | null;
      urls: string[];
      count: number;
    } | null = null;
    for (const row of rows) {
      if (!current || current.key !== row.hash) {
        current = {
          key: row.hash,
          sample: row.sample ?? null,
          urls: [],
          count: row.cnt,
        };
        groups.push(current);
      }
      current.urls.push(row.normalized_url);
    }
    return groups;
  }

  private rowToPageFeature(row: Record<string, unknown>): PageFeatureRow {
    return {
      normalizedUrl: row.normalized_url as string,
      status: row.status as number,
      depth: row.depth as number,
      title: (row.title as string | null) ?? null,
      titleHash: (row.title_hash as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      descHash: (row.desc_hash as string | null) ?? null,
      contentHash: (row.content_hash as string | null) ?? null,
      wordCount: (row.word_count as number | null) ?? null,
      pageType: (row.page_type as string | null) ?? null,
      schemaTypes: row.schema_types
        ? this.safeJsonParse(row.schema_types as string, [] as string[])
        : [],
      robotsNoindex: row.robots_noindex === 1,
      canonical: (row.canonical as string | null) ?? null,
      visibleAuthor: row.visible_author === 1,
      visibleDate: row.visible_date === 1,
      transferBytes: (row.transfer_bytes as number | null) ?? null,
      templateFp: (row.template_fp as string | null) ?? null,
      secretHits: (row.secret_hits as number | null) ?? null,
      metaNoindex: row.meta_noindex === 1,
      indexableReasons: row.indexable_reasons
        ? this.safeJsonParse(row.indexable_reasons as string, [] as string[])
        : [],
      richResultTypes: row.rich_result_types
        ? this.safeJsonParse(row.rich_result_types as string, [] as string[])
        : [],
    };
  }
}
