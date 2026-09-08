/// <reference path="../types/bun-sqlite.d.ts" />

// SQLite storage implementation for the crawler
// Best for medium to large sites (1000+ pages)
// Uses bun:sqlite for native SQLite bindings

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
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
  PageLinkRow,
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

// Schema version - increment when schema changes.
// Exported so migration tests can assert "this DB reached the CURRENT version" rather than pinning a
// literal, which turned every schema bump into two unrelated test failures.
export const SCHEMA_VERSION = 28;

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
  // Version 20: page_features NAP scalars — the per-page Name/Address/Phone the
  // local/nap-consistency rule compares across pages to find contact-detail drift
  // (#1373), so its streaming path reads these instead of re-holding every parsed
  // page. ADDITIVE columns; ALTER is idempotent (the runner swallows "duplicate
  // column name"). Local sqlite only — NOT a prod migration.
  //
  // No backfill, for the v19 reason: `extractPageFeatures` always writes a FULL
  // row via INSERT OR REPLACE keyed by (crawl_id, normalized_url), each crawl
  // writes only its own crawl_id, and the streaming loop re-extracts every scored
  // page in the current run — so no pre-v20 row is ever read. NULL reads back as
  // null / [] / false, which is the same as "this page declared no NAP".
  20: [
    `ALTER TABLE page_features ADD COLUMN nap_name TEXT`,
    `ALTER TABLE page_features ADD COLUMN nap_phones TEXT`,
    `ALTER TABLE page_features ADD COLUMN nap_phone_formats TEXT`,
    `ALTER TABLE page_features ADD COLUMN nap_address TEXT`,
    `ALTER TABLE page_features ADD COLUMN nap_address_format TEXT`,
    `ALTER TABLE page_features ADD COLUMN nap_tel_link INTEGER`,
    `ALTER TABLE page_features ADD COLUMN nap_mailto_link INTEGER`,
  ],
  // Version 21: whether a sitemap declared the Google News namespace (#115).
  // A news sitemap holds ~48h of articles by spec, so its lastmod values always
  // collapse onto 1-2 days; without this flag crawl/sitemap-lastmod-churn accused
  // every publisher that has one of build-stamping lastmod. NULL reads back as
  // false, which is the pre-v21 behaviour for every already-stored sitemap.
  // Local sqlite only (crawler's own store) — NOT a prod migration.
  21: ["ALTER TABLE sitemaps ADD COLUMN is_news_sitemap INTEGER"],
  // Version 22: page_features site-chrome scalars — the per-page favicon,
  // theme-color and default OG image the social/asset-divergence rule compares
  // across the corpus to find pages running a stale layout (#1371), so its
  // streaming path reads these instead of re-holding every parsed page. ADDITIVE
  // columns; ALTER is idempotent (the runner swallows "duplicate column name").
  // Local sqlite only — NOT a prod migration.
  //
  // Authored as 21 before #115 took that number; renumbered to 22 on rebase.
  // The two are independent ALTERs on different tables, so ordering is moot.
  //
  // No backfill, for the v19/v20 reason: `extractPageFeatures` always writes a
  // FULL row via INSERT OR REPLACE keyed by (crawl_id, normalized_url), each
  // crawl writes only its own crawl_id, and the streaming loop re-extracts every
  // scored page in the current run — so no pre-v22 row is ever read. NULL reads
  // back as null, which is the same as "this page declared no such asset".
  22: [
    `ALTER TABLE page_features ADD COLUMN favicon_href TEXT`,
    `ALTER TABLE page_features ADD COLUMN theme_color TEXT`,
    `ALTER TABLE page_features ADD COLUMN og_image TEXT`,
  ],
  // Version 23: why a robots.txt fetch produced nothing. `found = 0` conflated
  // "the origin answered 404" with "we never got an answer" (timeout, 5xx, or a
  // probe the crawl budget cut short), and the weight-8 crawl/robots-txt rule
  // reported the second as a definite "No robots.txt found"
  // (squirrelscan/repo#1733). ADDITIVE; ALTER is idempotent (the runner swallows
  // "duplicate column name"). Local sqlite only — NOT a prod migration.
  23: [`ALTER TABLE robots_txt ADD COLUMN error TEXT`],
  // Version 24: rate-limited link + sitemap-URL targets (squirrelscan/repo#1829).
  // A 429/430 (or a 503 carrying Retry-After) means the target's real status is
  // UNKNOWN, not that it is dead — but the rules only ever see the stored row,
  // and the 503 case cannot be recovered from the status code alone. Persisting
  // the verdict is what stops `links/broken-external-links` and
  // `crawl/sitemap-4xx` reporting a throttled URL as broken. ADDITIVE; ALTER is
  // idempotent (the runner swallows "duplicate column name"). Local sqlite
  // only — NOT a prod migration.
  24: [
    `ALTER TABLE links ADD COLUMN rate_limited INTEGER`,
    `ALTER TABLE sitemap_url_statuses ADD COLUMN rate_limited INTEGER`,
  ],
  // Version 25: when an audit's data was reclaimed (squirrelscan/repo#1912).
  // `self disk --prune` deletes a crawl's derived rows and leaves the `crawls`
  // row, so without this the audit still reads as `completed` and the report
  // path rebuilds a CONFIDENT EMPTY report from whatever pages survive — worse
  // than the disk it saved. Stamped by `retireCrawls`; NULL for every audit that
  // has not been reclaimed, which is all of them until someone prunes. ADDITIVE;
  // ALTER is idempotent (the runner swallows "duplicate column name"). Local
  // sqlite only — NOT a prod migration.
  25: [`ALTER TABLE crawls ADD COLUMN retired_at INTEGER`],
  // Version 26: make the superseded-pages predicate a seek instead of a scan
  // (squirrelscan/repo#1912, criterion 5). `pages` is keyed on
  // (crawl_id, normalized_url), so nothing could serve a lookup by
  // normalized_url ALONE — and both readers that need one are hot:
  //
  //  - `getCachedPage` runs it once per url on every incremental re-audit,
  //  - the retention/prune delete runs it once per candidate page row, with a
  //    correlated subquery, which is quadratic in the size of the table.
  //
  // Measured on a synthetic pages table, retiring one crawl of four (~8 KB of
  // html per row), the delete alone: 4,000 rows 80 ms -> 9.5 ms; 10,000 rows
  // 493 ms -> 29 ms; 40,000 rows 11,779 ms -> 61 ms. Automatic retention runs
  // after every audit, so the 40,000-row figure is the one that matters: 194x,
  // and the difference between bounded and the #1908 shape of defect.
  //
  // `fetched_at` is in the index so the recency comparison is covered too.
  26: [
    `CREATE INDEX IF NOT EXISTS idx_pages_url_recency ON pages(normalized_url, fetched_at)`,
  ],
  // Version 27: what the audit this crawl produced actually SAID
  // (squirrelscan/repo#1912). `crawls.status` is the crawl's lifecycle, and it
  // reads `analyzed` for a run whose report came out `failed` or `blocked` —
  // a site that was down, or answered 403 to everything. Automatic retention
  // needs to tell those apart from real audits, or a week of downtime fills the
  // window and the next successful run deletes every audit from before the
  // outage. Also carries the sentinel `building` between the analyzed
  // transition and the report being reconstructed, which is the window in which
  // another process could otherwise retire a crawl that is still being read.
  // NULL for every crawl written before this. ADDITIVE; local sqlite only.
  27: [`ALTER TABLE crawls ADD COLUMN report_status TEXT`],
  // Version 28: the per-page rule-result cache (squirrelscan/repo#1990) and the
  // exact-bytes HTML hash its key is built on. `pages.content_hash` is
  // whitespace-normalized, so it cannot serve as that key — see
  // `PageRecord.htmlHash`. ADDITIVE; both statements are idempotent, and
  // `html_hash` is also in PAGES_ALTER_COLUMNS so a version-collision cannot
  // leave it missing.
  28: [
    `ALTER TABLE pages ADD COLUMN html_hash TEXT`,
    `CREATE TABLE IF NOT EXISTS page_rule_cache (
      crawl_id TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (crawl_id, normalized_url),
      FOREIGN KEY (crawl_id) REFERENCES crawls(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_page_rule_cache_key
      ON page_rule_cache(cache_key, created_at DESC)`,
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
  { name: "html_hash", type: "TEXT" },
];

// Same guard for `sitemaps`. Migration 21 added is_news_sitemap; a DB stamped
// past 21 by a build that numbered its own migration 21 skips it forever, and
// then the first sitemap write throws "no column named is_news_sitemap" and the
// whole audit fails at the crawl's first step. Seen on DBs recorded at 22 with
// the column absent. Any new ALTER-added `sitemaps` column MUST be listed here.
const SITEMAPS_ALTER_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "is_news_sitemap", type: "INTEGER" },
];

// Same guard for `robots_txt`. Migration 23 added `error`; a DB stamped past 23
// by a build that numbered its own migration 23 skips it forever, and then
// setRobotsTxt throws "no column named error" on the crawl's first write. This
// has now bitten `pages` and `sitemaps` in turn, so the column goes on the list
// at the same time it goes in the migration. Any new ALTER-added `robots_txt`
// column MUST be listed here.
const ROBOTS_TXT_ALTER_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "error", type: "TEXT" },
];

// Same guard for `links` and `sitemap_url_statuses`. Migration 24 added
// `rate_limited` to both; a DB stamped past 24 by a build that numbered its own
// migration 24 would skip it forever and then every upsertLink INSERT throws
// "no column named rate_limited" — which fails the whole external-link phase,
// not just the new field. The guard goes on the list at the same time as the
// migration, per the three tables this has already bitten.
const LINKS_ALTER_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "waf_blocked", type: "INTEGER" },
  { name: "waf_provider", type: "TEXT" },
  { name: "rate_limited", type: "INTEGER" },
];

const SITEMAP_URL_STATUSES_ALTER_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "rate_limited", type: "INTEGER" },
];

// Same guard for `crawls`. Migration 25 added `retired_at`; a DB stamped past 25
// by a build that numbered its own migration 25 would skip it forever. The
// failure is quieter than the four tables before it and worse for that: reads
// are `SELECT *` mapped by key, so a missing column does not throw, it yields
// `undefined` — every retired audit silently reads as NOT retired and renders
// the empty report this column exists to prevent. The prune's own UPDATE is the
// only part that fails loudly. So the column goes on the list at the same time
// it goes in the migration, like the five before it.
const CRAWLS_ALTER_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "retired_at", type: "INTEGER" },
  // Same reasoning one row down: a missing `report_status` reads as `undefined`
  // rather than throwing, and undefined is treated as "an ordinary audit" — so
  // a database that skipped migration 27 would quietly put failed runs back in
  // the retention window instead of failing loudly.
  { name: "report_status", type: "TEXT" },
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
  stats TEXT NOT NULL,
  -- When "self disk --prune" reclaimed this audit's data (#1912). NULL until
  -- something retires it, which is every audit unless the user asks. No
  -- backticks in here: SCHEMA is a template literal and they would close it.
  retired_at INTEGER,
  -- What the audit this crawl produced said (#1912): completed, partial,
  -- failed, blocked, or the sentinel "building" while its report is still being
  -- reconstructed. Distinct from status, which is the crawl lifecycle and says
  -- analyzed for all of them. NULL for crawls written before migration 27.
  report_status TEXT
);
-- NO index on retired_at here. SCHEMA is exec'd BEFORE runMigrations(), and on a
-- database written before migration 25 the crawls table exists WITHOUT the
-- column, so a CREATE INDEX naming it fails at open, before the migration that
-- would have added it can run, on every open, forever. It is created after the
-- column reconcile instead; see indexesAfterMigrations(). Still no backticks.

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
  html_hash TEXT,
  PRIMARY KEY (crawl_id, normalized_url),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

CREATE INDEX IF NOT EXISTS idx_pages_crawl ON pages(crawl_id);
CREATE INDEX IF NOT EXISTS idx_pages_final_url ON pages(final_url);
-- Lookups by normalized_url alone: getCachedPage's conditional-GET read, and
-- the correlated "is there a newer row for this url" the retention delete runs
-- per candidate page. The primary key leads with crawl_id, so neither could use
-- it. See migration 26 for the numbers.
CREATE INDEX IF NOT EXISTS idx_pages_url_recency ON pages(normalized_url, fetched_at);

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
  rate_limited INTEGER,
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
  -- Why the fetch produced nothing, when it did. Distinguishes a confirmed 404
  -- from a probe that never got an answer; see migration 23.
  error TEXT,
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
  is_news_sitemap INTEGER,
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
  rate_limited INTEGER,
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
  nap_name TEXT,
  nap_phones TEXT,
  nap_phone_formats TEXT,
  nap_address TEXT,
  nap_address_format TEXT,
  nap_tel_link INTEGER,
  nap_mailto_link INTEGER,
  favicon_href TEXT,
  theme_color TEXT,
  og_image TEXT,
  PRIMARY KEY (crawl_id, normalized_url),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- Per-page rule-result cache (#1990): what the streamed page-rule loop produced
-- for one page, so a later audit whose inputs are unchanged can replay it instead
-- of re-parsing the page and re-running its rules. One row per page per crawl,
-- retired with the crawl by retireCrawls: the newest audit always holds a
-- complete copy, so pruning older audits never makes the next one cold.
CREATE TABLE IF NOT EXISTS page_rule_cache (
  crawl_id TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  -- The full input tuple, hashed: exact HTML bytes, every page field the rules
  -- read, and the run context (rules version, rule selection + options, the
  -- three SiteData fields page rules touch). Sufficient on its own to identify
  -- an entry, because the page's own url is one of the hashed inputs.
  cache_key TEXT NOT NULL,
  -- gzipped JSON of the encoded entry. Gzip because the uncompressed per-page
  -- checks are ~30 KB and this table would otherwise add a quarter to project.db.
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (crawl_id, normalized_url),
  FOREIGN KEY (crawl_id) REFERENCES crawls(id)
);

-- The lookup: newest entry for a key, across crawls. created_at DESC is in the
-- index so a hit is a single index seek and never a scan of a url's history
-- (#1908 — nothing here may grow a per-audit full scan).
CREATE INDEX IF NOT EXISTS idx_page_rule_cache_key
  ON page_rule_cache(cache_key, created_at DESC);

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

// gzip a payload into a buffer bun:sqlite will bind as a BLOB. Wrapped so the
// `Uint8Array<ArrayBufferLike>` bun's gzipSync returns is narrowed once, here,
// rather than at every call site.
//
// LEVEL 1, not the default 6. This runs once per page on every COLD audit, which
// is the run that gets nothing back from the cache, so its cost is the one paid
// by a first-time user. Level 1 is several times faster and the rows are retired
// with their crawl, so the extra bytes live no longer than the audit does — the
// wrong end of the trade to optimise.
function gzipped(payload: string): Uint8Array<ArrayBuffer> {
  const out = Bun.gzipSync(Buffer.from(payload), { level: 1 });
  return new Uint8Array(out.buffer as ArrayBuffer, out.byteOffset, out.byteLength);
}

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

    // Self-heal: re-add any ALTER-added column a version-number collision
    // skipped. Runs unconditionally (PRAGMA table_info is the source of truth,
    // not the schema_version counter), so a DB stuck at the current version
    // with a missing column recovers instead of throwing on every write. See
    // PAGES_ALTER_COLUMNS, SITEMAPS_ALTER_COLUMNS and ROBOTS_TXT_ALTER_COLUMNS.
    this.reconcilePagesColumns();
    this.reconcileColumns("sitemaps", SITEMAPS_ALTER_COLUMNS);
    this.reconcileColumns("robots_txt", ROBOTS_TXT_ALTER_COLUMNS);
    this.reconcileColumns("links", LINKS_ALTER_COLUMNS);
    this.reconcileColumns("sitemap_url_statuses", SITEMAP_URL_STATUSES_ALTER_COLUMNS);
    this.reconcileColumns("crawls", CRAWLS_ALTER_COLUMNS);
    this.indexesAfterMigrations();
  }

  /**
   * Indexes over columns an ALTER migration added, created once the column is
   * certainly there.
   *
   * These cannot live in SCHEMA: it is exec'd before `runMigrations()`, so on a
   * database written before the column existed the CREATE INDEX throws at open
   * and the migration that would have fixed it never runs. And they cannot live
   * in MIGRATIONS alone either, because a FRESH database is stamped at the
   * current version and runs no migrations at all. After the reconcile is the
   * one point where both are true.
   */
  private indexesAfterMigrations(): void {
    const db = this.getDb();
    // One entry per RETIRED audit rather than one per audit: retention asks
    // "has anything here been retired" on every pass that deletes (#1912).
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_crawls_retired ON crawls(retired_at) WHERE retired_at IS NOT NULL`
    );
    // The complement, for the candidate query retention runs on every audit.
    // Partial on the same column from the other side, so it holds one entry per
    // audit still in play rather than one per audit ever run, and its order is
    // the order that query asks for: no temp b-tree, and the walk is bounded by
    // the window instead of by the history.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_crawls_retention ON crawls(started_at) WHERE retired_at IS NULL`
    );
  }

  /**
   * Add any expected `pages` column that is missing, regardless of the recorded
   * schema version. Guards against migration renumbering collisions that leave
   * a DB recorded as current but missing a column the INSERT references — which
   * otherwise fails every page write and stores 0 pages. Idempotent and cheap
   * (one PRAGMA read + at most one ALTER per missing column).
   */
  private reconcilePagesColumns(): void {
    this.reconcileColumns("pages", PAGES_ALTER_COLUMNS);
  }

  private reconcileColumns(
    table:
      | "pages"
      | "sitemaps"
      | "robots_txt"
      | "links"
      | "sitemap_url_statuses"
      | "crawls",
    columns: ReadonlyArray<{ name: string; type: string }>
  ): void {
    const db = this.getDb();
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    // No table yet (shouldn't happen — SCHEMA creates it first) → nothing to
    // reconcile; a fresh CREATE TABLE already has every column.
    if (existing.size === 0) return;

    for (const col of columns) {
      if (existing.has(col.name)) continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
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
        const stmt = db.query("SELECT * FROM crawls WHERE id = ?");
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
          // Cached, and safe to cache even though the SQL is built here. The
          // cache is keyed by TEXT and `sets` is drawn from eight fixed
          // optional columns in a fixed order, so there are at most 255 distinct
          // texts however a caller mixes them.
          //
          // The hazard is not an unbounded cache. On Bun 1.3.14 the cache holds
          // the first 20 texts PER DATABASE and NEVER EVICTS, so a statement
          // that gets in stays in and one that arrives late never gets in at
          // all: it recompiles on every call, forever and silently. Measured on
          // a fresh database — 25 distinct texts, then three passes over the
          // same 25, gave 15 compilations rather than 0, which is the five that
          // never made it, three times each.
          //
          // So many shapes here would not evict anything already cached; they
          // would fill the remaining slots and starve whatever is converted
          // next. `Database.MAX_QUERY_CACHE_SIZE` raises the limit (30 caches
          // all 25), but the default is what ships. The crawl loop writes only
          // `stats`, once per page (#1911).
          const stmt = db.query(
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
      retiredAt: (row.retired_at as number | null) ?? undefined,
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
        // The EXACT-bytes hash of the HTML (#1990), distinct from
        // `content_hash`, which is whitespace-NORMALIZED so the incremental
        // crawler can call a reformatted page unchanged. Written only on the
        // content-store path, where it costs nothing: the store is
        // content-addressed by `sha256(bytes)`, so `put` has already computed
        // it. Without a store (the cloud, which inlines HTML in the DB and has
        // no project.db to cache into) it stays NULL rather than paying a second
        // hash over every page on the path #1862 made memory-critical — a NULL
        // means "this page does not participate in the rule-result cache", which
        // is the safe answer, never a wrong one.
        let exactHtmlHash: string | null = null;
        if (page.html && this.contentStore) {
          const htmlHash = this.contentStore.put(page.html, "text/html");
          contentHashToStore = htmlHash;
          exactHtmlHash = htmlHash;
          htmlToStore = null; // HTML is in content-store, not local DB
        }

        // Cached: once per crawled page (#1911). See the census in
        // scripts/statement-compile-census.ts for why this one and not the
        // other ninety.
        const stmt = db.query(`
          INSERT OR REPLACE INTO pages (
            crawl_id, url, normalized_url, final_url, depth, parent_url,
            redirect_chain, status, content_type, size_bytes, load_time_ms, ttfb, download_time, fetched_at,
            etag, last_modified, content_hash, html, parsed_data, headers, security_headers, request_headers,
            fetcher_id, fallback_reason, source_hash, html_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          page.sourceHash ?? null,
          exactHtmlHash
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

  /**
   * Just `normalized_url` + `parsed_data`, for the audit's incoming-link scan
   * (#1860).
   *
   * `getPages` is `SELECT *`: on a script-heavy site it materializes ~1 MB of
   * HTML per page (and re-reads it from the content store when the column is
   * empty) so the scan can look at two small fields. That HTML is never touched
   * and is dropped at the end of the batch, but the allocator keeps the pages it
   * grew for it: measured over 150 real 959 KB pages at batch 50, three runs,
   * the two link-graph scans grew RSS a median 431 MB through `getPages` and
   * 88 MB through this, while the JS heap grew ~0.3 MB either way.
   *
   * Same ordering and pagination as `getPages`, so a caller swapping one for the
   * other sees the same rows in the same order.
   */
  getPageLinkRows(
    crawlId: string,
    options?: PaginationOptions
  ): Effect.Effect<PageLinkRow[], StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        let query =
          "SELECT normalized_url, parsed_data FROM pages WHERE crawl_id = ? ORDER BY normalized_url ASC";
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
        // Cast, not `?? null`: `rowToPageRecord` reads the same column the same
        // way, and a normalization here would be a divergence from `getPages`
        // that a parity test could not see.
        return rows.map((row) => ({
          normalizedUrl: row.normalized_url as string,
          parsedData: row.parsed_data as string | null,
        }));
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
        const stmt = db.query(
          "SELECT 1 FROM pages WHERE crawl_id = ? AND normalized_url = ? LIMIT 1"
        );
        // bun:sqlite returns NULL (not undefined) for no row, so a
        // `!== undefined` test here is always true. See hasFrontierEntry.
        return stmt.get(crawlId, normalizedUrl) != null;
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
        // Cached: once per URL on the incremental path, which the CLI takes by
        // default (#1911). Same SQL text, so the plan and the tie-break above
        // are unchanged; only the compilation is reused.
        const stmt = db.query(`
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
      htmlHash: (row.html_hash as string | null) ?? null,
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
        // Cached: once per newly discovered URL (#1911).
        const stmt = db.query(`
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

  /**
   * Existence-only frontier lookup for the enqueue path.
   *
   * `enqueueUrl` runs this once per discovered link -- the highest-frequency
   * read in a crawl, roughly 50x per page on a link-dense site -- and only
   * needs to know whether the URL is already known. `getFrontierEntry` stays
   * for the watchdog path, which reads `status` off the record.
   */
  hasFrontierEntry(
    crawlId: string,
    normalizedUrl: string
  ): Effect.Effect<boolean, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.query(
          "SELECT 1 FROM frontier WHERE crawl_id = ? AND normalized_url = ? LIMIT 1"
        );
        // `!= null`, NOT `!== undefined`: bun:sqlite's Statement.get() returns
        // NULL when no row matches, so an undefined test never fails and the
        // helper answers "yes" for every URL.
        return stmt.get(crawlId, normalizedUrl) != null;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  getFrontierEntry(
    crawlId: string,
    normalizedUrl: string
  ): Effect.Effect<FrontierRecord | null, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const stmt = db.query(
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
        const updateStmt = db.query(`
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
        const selectStmt = db.query(`
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
        const updateStmt = db.query(`
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
        const stmt = db.query(
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
        const stmt = db.query(
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
          const stmt = db.query(`
            UPDATE frontier
            SET status = ?, reason = ?, fetched_at = COALESCE(?, fetched_at)
            WHERE crawl_id = ? AND normalized_url = ?
          `);
          stmt.run(status, reason, fetchedAt, crawlId, normalizedUrl);
        } else {
          const stmt = db.query(`
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
          INSERT OR REPLACE INTO links (crawl_id, href, is_internal, status, error, checked_at, waf_blocked, waf_provider, rate_limited)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          link.href,
          link.isInternal ? 1 : 0,
          link.status ?? null,
          link.error ?? null,
          link.checkedAt ?? null,
          link.wafBlocked ? 1 : null,
          link.wafProvider ?? null,
          link.rateLimited ? 1 : null
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
        // Cached: once per newly discovered URL, on the enqueue path that has no
        // link-count cache to read from (#1911).
        const stmt = db.query(
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
        // Cached: once per REUSED page on a warm incremental crawl (#1911).
        const stmt = db.query(`
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
      rateLimited: (row.rate_limited as number | null) === 1 ? true : undefined,
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
        // Cached: once per REUSED page on a warm incremental crawl (#1911).
        const stmt = db.query(`
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
          INSERT OR REPLACE INTO robots_txt (crawl_id, url, found, content, size_bytes, sitemaps, fetched_at, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          robots.url,
          robots.exists ? 1 : 0,
          robots.content,
          robots.sizeBytes,
          JSON.stringify(robots.sitemaps),
          robots.fetchedAt,
          robots.error ?? null
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
          error: (row.error as string | null) ?? null,
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
          INSERT OR REPLACE INTO sitemaps (crawl_id, url, type, url_count, child_sitemaps, errors, fetched_at, is_news_sitemap)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          crawlId,
          sitemap.url,
          sitemap.type,
          sitemap.urlCount,
          JSON.stringify(sitemap.childSitemaps),
          JSON.stringify(sitemap.errors),
          sitemap.fetchedAt,
          sitemap.isNewsSitemap ? 1 : 0
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
          // NULL on any sitemap stored before v21 — reads back false, the old behaviour.
          isNewsSitemap: Boolean(row.is_news_sitemap),
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
            crawl_id, url, status, error, rate_limited
          ) VALUES (?, ?, ?, ?, ?)
        `);
        const transaction = db.transaction(() => {
          for (const status of statuses) {
            stmt.run(
              crawlId,
              status.url,
              status.status,
              status.error,
              status.rateLimited ? 1 : null
            );
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
          rateLimited:
            (row.rate_limited as number | null) === 1 ? true : undefined,
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
  /**
   * Newest cached page-rule payload for each of `cacheKeys` (#1990).
   *
   * The key already encodes the page's url and every input its rules read, so a
   * hit is exact and a miss is silent. Read across crawls: a warm audit looks up
   * what the PREVIOUS audit stored. Chunked because SQLite caps bound parameters
   * (default 32k) and a page batch could otherwise exceed it on a large crawl.
   *
   * Returns the payload as the JSON text that was stored; decoding it is the
   * engine's business, not storage's.
   */
  loadPageRuleCache(
    cacheKeys: readonly string[]
  ): Effect.Effect<Map<string, string>, StorageError, never> {
    return Effect.try({
      try: () => {
        const out = new Map<string, string>();
        if (cacheKeys.length === 0) return out;
        const db = this.getDb();
        const CHUNK = 400;
        for (let i = 0; i < cacheKeys.length; i += CHUNK) {
          const chunk = cacheKeys.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => "?").join(",");
          // ONE row per key, chosen in SQL. Every retained audit holds a row for
          // an unchanged page, so selecting them all and letting the last write
          // win would decompress (pages x retained audits) payloads per audit —
          // work that grows with history rather than with the crawl, which is
          // exactly what a per-page cache must not do (#1908).
          //
          // `max(created_at)` with bare columns is SQLite's documented
          // min/max-aggregate case: the other columns come from the row holding
          // the maximum. Rows tie when two audits land in the same millisecond and
          // SQLite may then return either — harmless HERE and only here, because
          // the key covers every input that determines the payload, so two rows
          // sharing a key hold the same bytes.
          const rows = db
            .query(
              `SELECT cache_key, payload, max(created_at) AS newest
               FROM page_rule_cache
               WHERE cache_key IN (${placeholders})
               GROUP BY cache_key`
            )
            .all(...chunk) as Array<{ cache_key: string; payload: Uint8Array<ArrayBuffer> }>;
          for (const row of rows) {
            out.set(row.cache_key, Buffer.from(Bun.gunzipSync(row.payload)).toString("utf8"));
          }
        }
        return out;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Write this crawl's page-rule cache entries (#1990), gzipped, in one
   * transaction.
   *
   * Called with EVERY page the audit scored, replayed pages included — that
   * carry-forward is what lets `retireCrawls` delete an older crawl's rows
   * without making the next audit cold.
   */
  savePageRuleCacheBatch(
    crawlId: string,
    entries: ReadonlyArray<{ normalizedUrl: string; cacheKey: string; payload: string }>
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        if (entries.length === 0) return;
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO page_rule_cache (
            crawl_id, normalized_url, cache_key, payload, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        const now = Date.now();
        const transaction = db.transaction(() => {
          for (const entry of entries) {
            stmt.run(
              crawlId,
              entry.normalizedUrl,
              entry.cacheKey,
              gzipped(entry.payload),
              now
            );
          }
        });
        transaction();
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /**
   * Copy existing cache entries into this crawl, by key (#1990).
   *
   * A replayed page's stored bytes are already exactly right, so this is a pure
   * SQL row copy: no decode, no re-encode, no re-compress. Doing it the other way
   * would put a full serialize + gzip of every page back on the warm run, which is
   * the run the whole feature exists to make cheap.
   *
   * Silently skips a key with no row — the only way that happens is the entry
   * being retired between the read and the write, and a missing carry-forward
   * costs the NEXT audit a page's rules, never this one's correctness.
   */
  carryForwardPageRuleCache(
    crawlId: string,
    entries: ReadonlyArray<{ normalizedUrl: string; cacheKey: string }>
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        if (entries.length === 0) return;
        const db = this.getDb();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO page_rule_cache (
            crawl_id, normalized_url, cache_key, payload, created_at
          )
          SELECT ?, ?, cache_key, payload, ?
          FROM page_rule_cache WHERE cache_key = ?
          ORDER BY created_at DESC LIMIT 1
        `);
        const now = Date.now();
        const transaction = db.transaction(() => {
          for (const entry of entries) {
            stmt.run(crawlId, entry.normalizedUrl, now, entry.cacheKey);
          }
        });
        transaction();
      },
      catch: (e) => StorageError.write(e),
    });
  }

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
          const check = this.rowToCheckResult(row);
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
          const check = this.rowToCheckResult(row);
          const existing = result.get(ruleId) ?? [];
          existing.push(check);
          result.set(ruleId, existing);
        }
        return result;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Both groupings of a crawl's rule results, from ONE materialization (#1920).
   *
   * `getRuleResultsByPage` and `getRuleResultsByRuleId` differ only in their
   * `ORDER BY`; every other line, including the CheckResult built per row, is
   * the same. The report path calls both, so a crawl's checks were read twice
   * and materialized twice: at 1,000 pages that is 203,687 rows, 204 per page,
   * and about 500 bytes of object per 55 bytes of data. Measured in isolation,
   * the two reads grow RSS by 441 MB against 249 MB for this one.
   *
   * ORDER COMES FROM SQLITE, not from a rule about ties. An earlier version of
   * this read once `ORDER BY id` and grouped, having measured that both original
   * queries returned their ties in `id` order. That was incidental to today's
   * indexes: with an index on `(crawl_id, rule_id, page_url)` the per-rule query
   * returns its ties in page_url order instead, and the emitted issue order
   * changes with it. SQLite leaves tied `ORDER BY` rows unordered by contract.
   *
   * So the heavy work happens once and the ORDER is asked for twice, with the
   * same `ORDER BY` each original used, reading only `id` and the grouping key.
   * Those two extra queries carry integers and one short string per row instead
   * of a parsed CheckResult, and the result is byte-identical to the readers
   * this replaces under any index or query plan.
   */
  getRuleResultsGrouped(crawlId: string): Effect.Effect<
    {
      byPage: Map<string, CheckResult[]>;
      byRuleId: Map<string, CheckResult[]>;
    },
    StorageError,
    never
  > {
    return Effect.try({
      try: () => {
        const db = this.getDb();

        // The one materialization. Keyed by row id so the ordering passes below
        // can address a check without rebuilding it.
        const byId = new Map<number, CheckResult>();
        for (const row of db
          .prepare("SELECT * FROM rule_results WHERE crawl_id = ?")
          .all(crawlId) as Record<string, unknown>[]) {
          byId.set(row.id as number, this.rowToCheckResult(row));
        }

        // `ORDER BY <column>` verbatim from the reader being replaced, so the
        // sequence is whatever SQLite would have produced there.
        const groupBy = (
          column: "page_url" | "rule_id"
        ): Map<string, CheckResult[]> => {
          const ordered = db
            .prepare(
              `SELECT id, ${column} AS k FROM rule_results WHERE crawl_id = ? ORDER BY ${column}`
            )
            .all(crawlId) as Array<{ id: number; k: string }>;
          const out = new Map<string, CheckResult[]>();
          for (const { id, k } of ordered) {
            const check = byId.get(id);
            // Unreachable: both statements read the same rows in one connection.
            // Skipping rather than asserting keeps a torn read from throwing in
            // the report path, where the alternative is no report at all.
            if (!check) continue;
            const list = out.get(k);
            if (list) list.push(check);
            else out.set(k, [check]);
          }
          return out;
        };

        return { byPage: groupBy("page_url"), byRuleId: groupBy("rule_id") };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /** One `rule_results` row as a CheckResult. The single definition the three
   * readers share, so a column added to one cannot be forgotten in the others. */
  private rowToCheckResult(row: Record<string, unknown>): CheckResult {
    const pageUrl = row.page_url as string;
    return {
      name: row.check_name as string,
      status: row.status as CheckResult["status"],
      message: row.message as string,
      value: row.value !== null ? (row.value as string | number) : undefined,
      expected:
        row.expected !== null ? (row.expected as string | number) : undefined,
      pageUrl: pageUrl || undefined,
      items: row.items ? JSON.parse(row.items as string) : undefined,
      details: row.details ? JSON.parse(row.details as string) : undefined,
      pages: row.pages ? JSON.parse(row.pages as string) : undefined,
      skipReason: row.skip_reason ? (row.skip_reason as string) : undefined,
    };
  }

  /**
   * Tables holding a crawl's DERIVED output — everything that can be recomputed
   * by auditing again, and nothing another crawl reads (#1912).
   *
   * Deliberately excluded, and why:
   *  - `pages`, handled separately below: the newest row per url is the
   *    conditional-GET cache the next crawl reads.
   *  - `resource_sizes`: `getCachedResources` takes the most recent per
   *    (type, url) across OTHER crawls, so a retired crawl's rows may still be
   *    the freshest sub-resource record anyone has (#107). Small, and load-bearing.
   *  - `published_reports`: the record that this crawl was published. Not
   *    recomputable, and tiny.
   *  - `links`, `images` and their `_appearances`: read ACROSS crawls.
   *    `getLinksByPage` and `getImagesByPage` take the most recent crawl that
   *    has them, with no crawl_id filter, and `reuseCachedPage` copies the
   *    result into the next crawl when it serves a page from cache. Retiring
   *    them would leave a reused page with no links or images in the NEXT
   *    audit's report, which is a quiet wrong answer rather than a missing one.
   *  - `crawls` itself: the row stays so `report --list` can still show the
   *    audit and say it is no longer renderable, rather than the history
   *    silently shrinking.
   */
  private static readonly RETIREABLE_TABLES = [
    "rule_results",
    // Safe to retire even though the NEXT audit reads it (#1990), unlike `links`
    // and `images` below: every audit writes a row for every page it scored,
    // replayed pages included, so the newest crawl always holds a complete cache
    // and retiring an older one costs nothing. Recomputable by definition.
    "page_rule_cache",
    "sitemap_urls",
    "sitemaps",
    "sitemap_url_statuses",
    "page_features",
    "robots_txt",
    "llms_txt",
    "markdown_response",
    "agent_well_known",
    "agent_access",
    "agent_rsl",
    "frontier",
  ] as const;

  /**
   * The audits automatic retention is allowed to count and to retire (#1912),
   * newest first. Everything excluded here is excluded from BOTH: it neither
   * holds a slot in the window nor is deleted.
   *
   *  - Already retired: not one of the "last 3 you can open", and re-retiring
   *    one would delete nothing at a cost. Dropping them also keeps the result
   *    bounded by the window rather than by the number of audits the project
   *    has ever run, which nothing ever removes.
   *  - Running or paused: retiring one deletes the frontier out from under a
   *    live crawl.
   *  - `report_status` of `failed` or `blocked`: the run finished but learned
   *    nothing about the site. Counting those would mean a week of downtime
   *    fills the window and the first successful audit afterwards deletes every
   *    audit from before the outage.
   *  - `report_status` of `building`: this crawl is `analyzed` but its own
   *    process is still reconstructing its report. Retiring it there is the one
   *    way an audit that was going to succeed can be made to fail.
   *
   * NULL `report_status` is an ordinary audit: it predates migration 27.
   *
   * Only finished, renderable audits are here. A running crawl is excluded
   * because retiring it would delete the frontier out from under a live audit,
   * and a FAILED one because it is not a renderable audit: counting it toward
   * "keep the last 3" would spend a slot of the window on a report nobody can
   * open, and retiring it would delete rows from a crawl the user never got an
   * answer from. `self disk --prune` still reaches them; this pass does not.
   *
   * The order is `started_at DESC, rowid DESC` rather than `listCrawls`'
   * `started_at DESC` alone, because which audits fall outside the window has to
   * be decided the same way every time. Two crawls stamped in the same
   * millisecond tie, and SQLite's pick between tied rows is whatever the plan
   * happens to produce — an index added later can flip it. `rowid` is insert
   * order on this table, so DESC breaks the tie toward the newer row.
   *
   * Reads three small columns from `crawls`, which holds one row per audit, so
   * this is bounded by the project's audit count rather than by its size.
   */
  listRetentionCandidates(): Effect.Effect<
    Array<{ id: string; startedAt: number }>,
    StorageError,
    never
  > {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const rows = db
          .prepare(
            `SELECT id, started_at FROM crawls
             WHERE retired_at IS NULL
               AND status IN ('completed', 'analyzed')
               AND (report_status IS NULL
                    OR report_status IN ('completed', 'partial'))
             ORDER BY started_at DESC, rowid DESC`
          )
          .all() as Array<{ id: string; started_at: number }>;
        return rows.map((row) => ({
          id: row.id,
          startedAt: row.started_at,
        }));
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Record what the audit this crawl produced said (#1912).
   *
   * `building` is stamped when the crawl reaches `analyzed`, before its report
   * is reconstructed, and replaced with the report's own status once there is
   * one. Automatic retention reads both: it does not count a `failed` or
   * `blocked` run as one of the audits you are keeping, and it will not retire
   * a crawl still marked `building`, which is the only signal that another
   * process is in the middle of reading it.
   */
  setReportStatus(
    crawlId: string,
    reportStatus: string
  ): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        this.getDb()
          .prepare("UPDATE crawls SET report_status = ? WHERE id = ?")
          .run(reportStatus, crawlId);
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /**
   * Whether anything in this project has ever been retired.
   *
   * One indexed-free but bounded existence check, asked only when a retention
   * pass is about to delete something, so the notice can say "keep more with
   * [storage] keep_audits" the first time and stop repeating it after.
   */
  hasRetiredCrawls(): Effect.Effect<boolean, StorageError, never> {
    return Effect.try({
      try: () => {
        const row = this.getDb()
          .prepare(
            "SELECT 1 AS present FROM crawls WHERE retired_at IS NOT NULL LIMIT 1"
          )
          .get() as { present: number } | null;
        return row != null;
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Page accounting for the file behind this connection.
   *
   * `freelistPages * pageSize` is what deleting has already freed INSIDE the
   * file: reused by the next audit's inserts, but not returned to the
   * filesystem until something rewrites the file. That is the number a caller
   * needs to decide whether a rewrite is worth it — see {@link vacuum} for why
   * it must not be routine.
   */
  databasePageStats(): Effect.Effect<
    { pageSize: number; pageCount: number; freelistPages: number },
    StorageError,
    never
  > {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        const read = (pragma: string): number => {
          const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<
            string,
            unknown
          > | null;
          const value = row ? Object.values(row)[0] : 0;
          return typeof value === "number" ? value : 0;
        };
        return {
          pageSize: read("page_size"),
          pageCount: read("page_count"),
          freelistPages: read("freelist_count"),
        };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Fold the write-ahead log back into the database file and truncate it.
   *
   * A bulk delete in WAL mode writes the freed pages to the `-wal` file, so
   * without this a retention pass leaves the project MEASURABLY larger on disk
   * than it started, having deleted rows. Cheap: the work is proportional to
   * the log, which is being written either way. A checkpoint that cannot get
   * its lock returns busy rather than failing, which is the right answer here —
   * the next one will do it.
   */
  checkpointWal(): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        this.getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /**
   * What {@link retireCrawls} would delete, without deleting it.
   *
   * Counted rather than estimated: this is what a user sees before confirming
   * that some of their audit history stops being renderable, so it must be the
   * real number.
   */
  previewRetireCrawls(crawlIds: string[]): Effect.Effect<
    { rowsByTable: Record<string, number>; supersededPages: number; totalRows: number },
    StorageError,
    never
  > {
    return Effect.try({
      try: () => {
        const rowsByTable: Record<string, number> = {};
        let totalRows = 0;
        if (crawlIds.length === 0)
          return { rowsByTable, supersededPages: 0, totalRows: 0 };

        const db = this.getDb();
        const placeholders = crawlIds.map(() => "?").join(", ");
        for (const table of SQLiteStorage.RETIREABLE_TABLES) {
          const row = db
            .prepare(
              `SELECT COUNT(*) AS c FROM ${table} WHERE crawl_id IN (${placeholders})`
            )
            .get(...crawlIds) as { c: number };
          if (row.c > 0) {
            rowsByTable[table] = row.c;
            totalRows += row.c;
          }
        }

        const superseded = db
          .prepare(this.supersededPagesSql("COUNT(*) AS c", placeholders))
          .get(...crawlIds) as { c: number };
        totalRows += superseded.c;
        return { rowsByTable, supersededPages: superseded.c, totalRows };
      },
      catch: (e) => StorageError.read(e),
    });
  }

  /**
   * Pages belonging to the named crawls that a newer row already supersedes.
   *
   * `getCachedPage` reads `ORDER BY fetched_at DESC, rowid DESC LIMIT 1`, so a
   * row with a newer sibling for the same url can never be returned by it. The
   * predicate is that ordering, inverted — which is why these rows are dead to
   * the crawler even though the crawl they belong to is being retired for a
   * different reason. A page whose ONLY row belongs to a retired crawl is kept:
   * it is still the freshest thing known about that url.
   *
   * The recency test is written as a ROW VALUE comparison rather than the
   * `a > b OR (a = b AND c > d)` it expands to, because the two forms are
   * equivalent to SQLite's optimiser only in one direction: under `OR` the
   * subquery can seek to the url but must then walk every version of it, while
   * the row value gives a range seek on the index's second column. The plans,
   * on `idx_pages_url_recency`:
   *
   *   OR:        SEARCH newer USING COVERING INDEX (normalized_url=?)
   *   row value: SEARCH newer USING COVERING INDEX (normalized_url=? AND fetched_at>?)
   *
   * `fetched_at` is NOT NULL and every row has a rowid, so the comparison can
   * never meet a NULL and the two forms select the same rows — including the
   * ties, which is the case the rowid half exists for.
   */
  private supersededPagesSql(select: string, placeholders: string): string {
    return `
      SELECT ${select} FROM pages p
      WHERE p.crawl_id IN (${placeholders})
        AND EXISTS (
          SELECT 1 FROM pages newer
          WHERE newer.normalized_url = p.normalized_url
            AND (newer.fetched_at, newer.rowid) > (p.fetched_at, p.rowid)
        )
    `;
  }

  /**
   * Retire the derived output of the named crawls (#1912).
   *
   * Their reports stop being renderable and they are stamped `retired_at`, which
   * is what lets `report` say so instead of rebuilding an empty one; the crawl
   * rows remain, so the audits are still listed. Everything the NEXT crawl reads
   * is preserved — see RETIREABLE_TABLES for what is excluded
   * and why. One transaction, so a crash cannot leave a half-retired crawl that
   * renders a partial report.
   */
  retireCrawls(
    crawlIds: string[],
    retiredAt: number = Date.now()
  ): Effect.Effect<number, StorageError, never> {
    // Never a crawl that is still being written. A prune racing a live audit
    // would delete the frontier out from under it and leave a half-written run.
    // Checked HERE rather than only in the caller so the guard cannot be
    // bypassed by a future caller that forgets it.

    return Effect.try({
      try: () => {
        if (crawlIds.length === 0) return 0;
        const db = this.getDb();
        const idList = crawlIds.map(() => "?").join(", ");
        const active = db
          .prepare(
            `SELECT id FROM crawls WHERE id IN (${idList}) AND status NOT IN ('completed', 'analyzed', 'failed')`
          )
          .all(...crawlIds) as Array<{ id: string }>;
        if (active.length > 0) {
          throw new Error(
            `Refusing to retire ${active.length} crawl(s) that are not finished: ${active
              .map((c) => c.id)
              .join(", ")}`
          );
        }
        const placeholders = idList;
        let deleted = 0;
        const run = db.transaction(() => {
          for (const table of SQLiteStorage.RETIREABLE_TABLES) {
            const result = db
              .prepare(
                `DELETE FROM ${table} WHERE crawl_id IN (${placeholders})`
              )
              .run(...crawlIds);
            deleted += Number(result.changes ?? 0);
          }
          const pageResult = db
            .prepare(
              `DELETE FROM pages WHERE rowid IN (${this.supersededPagesSql("p.rowid", placeholders)})`
            )
            .run(...crawlIds);
          deleted += Number(pageResult.changes ?? 0);
          // Stamp INSIDE the transaction, so a crash can never leave a crawl
          // whose data is gone but which still reads as renderable. That state
          // is worse than either end of it: the report path would rebuild a
          // confident empty report from the pages that survive.
          db.prepare(
            `UPDATE crawls SET retired_at = ? WHERE id IN (${placeholders})`
          ).run(retiredAt, ...crawlIds);
        });
        run();
        return deleted;
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /**
   * Delete page rows of ALREADY-retired crawls that a newer row now supersedes.
   *
   * {@link retireCrawls} runs the same predicate once, at the moment it retires
   * a crawl, and keeps any page whose row is then the freshest known record of
   * its url — correctly, because that row is the next crawl's cache entry. But
   * a LATER audit can crawl that url again and supersede it, and by then the
   * crawl it belongs to is retired and nothing looks at it again. On a site
   * whose url set moves between audits, one dead row per such url stays
   * forever, which is a slow leak in the feature that exists to stop growth.
   *
   * Deliberately NOT part of `retireCrawls`: calling that on an already-retired
   * crawl would re-stamp `retired_at`, moving the date a user is shown to the
   * day of an unrelated audit.
   *
   * Scoped to the urls `crawlId` wrote. Those are the only rows whose status can
   * have changed since the last pass. Rows superseded before this existed are
   * collected the next time their url is crawled rather than swept eagerly,
   * which is what keeps the cost proportional to the audit rather than to the
   * project history.
   *
   * Same predicate, same guarantee: a row only goes when a newer row for the
   * same url exists, so this can never take a cache entry the crawler reads.
   */
  collectSupersededPages(
    crawlId: string
  ): Effect.Effect<number, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        // Driven by the urls THIS crawl just wrote, not by the retired crawls.
        // Both alternatives are unbounded in the wrong variable: written as a
        // join SQLite drives the whole thing from `pages` and reads every row
        // in the table, live crawls included, and a list of every retired crawl
        // id costs one probe per audit the project has ever retired, forever.
        // Scoping to this crawl's urls is also exactly the set that can have
        // CHANGED, since a row only becomes superseded by an audit crawling its
        // url again:
        //
        //   SEARCH p USING INDEX idx_pages_url_recency (normalized_url=?)
        //   LIST SUBQUERY 1
        //     SEARCH pages USING COVERING INDEX sqlite_autoindex_pages_1 (crawl_id=?)
        //   CORRELATED SCALAR SUBQUERY 2
        //     SEARCH newer USING COVERING INDEX idx_pages_url_recency (...)
        //   CORRELATED SCALAR SUBQUERY 3
        //     SEARCH c USING INDEX sqlite_autoindex_crawls_1 (id=?)
        //
        // so the work is this audit's page count times the few rows sharing a
        // url, and nothing else.
        const result = db
          .prepare(
            `DELETE FROM pages WHERE rowid IN (
               SELECT p.rowid FROM pages p
               WHERE p.normalized_url IN (
                 SELECT normalized_url FROM pages WHERE crawl_id = ?
               )
               AND EXISTS (
                 SELECT 1 FROM pages newer
                 WHERE newer.normalized_url = p.normalized_url
                   AND (newer.fetched_at, newer.rowid) > (p.fetched_at, p.rowid)
               )
               AND (
                 SELECT retired_at FROM crawls c WHERE c.id = p.crawl_id
               ) IS NOT NULL
             )`
          )
          .run(crawlId);
        return Number(result.changes ?? 0);
      },
      catch: (e) => StorageError.write(e),
    });
  }

  /**
   * Rebuild the database file so deleted space returns to the filesystem.
   *
   * Separate from {@link retireCrawls} on purpose: SQLite only moves freed pages
   * to a freelist, so without this the file never shrinks, and VACUUM rewrites
   * the whole file, which is far too expensive to run as part of an audit
   * (#1908 is what happens when a per-audit full pass slips in).
   */
  vacuum(): Effect.Effect<void, StorageError, never> {
    return Effect.try({
      try: () => {
        const db = this.getDb();
        db.exec("VACUUM");
        // In WAL mode the rewrite lands in the write-ahead log, so without this
        // the main file shrinks and the `-wal` beside it grows by more than was
        // saved: a prune measured 189 MB before and 239 MB after. TRUNCATE
        // folds the log back in and takes it to zero, which is what makes the
        // reclaimed space real rather than moved.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      },
      catch: (e) => StorageError.write(e),
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
      meta_noindex, indexable_reasons, rich_result_types,
      nap_name, nap_phones, nap_phone_formats, nap_address, nap_address_format,
      nap_tel_link, nap_mailto_link,
      favicon_href, theme_color, og_image
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      row.napName,
      row.napPhones.length > 0 ? JSON.stringify(row.napPhones) : null,
      row.napPhoneFormats.length > 0 ? JSON.stringify(row.napPhoneFormats) : null,
      row.napAddress,
      row.napAddressFormat,
      row.napTelLink ? 1 : 0,
      row.napMailtoLink ? 1 : 0,
      row.faviconHref,
      row.themeColor,
      row.ogImage,
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
      napName: (row.nap_name as string | null) ?? null,
      napPhones: row.nap_phones
        ? this.safeJsonParse(row.nap_phones as string, [] as string[])
        : [],
      napPhoneFormats: row.nap_phone_formats
        ? this.safeJsonParse(row.nap_phone_formats as string, [] as string[])
        : [],
      napAddress: (row.nap_address as string | null) ?? null,
      napAddressFormat: (row.nap_address_format as string | null) ?? null,
      napTelLink: row.nap_tel_link === 1,
      napMailtoLink: row.nap_mailto_link === 1,
      faviconHref: (row.favicon_href as string | null) ?? null,
      themeColor: (row.theme_color as string | null) ?? null,
      ogImage: (row.og_image as string | null) ?? null,
    };
  }
}
