// Shared helpers for rendering the report-only Technologies section across all
// output formats. Detected tech is informational — it NEVER affects the score.

import type {
  ReportTechnologies,
  ReportTechnology,
  TechnologyCategory,
} from "./types";

/** Public base for technology logos (PNG keyed by the fingerprint `icon`). */
export const TECH_ICON_BASE_URL = "https://squirrelscan.com/tech-icons";

/**
 * Absolute logo URL for a tech icon slug, or null when no icon is known.
 * The slug is sanitized to `[a-z0-9._-]` (lowercased) so a DB-stored/returned
 * icon value can never inject a path-traversal segment into the asset URL.
 */
export function techIconUrl(icon?: string | null): string | null {
  if (!icon) return null;
  const slug = icon.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return slug ? `${TECH_ICON_BASE_URL}/${slug}.png` : null;
}

/** Display order for category groups (most identifying first). */
const CATEGORY_ORDER: TechnologyCategory[] = [
  "cms",
  "framework",
  "web-server",
  "hosting",
  "cdn",
  "analytics",
  "tag-manager",
  "ad-network",
  "payment",
  "chat",
  "security",
  "font",
  "video",
  "widget",
  "other",
];

const CATEGORY_LABEL: Record<TechnologyCategory, string> = {
  cms: "CMS & Ecommerce",
  framework: "Frameworks & Libraries",
  "web-server": "Web Servers",
  hosting: "Hosting",
  cdn: "CDN & Edge",
  analytics: "Analytics",
  "tag-manager": "Tag Managers",
  "ad-network": "Advertising",
  payment: "Payments",
  chat: "Support & Chat",
  security: "Security & Consent",
  font: "Fonts",
  video: "Video & Media",
  widget: "Widgets & UI",
  other: "Other",
};

/** Small emoji per category — terminal flair where logos can't render. */
const CATEGORY_EMOJI: Record<TechnologyCategory, string> = {
  cms: "🛒",
  framework: "🧩",
  "web-server": "🖥️",
  hosting: "☁️",
  cdn: "🌐",
  analytics: "📊",
  "tag-manager": "🏷️",
  "ad-network": "📣",
  payment: "💳",
  chat: "💬",
  security: "🔒",
  font: "🔤",
  video: "🎬",
  widget: "🪟",
  other: "📦",
};

export interface TechGroup {
  category: TechnologyCategory;
  label: string;
  emoji: string;
  items: ReportTechnology[];
}

function labelFor(category: string): string {
  return CATEGORY_LABEL[category as TechnologyCategory] ?? "Other";
}
function emojiFor(category: string): string {
  return CATEGORY_EMOJI[category as TechnologyCategory] ?? "📦";
}

/** Group technologies by category in display order, items sorted by name. */
export function groupTechnologies(items: ReportTechnology[]): TechGroup[] {
  const byCat = new Map<string, ReportTechnology[]>();
  for (const t of items) {
    const arr = byCat.get(t.category) ?? [];
    arr.push(t);
    byCat.set(t.category, arr);
  }
  const orderIndex = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c as TechnologyCategory);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  return [...byCat.entries()]
    .sort(([a], [b]) => orderIndex(a) - orderIndex(b) || (a < b ? -1 : 1))
    .map(([category, arr]) => ({
      category: category as TechnologyCategory,
      label: labelFor(category),
      emoji: emojiFor(category),
      items: arr.sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

/** A short one-line change summary, e.g. "2 added · 1 removed since last scan". */
export function techChangeSummary(tech: ReportTechnologies): string | null {
  if (tech.firstScan) return "First recorded scan of this domain";
  const parts: string[] = [];
  if (tech.added.length > 0) parts.push(`${tech.added.length} added`);
  if (tech.removed.length > 0) parts.push(`${tech.removed.length} removed`);
  if (parts.length === 0) return "No changes since last scan";
  return `${parts.join(" · ")} since last scan`;
}

/** Map techId → display name from the current item list (for added/removed). */
export function techNameMap(items: ReportTechnology[]): Map<string, string> {
  return new Map(items.map((t) => [t.id, t.name]));
}
