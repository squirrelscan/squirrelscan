// Site-metadata cloud-service contracts: the durable, globally-cached per-domain
// "site profile" resolved at Stage 0 of the cloud pipeline (Gemini Flash + RDAP).
// Report-only / non-scoring. Dep-free plain TypeScript — the const arrays below
// serve BOTH as the TS union source AND the runtime enum (mirrors the
// TechnologyCategory / AiParsePageType pattern in this package). The API maps
// between the snake_case DB columns (domain_metadata) and these camelCase fields.

// ── Enums (const-array = type source + runtime enum) ────────────────

/** Coarse site classification — the root of the audit decision graph. */
export const SITE_TYPES = [
  "news",
  "blog",
  "personal",
  "portfolio",
  "ecommerce",
  "marketplace",
  "saas",
  "web_app",
  "corporate",
  "smb_local",
  "agency",
  "consulting",
  "docs",
  "knowledge_base",
  "education",
  "elearning",
  "forum_community",
  "social_network",
  "media_streaming",
  "nonprofit",
  "government",
  "healthcare_provider",
  "directory",
  "landing_page",
  "other",
] as const;
export type SiteType = (typeof SITE_TYPES)[number];

/**
 * Curated ~60 GMB-style business categories (single-level). Only meaningful for
 * sites with a real-world business/entity behind them; null for most blogs/docs.
 */
export const BUSINESS_CATEGORIES = [
  "legal",
  "accounting_finance",
  "insurance",
  "real_estate",
  "marketing_advertising",
  "consulting",
  "hr_staffing",
  "it_services",
  "design_creative",
  "architecture",
  "engineering",
  "healthcare_medical",
  "dental",
  "mental_health",
  "veterinary",
  "pharmacy",
  "fitness_gym",
  "beauty_salon",
  "spa_wellness",
  "restaurant",
  "cafe_bakery",
  "bar_nightlife",
  "catering",
  "hotel_lodging",
  "travel_tourism",
  "events_venue",
  "apparel_fashion",
  "electronics",
  "home_garden",
  "furniture",
  "grocery",
  "jewelry",
  "sporting_goods",
  "books_media",
  "toys_hobbies",
  "pet_supplies",
  "general_retail",
  "home_services",
  "construction_contractor",
  "cleaning",
  "landscaping",
  "moving_storage",
  "security_services",
  "automotive_sales",
  "auto_repair",
  "transportation_logistics",
  "software_technology",
  "telecommunications",
  "media_publishing",
  "entertainment_arts",
  "education_training",
  "gaming",
  "banking",
  "fintech",
  "manufacturing",
  "agriculture",
  "energy_utilities",
  "wholesale_distribution",
  "government_public",
  "nonprofit_charity",
  "religious",
  "community_social",
  "other",
] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

/** Geographic reach of the site's intended audience — drives jurisdiction rules. */
export const AUDIENCE_SCOPES = ["global", "national", "regional", "local"] as const;
export type AudienceScope = (typeof AUDIENCE_SCOPES)[number];

/** Recognized social platforms for social-presence validation. */
export const SOCIAL_PLATFORMS = [
  "x",
  "facebook",
  "instagram",
  "linkedin",
  "youtube",
  "tiktok",
  "github",
  "pinterest",
  "threads",
  "mastodon",
  "bluesky",
  "other",
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

// ── Sub-records (JSONB array members in domain_metadata) ────────────

/**
 * A contact endpoint surfaced from on-page signals ONLY (JSON-LD
 * Organization/LocalBusiness, og/twitter meta, visible links). The LLM may never
 * infer one — server-side post-validation drops any value not literally present
 * in the supplied page signals.
 */
export interface ContactPoint {
  kind: "email" | "phone" | "address";
  value: string;
  label?: string | null;
}

/** A detected social account (echoed from page links / sameAs, never inferred). */
export interface SocialAccount {
  platform: SocialPlatform;
  url: string;
  handle?: string | null;
}

// ── Core metadata record ────────────────────────────────────────────

/**
 * The resolved per-domain site profile. Mirrors the wide `domain_metadata` row
 * (camelCase here ↔ snake_case columns). Report-only — NEVER contributes to the
 * health score. `hasOwnershipVerified` is always false in v1 (owner verification
 * + editing land in Phase 2). Domain-age facts (`registeredAt`/`expiresAt`) come
 * from RDAP; `domainAgeDays` is recomputed at read time (never re-fetched).
 */
export interface SiteMetadata {
  siteType: SiteType;
  businessCategory?: BusinessCategory | null;
  /** ISO-3166 alpha-2 primary country (e.g. "US"), or null. */
  primaryCountry?: string | null;
  audienceScope?: AudienceScope | null;
  /** BCP-47 language codes present/declared on the site. */
  languages?: string[];
  /** Human-facing site title (publisher/brand). */
  title?: string | null;
  /** The organization or person behind the site (publisher/business identity). */
  entityName?: string | null;
  entityType?: "organization" | "person" | "unknown";
  entityUrl?: string | null;
  contacts?: ContactPoint[];
  socials?: SocialAccount[];
  /** Your-Money-or-Your-Life: triggers stricter EEAT / trust rules. */
  isYMYL: boolean;
  /** Has a physical-world location/NAP: gates local-business rules. */
  isLocalBusiness: boolean;
  /** Always false in v1 (Phase 2: DNS-TXT / meta-tag / file ownership proof). */
  hasOwnershipVerified: boolean;
  /** Below a threshold the metadata MUST NOT gate any downstream rules/services. */
  confidence: "high" | "medium" | "low";
  /** Short LLM explanation of the classification (for explainability). */
  rationale?: string | null;
  // ── Domain facts (RDAP — never fabricated) ──
  tld?: string | null;
  registrar?: string | null;
  /** ISO timestamp of domain registration (immortal — never re-fetched). */
  registeredAt?: string | null;
  /** ISO timestamp of domain expiry. */
  expiresAt?: string | null;
  /** Recomputed at read time from `registeredAt`; never persisted as truth. */
  domainAgeDays?: number | null;
  rdapStatus?: "ok" | "no_rdap" | "lookup_failed" | null;
  /** 'auto' = LLM/RDAP-resolved (shared cache); 'owner' = verified override (Phase 2). */
  source?: "auto" | "owner";
  /** ISO timestamp the domain was first profiled globally. */
  firstDetectedAt?: string;
  /** ISO timestamp of the most recent refresh of the shared row. */
  lastRefreshedAt?: string;
}

// ── Request / response contracts (CLI → API) ────────────────────────

/** One page's raw signals for metadata extraction. Caps applied server-side. */
export interface SiteMetadataPagePayload {
  url: string;
  title?: string;
  /** <meta name|property> → content (og/twitter/etc). */
  metaTags?: Record<string, string>;
  /** Raw JSON-LD script blocks (stringified). Server caps total bytes. */
  jsonLd?: string[];
  /** Visible on-page links — sole source for contacts/socials echoing. */
  visibleLinks?: { href: string; text?: string }[];
  /** Page-level lang attribute. */
  lang?: string;
  /** Declared hreflang locales. */
  hreflang?: string[];
}

export interface SiteMetadataRequest {
  auditId?: string;
  /** Optional registered website id (unused for keying — domain is the key). */
  websiteId?: string;
  /** Site base URL — its apex/host is the per-domain cache key. */
  url: string;
  /** Sampled pages (first entry SHOULD be the home page). */
  pages: SiteMetadataPagePayload[];
}

/** The resolved profile returned to the CLI (the persisted shared snapshot). */
export interface SiteMetadataResponse extends SiteMetadata {
  /**
   * True when the server served a fresh (<30-day) cached `auto` row at ZERO
   * credits via the staleness short-circuit (no charge). Consumers MUST treat a
   * cached hit as 0 spend — do not bill the per-audit credit cap for it.
   */
  cached?: boolean;
}
