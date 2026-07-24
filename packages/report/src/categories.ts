// Category metadata for report display (no rule deps)

/**
 * Top-level rule groups (#626). Mirror of the RuleGroup union in
 * packages/core-contracts/src/index.ts (canonical) — this package is
 * intentionally dependency-free, so it redefines rather than imports.
 */
export type RuleGroup = "seo" | "performance" | "security" | "ai";

export interface CategoryInfo {
  code: string;
  name: string;
  description: string;
  priority: number;
  group: RuleGroup; // top-level group this category rolls up into (#626)
}

export interface GroupInfo {
  code: RuleGroup;
  name: string;
  /** Full display title where the short `name` needs spelling out (ai → "Agent Experience"). */
  title: string;
}

/**
 * The 4 top-level groups in display order (#626). Mirror of GROUPS in
 * packages/rules/src/categories.ts (canonical). Guarded by the category drift
 * test so the mirrors can't diverge.
 */
export const GROUPS: Record<RuleGroup, GroupInfo> = {
  seo: { code: "seo", name: "SEO", title: "SEO" },
  performance: { code: "performance", name: "Performance", title: "Performance" },
  security: { code: "security", name: "Security", title: "Security" },
  ai: { code: "ai", name: "Agents", title: "Agent Experience" },
};

/** All group codes in display order. */
export const GROUP_CODES = Object.keys(GROUPS) as RuleGroup[];

export const CATEGORIES: Record<string, CategoryInfo> = {
  crawl: { code: "crawl", name: "Crawlability", description: "Robots.txt, sitemaps, and crawl directives", priority: 100, group: "seo" },
  core: { code: "core", name: "Core SEO", description: "Essential meta tags and page structure for search engines", priority: 95, group: "seo" },
  security: { code: "security", name: "Security", description: "HTTPS, headers, and safe link practices", priority: 90, group: "security" },
  integrity: { code: "integrity", name: "Site Integrity", description: "Signs of compromise: injected pages, phishing kits, malware, SEO spam", priority: 92, group: "security" },
  links: { code: "links", name: "Links", description: "Internal and external link health and structure", priority: 85, group: "seo" },
  content: { code: "content", name: "Content", description: "Text quality, readability, and content structure", priority: 80, group: "seo" },
  schema: { code: "schema", name: "Structured Data", description: "Structured data and rich snippet eligibility", priority: 75, group: "seo" },
  images: { code: "images", name: "Images", description: "Image optimization and accessibility", priority: 70, group: "seo" },
  perf: { code: "perf", name: "Performance", description: "Page speed and loading performance", priority: 70, group: "performance" },
  social: { code: "social", name: "Social Media", description: "Open Graph and social sharing metadata", priority: 65, group: "seo" },
  a11y: { code: "a11y", name: "Accessibility", description: "Accessibility for users with disabilities", priority: 60, group: "seo" },
  mobile: { code: "mobile", name: "Mobile", description: "Mobile-friendliness and responsive design", priority: 60, group: "seo" },
  url: { code: "url", name: "URL Structure", description: "URL structure, length, and formatting", priority: 55, group: "seo" },
  i18n: { code: "i18n", name: "Internationalization", description: "Language declarations and multi-region support", priority: 50, group: "seo" },
  eeat: { code: "eeat", name: "E-E-A-T", description: "Experience, expertise, authority, trust signals", priority: 45, group: "seo" },
  legal: { code: "legal", name: "Legal Compliance", description: "Privacy policy and legal compliance signals", priority: 40, group: "security" },
  local: { code: "local", name: "Local SEO", description: "Local business schema and NAP consistency", priority: 35, group: "seo" },
  video: { code: "video", name: "Video", description: "Video content markup and accessibility", priority: 30, group: "seo" },
  analytics: { code: "analytics", name: "Analytics", description: "Tracking and measurement implementation", priority: 25, group: "seo" },
  ax: { code: "ax", name: "Agent Experience", description: "How ready a site is for AI agents to read, discover, and operate on it", priority: 20, group: "ai" },
  gaps: { code: "gaps", name: "Keyword & Content Gaps", description: "Keyword and content opportunities the site doesn't cover", priority: 15, group: "seo" },
  blocking: { code: "blocking", name: "Blocking", description: "Content, links, and trackers that ad blockers and privacy filters block", priority: 10, group: "security" },
  other: { code: "other", name: "Other", description: "Uncategorized or legacy rules", priority: 0, group: "seo" },
};

export const OTHER_CATEGORY = "other";

/**
 * Legacy category-code aliases. Reports stored before a category rename keep
 * the old code in R2; normalize on the way into grouping/rendering so they
 * still land in the right section. `adblock` → `blocking` (renamed 2026-06);
 * `ai` → `ax` (AI Analysis folded into Agent Experience).
 *
 * Mirror of packages/core-contracts/src/index.ts (canonical). This package is
 * intentionally dependency-free, so it re-defines rather than imports — keep
 * in sync.
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
 * Derive a blocking subcategory for legacy reports whose rule meta predates the
 * `subcategory` field. Keyed on the stable rule IDs; privacy filter matches are
 * privacy, everything else under blocking is ad.
 */
export function deriveBlockingSubcategory(ruleId: string): string | undefined {
  if (ruleId === "adblock/privacy-blocked") return "privacy";
  if (ruleId === "adblock/blocked-links" || ruleId === "adblock/element-hiding") {
    return "ad";
  }
  return undefined;
}

/**
 * Sub-categories: optional second grouping level within a category.
 * Mirror of packages/rules/src/categories.ts SUBCATEGORIES (report pkg is dep-free).
 */
const SUBCATEGORIES: Record<string, { name: string; priority: number }> = {
  ad: { name: "Ad blocking", priority: 20 },
  privacy: { name: "Privacy blocking", priority: 10 },
};

/** Display name for a subcategory code; falls back to the raw code. */
export function getSubcategoryName(code: string): string {
  return SUBCATEGORIES[code]?.name ?? code;
}

/** Sort priority for a subcategory code (higher first); unknown → 0. */
export function getSubcategoryPriority(code: string): number {
  return SUBCATEGORIES[code]?.priority ?? 0;
}

export function getCategoryName(category: string): string {
  return CATEGORIES[category]?.name ?? CATEGORIES.other.name;
}

export function getCategoryPriority(category: string): number {
  return CATEGORIES[category]?.priority ?? 0;
}

export function isValidCategory(code: string): boolean {
  return code in CATEGORIES;
}

/** The top-level group a category rolls up into (#626); unknown → `other`'s group. */
export function getCategoryGroup(category: string): RuleGroup {
  return CATEGORIES[category]?.group ?? CATEGORIES.other.group;
}

/** Display name for a group code (e.g. "seo" → "SEO"); unknown → the raw code. */
export function getGroupName(group: string): string {
  return GROUPS[group as RuleGroup]?.name ?? group;
}

/** Full display title for a group code (e.g. "ai" → "Agent Experience"); unknown → the raw code. */
export function getGroupTitle(group: string): string {
  return GROUPS[group as RuleGroup]?.title ?? group;
}

export function isValidGroup(code: string): boolean {
  return code in GROUPS;
}

/**
 * Human-facing label for a rule severity, for HUMAN renderers (text/markdown)
 * only — machine formats (json/xml/llm) keep the raw `error`/`warning`/`info`
 * value since downstream parsers depend on it. `info` reads as "recommendation"
 * (product framing: a suggestion, not a warning); error/warning pass through
 * unchanged. Pass `titleCase` for renderers that capitalize (e.g. markdown badges).
 */
export function severityLabel(
  severity: "error" | "warning" | "info",
  options?: { titleCase?: boolean }
): string {
  const label = severity === "info" ? "recommendation" : severity;
  return options?.titleCase ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}
