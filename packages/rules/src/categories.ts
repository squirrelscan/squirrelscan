// Centralized rule category definitions and metadata
// Category = grouping of audit rules (core, content, links, etc.)

import type { RuleGroup } from "@squirrelscan/core-contracts";

/**
 * Category metadata
 */
export interface CategoryInfo {
  code: string; // "core"
  name: string; // "Core SEO"
  description: string; // "Essential meta tags and page structure"
  priority: number; // 0-100, higher = more important for sorting
  group: RuleGroup; // "seo" — the top-level group this category rolls up into (#626)
}

/** Top-level rule group metadata (#626). */
export interface GroupInfo {
  code: RuleGroup;
  name: string;
  /** Full display title where the short `name` needs spelling out (ai → "Agent Experience"). */
  title: string;
}

/**
 * The 4 top-level rule groups (#626), in display order. Every category maps to
 * exactly one of these via its `group` field below. Group scores roll up the
 * per-category scores; the scalar `overall` health score is unchanged.
 */
export const GROUPS = {
  seo: { code: "seo", name: "SEO", title: "SEO" },
  performance: { code: "performance", name: "Performance", title: "Performance" },
  security: { code: "security", name: "Security", title: "Security" },
  ai: { code: "ai", name: "Agents", title: "Agent Experience" },
} as const satisfies Record<RuleGroup, GroupInfo>;

/** All group codes in display order. */
export const GROUP_CODES = Object.keys(GROUPS) as RuleGroup[];

/**
 * All rule categories with metadata
 * Keys must match the category codes used in rule meta.category
 */
export const CATEGORIES = {
  crawl: {
    code: "crawl",
    name: "Crawlability",
    description: "Robots.txt, sitemaps, and crawl directives",
    priority: 100,
    group: "seo",
  },
  core: {
    code: "core",
    name: "Core SEO",
    description: "Essential meta tags and page structure for search engines",
    priority: 95,
    group: "seo",
  },
  security: {
    code: "security",
    name: "Security",
    description: "HTTPS, headers, and safe link practices",
    priority: 90,
    group: "security",
  },
  integrity: {
    code: "integrity",
    name: "Site Integrity",
    description:
      "Signs of compromise: injected pages, phishing kits, malware, SEO spam",
    priority: 92, // surfaces at the top, ahead of security, so compromise is loud
    group: "security",
  },
  links: {
    code: "links",
    name: "Links",
    description: "Internal and external link health and structure",
    priority: 85,
    group: "seo",
  },
  content: {
    code: "content",
    name: "Content",
    description: "Text quality, readability, and content structure",
    priority: 80,
    group: "seo",
  },
  schema: {
    code: "schema",
    name: "Structured Data",
    description: "Structured data and rich snippet eligibility",
    priority: 75,
    group: "seo",
  },
  images: {
    code: "images",
    name: "Images",
    description: "Image optimization and accessibility",
    priority: 70,
    group: "seo",
  },
  perf: {
    code: "perf",
    name: "Performance",
    description: "Page speed and loading performance",
    priority: 70,
    group: "performance",
  },
  social: {
    code: "social",
    name: "Social Media",
    description: "Open Graph and social sharing metadata",
    priority: 65,
    group: "seo",
  },
  a11y: {
    code: "a11y",
    name: "Accessibility",
    description: "Accessibility for users with disabilities",
    priority: 60,
    group: "seo",
  },
  mobile: {
    code: "mobile",
    name: "Mobile",
    description: "Mobile-friendliness and responsive design",
    priority: 60,
    group: "seo",
  },
  url: {
    code: "url",
    name: "URL Structure",
    description: "URL structure, length, and formatting",
    priority: 55,
    group: "seo",
  },
  i18n: {
    code: "i18n",
    name: "Internationalization",
    description: "Language declarations and multi-region support",
    priority: 50,
    group: "seo",
  },
  eeat: {
    code: "eeat",
    name: "E-E-A-T",
    description: "Experience, expertise, authority, trust signals",
    priority: 45,
    group: "seo",
  },
  legal: {
    code: "legal",
    name: "Legal Compliance",
    description: "Privacy policy and legal compliance signals",
    priority: 40,
    group: "security",
  },
  local: {
    code: "local",
    name: "Local SEO",
    description: "Local business schema and NAP consistency",
    priority: 35,
    group: "seo",
  },
  video: {
    code: "video",
    name: "Video",
    description: "Video content markup and accessibility",
    priority: 30,
    group: "seo",
  },
  analytics: {
    code: "analytics",
    name: "Analytics",
    description: "Tracking and measurement implementation",
    priority: 25,
    group: "seo",
  },
  ax: {
    code: "ax",
    name: "Agent Experience",
    description:
      "How ready a site is for AI agents to read, discover, and operate on it",
    priority: 20,
    group: "ai",
  },
  gaps: {
    code: "gaps",
    name: "Keyword & Content Gaps",
    description: "Keyword and content opportunities the site doesn't cover",
    priority: 15,
    group: "seo",
  },
  blocking: {
    code: "blocking",
    name: "Blocking",
    description:
      "Content, links, and trackers that ad blockers and privacy filters block",
    priority: 10,
    group: "security",
  },
  other: {
    code: "other",
    name: "Other",
    description: "Uncategorized or legacy rules",
    priority: 0,
    group: "seo",
  },
} as const satisfies Record<string, CategoryInfo>;

// Import and re-export RuleCategory / RuleGroup from core-contracts (canonical source)
import type { RuleCategory } from "@squirrelscan/core-contracts";
export type { RuleCategory, RuleGroup };

/**
 * Fallback category for rules not in registry
 */
export const OTHER_CATEGORY: RuleCategory = "other";

/**
 * All category codes as an array (for iteration)
 */
export const CATEGORY_CODES = Object.keys(CATEGORIES) as RuleCategory[];

/**
 * Valid category values for CLI arguments and shell completions
 */
export const RULE_CATEGORY_VALUES = CATEGORY_CODES;

/**
 * Code → display name lookup
 */
export const CATEGORY_NAMES: Record<RuleCategory, string> = Object.fromEntries(
  Object.values(CATEGORIES).map((c) => [c.code, c.name])
) as Record<RuleCategory, string>;

/**
 * Get display name for a category
 */
export function getCategoryName(category: RuleCategory): string {
  return CATEGORIES[category].name;
}

/**
 * Get full category info
 */
export function getCategoryInfo(category: RuleCategory): CategoryInfo {
  return CATEGORIES[category];
}

/**
 * Get description for a category
 */
export function getCategoryDescription(category: RuleCategory): string {
  return CATEGORIES[category].description;
}

/**
 * Get priority for a category (0-100, higher = more important)
 */
export function getCategoryPriority(category: RuleCategory): number {
  return CATEGORIES[category].priority;
}

/**
 * Get all categories sorted by priority (highest first)
 */
export function getCategoriesSortedByPriority(): RuleCategory[] {
  return [...CATEGORY_CODES].sort(
    (a, b) => CATEGORIES[b].priority - CATEGORIES[a].priority
  );
}

/**
 * Check if a string is a valid category code
 */
export function isValidCategory(code: string): code is RuleCategory {
  return code in CATEGORIES;
}

/**
 * The top-level group a category rolls up into (#626). Unknown codes fall back
 * to the group of the `other` category.
 */
export function getCategoryGroup(category: string): RuleGroup {
  return (CATEGORIES as Record<string, CategoryInfo>)[category]?.group ?? CATEGORIES.other.group;
}

/** Display name for a group code (e.g. "seo" → "SEO"); unknown → the raw code. */
export function getGroupName(group: string): string {
  return (GROUPS as Record<string, GroupInfo>)[group]?.name ?? group;
}

/** Full group info; unknown code → undefined. */
export function getGroupInfo(group: string): GroupInfo | undefined {
  return (GROUPS as Record<string, GroupInfo>)[group];
}

/** Check if a string is a valid group code. */
export function isValidGroup(code: string): code is RuleGroup {
  return code in GROUPS;
}

/**
 * Every category that belongs to a group, in canonical CATEGORY_CODES order
 * (#626). This is the edge-expansion helper for `group:<id>` filters — expand a
 * group to its member `category/*` patterns at the config edge; the pattern
 * engine and stored shape stay unchanged.
 */
export function getCategoriesInGroup(group: RuleGroup): RuleCategory[] {
  return CATEGORY_CODES.filter((code) => CATEGORIES[code].group === group);
}

/**
 * Legacy category-code aliases. Reports/configs written before a category
 * rename keep the old code; normalize before validation/grouping.
 * `adblock` → `blocking` (renamed 2026-06); `ai` → `ax` (AI Analysis folded
 * into Agent Experience).
 *
 * Mirror of packages/core-contracts/src/index.ts (canonical) — keep in sync.
 */
const CATEGORY_ALIASES: Record<string, string> = {
  adblock: "blocking",
  ai: "ax",
};

/** Map a (possibly legacy) category code to its current canonical code. */
export function normalizeCategoryCode(code: string): string {
  return CATEGORY_ALIASES[code] ?? code;
}

/**
 * Sub-categories: an optional second grouping level within a category.
 * Currently only the `blocking` category uses them (ad vs privacy blocking).
 * Keys must match the codes used in rule `meta.subcategory`.
 */
export const SUBCATEGORIES = {
  ad: { code: "ad", name: "Ad blocking", priority: 20 },
  privacy: { code: "privacy", name: "Privacy blocking", priority: 10 },
} as const satisfies Record<
  string,
  { code: string; name: string; priority: number }
>;

export type SubcategoryCode = keyof typeof SUBCATEGORIES;

/** Display name for a subcategory code; falls back to the raw code. */
export function getSubcategoryName(code: string): string {
  return (SUBCATEGORIES as Record<string, { name: string }>)[code]?.name ?? code;
}

/** Sort priority for a subcategory code (higher first); unknown → 0. */
export function getSubcategoryPriority(code: string): number {
  return (
    (SUBCATEGORIES as Record<string, { priority: number }>)[code]?.priority ?? 0
  );
}
