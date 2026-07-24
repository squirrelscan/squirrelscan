// Shared page-model core consumed by both HTTP mode (server.ts) and
// direct-storage mode (storage-writer.ts). Kept deliberately lightweight per
// page — no rendered HTML is ever held in the model — so a 25k-page model with
// ~1MB pages stays cheap in memory; HTML is rendered lazily per page on demand
// (html-render.ts) from each page's own deterministic seedTag.

export type IssueTag =
  | "long-h1"
  | "oversize-title"
  | "oversize-description"
  | "long-url"
  | "duplicate-title"
  | "duplicate-description"
  | "orphan"
  | "redirect-chain"
  | "broken-link"
  | "noindex-in-sitemap"
  | "clean";

export interface PageTemplate {
  id: string;
  label: string;
  /** Stable structural signature — same template ⇒ same fingerprint. */
  fingerprint: string;
}

export interface PageModel {
  /** Path only (no origin) — origin is supplied at render/serve time. */
  path: string;
  templateId: string;
  title: string;
  description: string;
  h1: string;
  wordCount: number;
  statusCode: number;
  /** Path of the redirect target, only set when statusCode is 3xx. */
  redirectTo?: string;
  noindex: boolean;
  inSitemap: boolean;
  /** Outgoing link hrefs (may be relative paths, absolute, or oversized query strings). */
  outgoingLinks: string[];
  /** Approximate rendered HTML size in bytes the renderer should pad toward. */
  targetSizeBytes: number;
  issues: IssueTag[];
  /** Per-page deterministic seed for lazy HTML body generation (order-independent). */
  seedTag: string;
}

export interface ResolvedSiteOptions {
  seed: string;
  pageCount: number;
  templateCount: number;
  minPageSizeBytes: number;
  maxPageSizeBytes: number;
  cleanRatio: number;
  issues: ResolvedIssueMixOptions;
}

export interface SiteModel {
  seed: string;
  pages: PageModel[];
  /** Paths included in sitemap.xml (subset of pages, includes orphans). */
  sitemapPaths: string[];
  templates: PageTemplate[];
  /** Actually-applied counts per issue tag, for test assertions. */
  issueSummary: Record<IssueTag, number>;
  options: ResolvedSiteOptions;
}

/** count and ratio are mutually exclusive; ratio is resolved against pageCount. */
export interface IssueSpec {
  count?: number;
  ratio?: number;
}

export interface DuplicateGroupSpec {
  groupCount?: number;
  groupSize?: number;
}

export interface RedirectChainSpec {
  count?: number;
  chainLength?: number;
}

export interface IssueMixOptions {
  longH1?: IssueSpec | false;
  oversizeTitle?: IssueSpec | false;
  oversizeDescription?: IssueSpec | false;
  longUrls?: IssueSpec | false;
  duplicateTitles?: DuplicateGroupSpec | false;
  duplicateDescriptions?: DuplicateGroupSpec | false;
  orphanPages?: IssueSpec | false;
  redirectChains?: RedirectChainSpec | false;
  brokenLinks?: IssueSpec | false;
  noindexInSitemap?: IssueSpec | false;
}

export interface ResolvedIssueMixOptions {
  longH1: { count: number };
  oversizeTitle: { count: number };
  oversizeDescription: { count: number };
  longUrls: { count: number };
  duplicateTitles: { groupCount: number; groupSize: number };
  duplicateDescriptions: { groupCount: number; groupSize: number };
  orphanPages: { count: number };
  redirectChains: { count: number; chainLength: number };
  brokenLinks: { count: number };
  noindexInSitemap: { count: number };
}

export interface GenerateSiteModelOptions {
  /** Required — same seed always produces an identical model (bit-for-bit). */
  seed: number | string;
  pageCount: number;
  /** Distinct structural page templates (home always uses template 0). Default 5. */
  templateCount?: number;
  /** Default ~30KB. */
  minPageSizeBytes?: number;
  /** Default ~80KB; raise up to ~1.25MB to mimic the activera incident class. */
  maxPageSizeBytes?: number;
  /** Fraction of pages left with zero injected issues. Default 0.5. */
  cleanRatio?: number;
  issues?: IssueMixOptions;
}
