// AuditContext - the normalized site graph database
// This is the central state that flows through the entire graph execution

import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";
import { Effect, SubscriptionRef, Queue, Stream } from "effect";

import type { Config } from "@/config";
import type { FrontierEntry, FrontierStatus } from "@/crawler/types";
import type { GraphError } from "@/infra/errors";
import type {
  CheckResult,
  RobotsTxtData,
  SitemapData,
  SitemapFetchFailure,
  MetaData,
  OpenGraphData,
  TwitterData,
  SchemaData,
  HeadingHierarchy,
  ContentAnalysis,
  SecurityHeaders,
  ResponseHeaders,
  RedirectChain,
} from "@/types";

// ============================================
// LINK TYPES (deduplicated)
// ============================================

export type LinkPosition =
  | "header"
  | "footer"
  | "nav"
  | "content"
  | "sidebar"
  | "unknown";

export interface LinkAppearance {
  pageUrl: string;
  anchorText: string;
  position: LinkPosition;
  rel?: string[];
  isNofollow: boolean;
}

export interface SiteLink {
  href: string;
  isInternal: boolean;
  status?: number;
  error?: string;
  checkedAt?: number;
  appearances: LinkAppearance[];
}

export interface PageLinkRef {
  href: string; // Key into site.links
  anchorText: string;
  position: LinkPosition;
}

// ============================================
// IMAGE TYPES (deduplicated)
// ============================================

export interface ImageAppearance {
  pageUrl: string;
  alt?: string;
  width?: string;
  height?: string;
  isLazyLoaded: boolean;
  inFigure: boolean;
}

export interface SiteImage {
  src: string;
  status?: number;
  error?: string;
  checkedAt?: number;
  contentType?: string;
  size?: number;
  appearances: ImageAppearance[];
}

export interface PageImageRef {
  src: string; // Key into site.images
  alt?: string;
}

// ============================================
// PARSED PAGE DATA
// ============================================

export interface ParsedPageData {
  meta: MetaData;
  og: OpenGraphData;
  twitter: TwitterData;
  schema: SchemaData;
  headings: HeadingHierarchy;
  content: ContentAnalysis;
  h1: { count: number; texts: string[] };
}

// ============================================
// PAGE TYPE
// ============================================

export interface PageRaw {
  html: string;
  headers: ResponseHeaders;
  securityHeaders: SecurityHeaders;
  status: number;
  loadTime: number;
  ttfb?: number; // time to first byte (headers received)
  downloadTime?: number; // body download time
  fetchedAt: number;
  contentType?: string | null;
  finalUrl?: string;
  sizeBytes?: number;
  redirectChain?: RedirectChain;
}

export interface Page {
  url: string;
  raw: PageRaw | null;
  parsed: ParsedPageData | null;
  links: PageLinkRef[];
  images: PageImageRef[];
  ruleResults: CheckResult[];
  depth: number;
  parentUrl?: string;
}

// ============================================
// SITE GRAPH
// ============================================

export interface SiteGraph {
  pages: Map<string, Page>;
  links: Map<string, SiteLink>;
  images: Map<string, SiteImage>;
  robotsTxt: RobotsTxtData | null;
  sitemaps: SitemapData[];
  failedSitemaps: SitemapFetchFailure[];
}

// ============================================
// SETTINGS (merged config)
// ============================================

export interface Settings {
  crawler: {
    maxPages: number;
    delayMs: number;
    userAgent: string;
    followRedirects: boolean;
    concurrency: number;
    timeout: number;
    perHostConcurrency: number;
    perHostDelayMs: number;
    include: string[];
    exclude: string[];
    allowQueryParams: string[];
    dropQueryPrefixes: string[];
    respectRobots: boolean;
    allowedDomains: string[]; // Multi-domain project support
  };
  rules: {
    enable: string[];
    disable: string[];
  };
  output: {
    format: "json" | "html" | "console";
    path?: string;
  };
  ruleOptions: Record<string, Record<string, unknown>>;
}

// ============================================
// RULE CONFIG
// ============================================

export interface RuleConfig {
  enablePatterns: string[];
  disablePatterns: string[];

  matches(ruleId: string): boolean;
  isEnabled(ruleId: string): boolean;
}

export function createRuleConfig(
  enable: string[],
  disable: string[]
): RuleConfig {
  return {
    enablePatterns: enable,
    disablePatterns: disable,

    matches(ruleId: string): boolean {
      return this.isEnabled(ruleId);
    },

    isEnabled(ruleId: string): boolean {
      // Check disable patterns first
      for (const pattern of this.disablePatterns) {
        if (matchesRulePattern(ruleId, pattern)) {
          return false;
        }
      }
      // Check enable patterns
      for (const pattern of this.enablePatterns) {
        if (matchesRulePattern(ruleId, pattern)) {
          return true;
        }
      }
      return false;
    },
  };
}

// ============================================
// NODE EXECUTION TRACKING
// ============================================

export interface NodeExecution {
  nodeId: string;
  nodeName: string;
  startTime: number;
  endTime?: number;
  status: "running" | "success" | "failed" | "skipped";
  retryCount: number;
  error?: GraphError;
}

// ============================================
// AUDIT CONTEXT
// ============================================

export interface AuditContext {
  // Initial inputs
  targetUrl: string;
  baseUrl: string;
  settings: Settings;
  rules: RuleConfig;
  startTime: number;

  // Site graph
  project: {
    baseUrl: string;
    site: SiteGraph;
  };

  // Crawl state
  crawlQueue: Set<string>;
  visitedUrls: Set<string>;
  failedUrls: Map<string, GraphError>;
  frontier: Map<string, FrontierEntry>;

  // Execution metadata
  executions: NodeExecution[];
  errors: GraphError[];

  // Counters
  pagesCrawled: number;
  pagesMaxReached: boolean;
}

// ============================================
// CONTEXT CREATION
// ============================================

export function createInitialContext(
  targetUrl: string,
  config: Config
): AuditContext {
  const baseUrl = new URL(targetUrl).origin;

  const settings: Settings = {
    crawler: {
      maxPages: config.crawler.max_pages,
      delayMs: config.crawler.delay_ms,
      userAgent: config.crawler.user_agent,
      followRedirects: config.crawler.follow_redirects,
      concurrency: config.crawler.concurrency,
      timeout: config.crawler.timeout_ms,
      perHostConcurrency: config.crawler.per_host_concurrency,
      perHostDelayMs: config.crawler.per_host_delay_ms,
      include: config.crawler.include,
      exclude: config.crawler.exclude,
      allowQueryParams: config.crawler.allow_query_params,
      dropQueryPrefixes: config.crawler.drop_query_prefixes,
      respectRobots: config.crawler.respect_robots,
      allowedDomains: config.project?.domains ?? [],
    },
    rules: {
      enable: config.rules.enable,
      disable: config.rules.disable,
    },
    output: {
      format: config.output.format,
      path: config.output.path,
    },
    ruleOptions: config.rule_options,
  };

  return {
    targetUrl,
    baseUrl,
    settings,
    rules: createRuleConfig(config.rules.enable, config.rules.disable),
    startTime: Date.now(),

    project: {
      baseUrl,
      site: {
        pages: new Map(),
        links: new Map(),
        images: new Map(),
        robotsTxt: null,
        sitemaps: [],
        failedSitemaps: [],
      },
    },

    crawlQueue: new Set([targetUrl]),
    visitedUrls: new Set(),
    failedUrls: new Map(),
    frontier: new Map(),

    executions: [],
    errors: [],

    pagesCrawled: 0,
    pagesMaxReached: false,
  };
}

// ============================================
// REACTIVE CONTEXT (Effect primitives)
// ============================================

export type ContextRef = SubscriptionRef.SubscriptionRef<AuditContext>;
export type CrawlQueue = Queue.Queue<string>;

/**
 * Create a reactive context with SubscriptionRef
 */
export function createContextRef(
  initialContext: AuditContext
): Effect.Effect<ContextRef, never, never> {
  return SubscriptionRef.make(initialContext);
}

/**
 * Create a reactive crawl queue
 */
export function createCrawlQueue(): Effect.Effect<CrawlQueue, never, never> {
  return Queue.unbounded<string>();
}

/**
 * Update context immutably
 */
export function updateContext(
  ref: ContextRef,
  updater: (ctx: AuditContext) => AuditContext
): Effect.Effect<void, never, never> {
  return SubscriptionRef.update(ref, updater);
}

/**
 * Get current context
 */
export function getContext(
  ref: ContextRef
): Effect.Effect<AuditContext, never, never> {
  return SubscriptionRef.get(ref);
}

/**
 * Subscribe to context changes
 */
export function subscribeToChanges(
  ref: ContextRef
): Stream.Stream<AuditContext, never, never> {
  return ref.changes;
}

// ============================================
// CONTEXT MUTATION HELPERS
// ============================================

/**
 * Add a page to the site graph
 */
export function addPage(ctx: AuditContext, page: Page): AuditContext {
  const newPages = new Map(ctx.project.site.pages);
  newPages.set(page.url, page);

  return {
    ...ctx,
    project: {
      ...ctx.project,
      site: {
        ...ctx.project.site,
        pages: newPages,
      },
    },
    pagesCrawled: ctx.pagesCrawled + 1,
    pagesMaxReached: ctx.pagesCrawled + 1 >= ctx.settings.crawler.maxPages,
  };
}

/**
 * Add or update a link in the site graph
 */
export function addLink(
  ctx: AuditContext,
  href: string,
  appearance: LinkAppearance,
  isInternal: boolean
): AuditContext {
  const newLinks = new Map(ctx.project.site.links);
  const existing = newLinks.get(href);

  if (existing) {
    // Add appearance to existing link
    newLinks.set(href, {
      ...existing,
      appearances: [...existing.appearances, appearance],
    });
  } else {
    // Create new link entry
    newLinks.set(href, {
      href,
      isInternal,
      appearances: [appearance],
    });
  }

  return {
    ...ctx,
    project: {
      ...ctx.project,
      site: {
        ...ctx.project.site,
        links: newLinks,
      },
    },
  };
}

/**
 * Add or update an image in the site graph
 */
export function addImage(
  ctx: AuditContext,
  src: string,
  appearance: ImageAppearance
): AuditContext {
  const newImages = new Map(ctx.project.site.images);
  const existing = newImages.get(src);

  if (existing) {
    newImages.set(src, {
      ...existing,
      appearances: [...existing.appearances, appearance],
    });
  } else {
    newImages.set(src, {
      src,
      appearances: [appearance],
    });
  }

  return {
    ...ctx,
    project: {
      ...ctx.project,
      site: {
        ...ctx.project.site,
        images: newImages,
      },
    },
  };
}

/**
 * Mark a URL as visited
 */
export function markVisited(ctx: AuditContext, url: string): AuditContext {
  const newVisited = new Set(ctx.visitedUrls);
  newVisited.add(url);

  const newQueue = new Set(ctx.crawlQueue);
  newQueue.delete(url);

  return {
    ...ctx,
    visitedUrls: newVisited,
    crawlQueue: newQueue,
  };
}

/**
 * Add URLs to crawl queue (with deduplication)
 */
export function addToQueue(ctx: AuditContext, urls: string[]): AuditContext {
  const newQueue = new Set(ctx.crawlQueue);

  for (const url of urls) {
    // Only add if not visited and not already in queue
    if (!ctx.visitedUrls.has(url) && !ctx.project.site.pages.has(url)) {
      newQueue.add(url);
    }
  }

  return {
    ...ctx,
    crawlQueue: newQueue,
  };
}

/**
 * Record a crawl failure
 */
export function recordFailure(
  ctx: AuditContext,
  url: string,
  error: GraphError
): AuditContext {
  const newFailed = new Map(ctx.failedUrls);
  newFailed.set(url, error);

  const newErrors = [...ctx.errors, error];

  return {
    ...ctx,
    failedUrls: newFailed,
    errors: newErrors,
  };
}

/**
 * Add or update a frontier entry
 */
export function upsertFrontierEntry(
  ctx: AuditContext,
  entry: FrontierEntry
): AuditContext {
  const newFrontier = new Map(ctx.frontier);
  newFrontier.set(entry.normalizedUrl, entry);

  return {
    ...ctx,
    frontier: newFrontier,
  };
}

/**
 * Update a frontier entry status
 */
export function updateFrontierStatus(
  ctx: AuditContext,
  normalizedUrl: string,
  status: FrontierStatus,
  reason?: string
): AuditContext {
  const existing = ctx.frontier.get(normalizedUrl);
  if (!existing) return ctx;

  const newFrontier = new Map(ctx.frontier);
  newFrontier.set(normalizedUrl, {
    ...existing,
    status,
    reason: reason ?? existing.reason,
    fetchedAt:
      status === "done" || status === "failed"
        ? Date.now()
        : existing.fetchedAt,
  });

  return {
    ...ctx,
    frontier: newFrontier,
  };
}

/**
 * Update link status after checking
 */
export function updateLinkStatus(
  ctx: AuditContext,
  href: string,
  status: number,
  error?: string
): AuditContext {
  const newLinks = new Map(ctx.project.site.links);
  const existing = newLinks.get(href);

  if (existing) {
    newLinks.set(href, {
      ...existing,
      status,
      error,
      checkedAt: Date.now(),
    });
  }

  return {
    ...ctx,
    project: {
      ...ctx.project,
      site: {
        ...ctx.project.site,
        links: newLinks,
      },
    },
  };
}

/**
 * Set robots.txt data
 */
export function setRobotsTxt(
  ctx: AuditContext,
  robotsTxt: RobotsTxtData
): AuditContext {
  return {
    ...ctx,
    project: {
      ...ctx.project,
      site: {
        ...ctx.project.site,
        robotsTxt,
      },
    },
  };
}

/**
 * Add sitemap data
 */
export function addSitemap(
  ctx: AuditContext,
  sitemap: SitemapData
): AuditContext {
  return {
    ...ctx,
    project: {
      ...ctx.project,
      site: {
        ...ctx.project.site,
        sitemaps: [...ctx.project.site.sitemaps, sitemap],
      },
    },
  };
}

/**
 * Track node execution
 */
export function startNodeExecution(
  ctx: AuditContext,
  nodeId: string,
  nodeName: string
): AuditContext {
  const execution: NodeExecution = {
    nodeId,
    nodeName,
    startTime: Date.now(),
    status: "running",
    retryCount: 0,
  };

  return {
    ...ctx,
    executions: [...ctx.executions, execution],
  };
}

export function completeNodeExecution(
  ctx: AuditContext,
  nodeId: string,
  status: "success" | "failed" | "skipped",
  error?: GraphError
): AuditContext {
  const executions = ctx.executions.map((exec) => {
    if (exec.nodeId === nodeId && exec.status === "running") {
      return {
        ...exec,
        endTime: Date.now(),
        status,
        error,
      };
    }
    return exec;
  });

  return {
    ...ctx,
    executions,
  };
}
