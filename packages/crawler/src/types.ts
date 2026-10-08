// Crawler-specific types (non-storage)

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
  /** Set when an absolute-URL include matched but allowedDomains refused its host. */
  vetoedInclude?: string;
}
