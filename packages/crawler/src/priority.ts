// Priority calculation for the URL frontier
// Lower priority value = higher priority (crawled first)

import {
  CRAWL_BREADTH_DEPTH_PENALTY,
  CRAWL_BREADTH_MAX_PREFIX_PENALTY,
  CRAWL_BREADTH_PENALTY_MULTIPLIER,
  PATTERN_SAMPLED_PENALTY,
} from "@squirrelscan/utils/constants";

import type { FrontierSource } from "./storage/types";

// ============================================
// PRIORITY FACTORS
// ============================================

export interface PriorityFactors {
  /** Crawl depth from seed URL (0 = seed) */
  depth: number;
  /** Priority value from sitemap (0.0-1.0, higher = more important) */
  sitemapPriority?: number;
  /** Number of pages linking to this URL */
  incomingLinkCount: number;
  /** How the URL was discovered */
  source: FrontierSource;
}

// ============================================
// PRIORITY WEIGHTS
// ============================================

const WEIGHTS = {
  /** Base multiplier for depth (deeper = lower priority) */
  depth: 100,
  /** Maximum bonus for sitemap priority (1.0 priority = full bonus) */
  sitemapPriorityBonus: 200,
  /** Bonus per incoming link (capped) */
  incomingLinkBonus: 10,
  /** Maximum incoming links to count */
  maxIncomingLinks: 10,
  /** Bonus for path importance (homepage, key pages) */
  pathImportanceBonus: 50,
  /** Source bonuses (seed is most important) */
  sourceBonus: {
    seed: -1000,
    // Carried-finding pages (#1146): sort just behind the seed, ahead of sitemap
    // + discovery, so their findings get re-checked within budget.
    carried: -900,
    sitemap: -500,
    discovered: 0,
  },
} as const;

/**
 * Penalty added to a URL recently observed 404/410 (#1146). Large enough to sink
 * it below any live page regardless of its other priority factors, so dead URLs
 * stop eating budget slots — but still finite, so it's crawled (and re-confirmed
 * removed) if budget remains after the live frontier drains.
 */
export const RECENTLY_REMOVED_PENALTY = 100_000;

// ============================================
// BREADTH-FIRST FACTORS
// ============================================

export interface BreadthFirstFactors {
  /** Number of URLs already crawled from this prefix */
  prefixCrawledCount: number;
  /** Total number of known prefixes */
  totalPrefixes: number;
  /** Max pages budget for this crawl */
  maxPages: number;
  /** Depth of this URL */
  depth: number;
  /** Number of pending URLs at depth 1 (for depth guarantee) */
  pendingDepth1Count: number;
  /** Max percentage of budget any single prefix can consume (0.0-1.0) */
  maxPrefixBudgetRatio: number;
}

/**
 * Calculate priority penalty for breadth-first crawling
 * Returns a positive penalty (higher = lower priority)
 */
export function calculateBreadthPenalty(factors: BreadthFirstFactors): number {
  // Depth-1 guarantee: heavy penalty if depth-2+ and depth-1 URLs still pending
  if (factors.depth > 1 && factors.pendingDepth1Count > 0) {
    return CRAWL_BREADTH_DEPTH_PENALTY;
  }

  // Calculate max pages per prefix from config ratio
  const maxPrefixPages = factors.maxPages * factors.maxPrefixBudgetRatio;
  // Fair share is the smaller of: config cap OR equal distribution
  // Use Math.max with small epsilon to prevent division by zero
  const fairShare = Math.max(
    0.001,
    Math.min(
      maxPrefixPages,
      factors.maxPages / Math.max(factors.totalPrefixes, 1)
    )
  );
  const overBudgetRatio = factors.prefixCrawledCount / fairShare;

  // No penalty if under fair share
  if (overBudgetRatio <= 1) {
    return 0;
  }

  // Increasing penalty for over-represented prefixes
  return Math.min(
    Math.floor((overBudgetRatio - 1) * CRAWL_BREADTH_PENALTY_MULTIPLIER),
    CRAWL_BREADTH_MAX_PREFIX_PENALTY
  );
}

/**
 * Calculate priority with breadth-first awareness
 */
export function calculatePriorityWithBreadth(
  factors: PriorityFactors,
  url: string,
  breadthFactors: BreadthFirstFactors
): number {
  let score = calculatePriorityWithPath(factors, url);
  score += calculateBreadthPenalty(breadthFactors);
  return Math.round(score);
}

// ============================================
// SURFACE MODE FACTORS (PATTERN SAMPLING)
// ============================================

export interface SurfaceModeFactors {
  /** Number of URLs already crawled from this pattern */
  patternCrawledCount: number;
  /** Max URLs to sample per pattern */
  patternSampleLimit: number;
}

/**
 * Calculate penalty for surface mode (one URL per pattern)
 * Returns a heavy penalty if pattern already sampled
 */
export function calculatePatternPenalty(factors: SurfaceModeFactors): number {
  if (factors.patternCrawledCount >= factors.patternSampleLimit) {
    return PATTERN_SAMPLED_PENALTY;
  }
  return 0;
}

/**
 * Calculate priority with pattern awareness for surface mode
 */
export function calculatePriorityWithSurface(
  factors: PriorityFactors,
  url: string,
  breadthFactors: BreadthFirstFactors,
  surfaceFactors: SurfaceModeFactors
): number {
  let score = calculatePriorityWithBreadth(factors, url, breadthFactors);
  score += calculatePatternPenalty(surfaceFactors);
  return Math.round(score);
}

// ============================================
// PATH IMPORTANCE
// ============================================

/** Patterns that indicate important pages (matched against pathname) */
const KEY_PATH_PATTERNS = [
  /^\/$/, // Homepage
  /^\/about\/?$/i, // About page
  /^\/contact\/?$/i, // Contact page
  /^\/products?\/?$/i, // Products
  /^\/services?\/?$/i, // Services
  /^\/pricing\/?$/i, // Pricing
  /^\/blog\/?$/i, // Blog index
  /^\/news\/?$/i, // News index
  /^\/faq\/?$/i, // FAQ
  /^\/help\/?$/i, // Help
  /^\/support\/?$/i, // Support
  /^\/docs?\/?$/i, // Documentation
  /^\/features?\/?$/i, // Features
  /^\/solutions?\/?$/i, // Solutions
  /^\/resources?\/?$/i, // Resources
  /^\/careers?\/?$/i, // Careers
  /^\/team\/?$/i, // Team
  /^\/login\/?$/i, // Login
  /^\/signup\/?$/i, // Signup
  /^\/register\/?$/i, // Register
];

/**
 * Pages that audit rules (eeat/legal) depend on existing in the crawl set.
 * There are at most a handful per site, so always crawl them first —
 * otherwise large sitemaps (e.g. 70 blog posts) exhaust the page budget
 * and the eeat/contact-page & privacy-policy rules false-positive.
 */
const AUDIT_CRITICAL_PATH_PATTERNS = [
  /^\/about(-us)?\/?$/i,
  /^\/contact(-us)?\/?$/i,
  /^\/privacy(-policy|-notice)?\/?$/i,
  /^\/terms(-of-service|-of-use|-and-conditions)?\/?$/i,
  /^\/legal\/?$/i,
  /^\/impressum\/?$/i,
  /^\/imprint\/?$/i,
];

/** Large negative bonus: sorts just after the seed, ahead of sitemap URLs */
const AUDIT_CRITICAL_BONUS = 800;

export function isAuditCriticalPath(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return AUDIT_CRITICAL_PATH_PATTERNS.some((p) => p.test(path));
  } catch {
    return false;
  }
}

/**
 * Calculate path importance based on URL structure
 * Returns 0.0-1.0 (higher = more important)
 */
export function getPathImportance(url: string): number {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;

    // Homepage is most important
    if (path === "/" || path === "") {
      return 1.0;
    }

    // Key pages get high importance
    for (const pattern of KEY_PATH_PATTERNS) {
      if (pattern.test(path)) {
        return 0.8;
      }
    }

    // Count path segments (shallower = more important)
    const segments = path.split("/").filter(Boolean);

    if (segments.length === 1) {
      return 0.6; // Top-level page
    }

    if (segments.length === 2) {
      return 0.4; // Second-level page
    }

    if (segments.length === 3) {
      return 0.2; // Third-level page
    }

    // Deep pages get minimal importance
    return 0.1;
  } catch {
    return 0;
  }
}

// ============================================
// PRIORITY CALCULATION
// ============================================

/**
 * Calculate priority score for a URL
 * Lower score = higher priority (crawled first)
 *
 * Formula:
 *   score = (depth * 100)
 *         - (sitemapPriority * 200)
 *         - (min(incomingLinks, 10) * 10)
 *         - (pathImportance * 50)
 *         + sourceBonus
 *
 * Example scores:
 *   - Homepage (seed): -1000 + 0 - 0 - 50 = -1050
 *   - Sitemap URL (priority 1.0): -500 + 0 - 200 - 0 = -700
 *   - Discovered /about: 0 + 100 - 0 - 40 = 60
 *   - Deep page /a/b/c/d: 0 + 400 - 0 - 5 = 395
 */
export function calculatePriority(factors: PriorityFactors): number {
  let score = 0;

  // Depth penalty (deeper = higher score = lower priority)
  score += factors.depth * WEIGHTS.depth;

  // Sitemap priority bonus (higher sitemap priority = lower score = higher priority)
  if (factors.sitemapPriority !== undefined) {
    score -= factors.sitemapPriority * WEIGHTS.sitemapPriorityBonus;
  }

  // Incoming link bonus (more links = lower score = higher priority)
  const cappedLinks = Math.min(
    factors.incomingLinkCount,
    WEIGHTS.maxIncomingLinks
  );
  score -= cappedLinks * WEIGHTS.incomingLinkBonus;

  // Source bonus
  score += WEIGHTS.sourceBonus[factors.source];

  // Ensure non-negative for cleaner numbers (optional)
  return Math.round(score);
}

/**
 * Calculate priority for a URL with path importance
 */
export function calculatePriorityWithPath(
  factors: PriorityFactors,
  url: string
): number {
  const pathImportance = getPathImportance(url);
  let score = calculatePriority(factors);

  // Path importance bonus
  score -= pathImportance * WEIGHTS.pathImportanceBonus;

  // Audit-critical pages (contact/about/privacy/terms) must always make it
  // into the crawl budget regardless of discovery source
  if (isAuditCriticalPath(url)) {
    score -= AUDIT_CRITICAL_BONUS;
  }

  return Math.round(score);
}

// ============================================
// PRIORITY UTILITIES
// ============================================

/**
 * Get a human-readable priority label
 */
export function getPriorityLabel(priority: number): string {
  if (priority <= -900) return "critical";
  if (priority <= -400) return "high";
  if (priority <= 0) return "normal";
  if (priority <= 200) return "low";
  return "minimal";
}

/**
 * Compare two priority values (for sorting)
 * Returns negative if a should come before b
 */
export function comparePriority(a: number, b: number): number {
  return a - b; // Lower priority value = higher priority
}

/**
 * Default priority for different sources
 */
export const DEFAULT_PRIORITIES = {
  seed: calculatePriority({ depth: 0, incomingLinkCount: 0, source: "seed" }),
  sitemap: (sitemapPriority: number = 0.5) =>
    calculatePriority({
      depth: 0,
      incomingLinkCount: 0,
      source: "sitemap",
      sitemapPriority,
    }),
  discovered: (depth: number, incomingLinks: number = 0) =>
    calculatePriority({
      depth,
      incomingLinkCount: incomingLinks,
      source: "discovered",
    }),
} as const;
