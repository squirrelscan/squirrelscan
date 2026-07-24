// Small deterministic word banks for generating readable-ish filler content.
// Kept intentionally boring — this is fixture content, not copy.

export const NOUNS = [
  "widget",
  "gadget",
  "sensor",
  "gizmo",
  "module",
  "bracket",
  "adapter",
  "cable",
  "mount",
  "panel",
  "battery",
  "charger",
  "case",
  "stand",
  "hub",
  "dock",
  "filter",
  "valve",
  "engine",
  "pump",
] as const;

export const ADJECTIVES = [
  "compact",
  "durable",
  "premium",
  "portable",
  "rugged",
  "wireless",
  "modular",
  "reliable",
  "efficient",
  "versatile",
  "lightweight",
  "industrial",
  "commercial",
  "affordable",
  "advanced",
] as const;

export const VERBS = [
  "improves",
  "supports",
  "extends",
  "simplifies",
  "protects",
  "powers",
  "connects",
  "streamlines",
  "reduces",
  "enables",
] as const;

export const TOPICS = [
  "installation",
  "maintenance",
  "performance",
  "compatibility",
  "durability",
  "efficiency",
  "reliability",
  "safety",
  "warranty",
  "shipping",
] as const;

export const CATEGORY_NAMES = [
  "outdoor",
  "industrial",
  "home",
  "office",
  "automotive",
  "marine",
  "electronics",
  "hardware",
  "tools",
  "accessories",
] as const;

export const BLOG_TOPICS = [
  "buying-guide",
  "how-to-install",
  "troubleshooting",
  "comparison",
  "maintenance-tips",
  "product-update",
  "case-study",
  "faq",
] as const;
