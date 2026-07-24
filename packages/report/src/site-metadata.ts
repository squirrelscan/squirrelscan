// Shared presentation helpers for rendering the report-only "Site profile"
// section across all output formats. The resolved site metadata is
// informational — it NEVER affects the score (mirrors technologies.ts).

import type { ContactPoint, SiteMetadata } from "./types";

/** Stable key per profile row. Each renderer maps it to its own icon —
 * react-icons (Phosphor) in the HTML report + dashboard, plain labels in the
 * text/markdown/console outputs (no emoji). */
export type SiteProfileRowKey =
  | "type"
  | "audience"
  | "identity"
  | "contacts"
  | "socials"
  | "domain";

/** Well-known acronyms / mixed-case forms that plain title-casing would mangle
 * (e.g. "smb_local" → "Smb local"). Keyed by lowercased token. */
const ENUM_WORD_LABELS: Record<string, string> = {
  smb: "SMB",
  saas: "SaaS",
  b2b: "B2B",
  b2c: "B2C",
  seo: "SEO",
  cms: "CMS",
  api: "API",
  ai: "AI",
  faq: "FAQ",
};

/** Humanize a snake_case enum value, e.g. "smb_local" → "SMB Local". */
function humanizeEnum(value: string): string {
  return value
    .replace(/_/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(
      (word) => ENUM_WORD_LABELS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

/** Site type, humanized (e.g. "Ecommerce", "Smb local"). */
export function formatSiteType(meta: SiteMetadata): string {
  return humanizeEnum(meta.siteType);
}

/** Business category, humanized, or null when absent. */
export function formatBusinessCategory(meta: SiteMetadata): string | null {
  if (!meta.businessCategory) return null;
  return humanizeEnum(meta.businessCategory);
}

/**
 * "Type" row value: site type with the business category appended when present,
 * e.g. "Smb local · Auto repair".
 */
export function formatTypeLine(meta: SiteMetadata): string {
  const cat = formatBusinessCategory(meta);
  const type = formatSiteType(meta);
  return cat ? `${type} · ${cat}` : type;
}

/** Audience scope, humanized, or null. */
export function formatAudienceScope(meta: SiteMetadata): string | null {
  if (!meta.audienceScope) return null;
  return humanizeEnum(meta.audienceScope);
}

/**
 * "Audience" row value: scope · country · languages, omitting empty parts,
 * e.g. "Local · US · en, fr". Returns null when nothing is known.
 */
export function formatAudienceLine(meta: SiteMetadata): string | null {
  const parts: string[] = [];
  const scope = formatAudienceScope(meta);
  if (scope) parts.push(scope);
  if (meta.primaryCountry) parts.push(meta.primaryCountry);
  if (meta.languages && meta.languages.length > 0) parts.push(meta.languages.join(", "));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * "Identity" row value: entity name with type in parens, e.g.
 * "Riverside Auto Care (organization)". Falls back to the site title. The
 * canonical URL (when present) is surfaced separately via `meta.entityUrl`.
 */
export function formatIdentityLine(meta: SiteMetadata): string | null {
  const name = meta.entityName ?? meta.title;
  if (!name) return null;
  const type = meta.entityType && meta.entityType !== "unknown" ? ` (${meta.entityType})` : "";
  return `${name}${type}`;
}

/** Display label for a single contact point, e.g. "+1 555-0100" or "Email: x@y". */
export function formatContact(contact: ContactPoint): string {
  return contact.label ? `${contact.label}: ${contact.value}` : contact.value;
}

/** "Contacts" row value: each contact value joined by " · ", or null. */
export function formatContactsLine(meta: SiteMetadata): string | null {
  if (!meta.contacts || meta.contacts.length === 0) return null;
  return meta.contacts.map(formatContact).join(" · ");
}

/** "Socials" row value: each platform (humanized), joined by " · ", or null. */
export function formatSocialsLine(meta: SiteMetadata): string | null {
  if (!meta.socials || meta.socials.length === 0) return null;
  return meta.socials.map((s) => humanizeEnum(s.platform)).join(" · ");
}

/** Whole-year domain age derived from `domainAgeDays` (or null when unknown). */
export function domainAgeYears(meta: SiteMetadata): number | null {
  if (meta.domainAgeDays == null || meta.domainAgeDays < 0) return null;
  return Math.floor(meta.domainAgeDays / 365);
}

/**
 * "Domain age" row value, e.g. "8 years (registered 2017-04-02)" or just
 * "registered 2017" when age is unknown. Returns null with no domain facts.
 */
export function formatDomainAgeLine(meta: SiteMetadata): string | null {
  const years = domainAgeYears(meta);
  const registeredDate = meta.registeredAt ? meta.registeredAt.slice(0, 10) : null;
  if (years != null) {
    const label = `${years} year${years === 1 ? "" : "s"}`;
    return registeredDate ? `${label} (registered ${registeredDate})` : label;
  }
  if (registeredDate) return `registered ${registeredDate}`;
  return null;
}

/** A single labelled row of the Site profile, ready for any renderer. */
export interface SiteProfileRow {
  /** Stable key; each renderer maps it to an icon. e.g. "type", "audience". */
  key: SiteProfileRowKey;
  /** Human label, e.g. "Type", "Domain age". */
  label: string;
  /** Rendered value string. */
  value: string;
  /** Optional canonical link for the row (currently identity → entityUrl). */
  url?: string;
}

/**
 * Build the ordered, non-empty rows of the Site profile for a resolved
 * `SiteMetadata`. Pure — no I/O. Rows with no value are omitted entirely so
 * every formatter renders the same compact set.
 */
export function siteProfileRows(meta: SiteMetadata): SiteProfileRow[] {
  const rows: SiteProfileRow[] = [];

  rows.push({ key: "type", label: "Type", value: formatTypeLine(meta) });

  const audience = formatAudienceLine(meta);
  if (audience) {
    rows.push({ key: "audience", label: "Audience", value: audience });
  }

  const identity = formatIdentityLine(meta);
  if (identity) {
    rows.push({
      key: "identity",
      label: "Identity",
      value: identity,
      ...(meta.entityUrl ? { url: meta.entityUrl } : {}),
    });
  }

  const contacts = formatContactsLine(meta);
  if (contacts) {
    rows.push({ key: "contacts", label: "Contacts", value: contacts });
  }

  const socials = formatSocialsLine(meta);
  if (socials) {
    rows.push({ key: "socials", label: "Socials", value: socials });
  }

  const domain = formatDomainAgeLine(meta);
  if (domain) {
    rows.push({ key: "domain", label: "Domain age", value: domain });
  }

  return rows;
}

/** The trust/EEAT flags worth surfacing as a one-line badge string, or null. */
export function siteProfileFlags(meta: SiteMetadata): string | null {
  const flags: string[] = [];
  if (meta.isYMYL) flags.push("YMYL");
  if (meta.isLocalBusiness) flags.push("Local business");
  if (meta.hasOwnershipVerified) flags.push("Ownership verified");
  return flags.length > 0 ? flags.join(" · ") : null;
}

/** Standard one-line note shown above the section in every format. */
export const SITE_PROFILE_NOTE = "Resolved site context — informational, not part of the score.";
