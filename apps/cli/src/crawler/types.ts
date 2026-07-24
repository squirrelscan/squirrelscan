export type FrontierStatus =
  | "queued"
  | "fetching"
  | "done"
  | "skipped"
  | "failed";

export type FrontierSource = "seed" | "sitemap" | "discovered";

export interface FrontierEntry {
  url: string;
  normalizedUrl: string;
  depth: number;
  parentUrl?: string;
  status: FrontierStatus;
  source: FrontierSource;
  enqueuedAt: number;
  fetchedAt?: number;
  reason?: string;
}

export interface UrlNormalizationOptions {
  baseUrl: string;
  allowQueryParams: string[];
  dropQueryPrefixes: string[];
}

export interface ScopeOptions {
  baseUrl: string;
  include: string[];
  exclude: string[];
  allowedDomains?: string[]; // Multi-domain project support
}

export interface CrawlDecision {
  allowed: boolean;
  reason?: string;
}
