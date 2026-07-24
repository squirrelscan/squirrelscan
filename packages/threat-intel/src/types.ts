// Internal threat-intel types: provider config, transports, feed/lookup shapes.
// Public consumer types (IntelContext, IntelUrlVerdict, SignatureMatch, …) live
// in @squirrelscan/core-contracts and are re-exported from the package index.

import type { IntelProviderId, IntelSource, IntelUrlVerdict } from "@squirrelscan/core-contracts";

/**
 * Minimal fetch transport. Defaults to the global `fetch`; tests inject a stub so
 * the feed/lookup layers are exercised without real network. Kept structural
 * (not the full DOM `fetch` type) so a stub only has to return what we read.
 */
export type IntelTransport = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/** Per-provider config — every provider is optional and behind its own key. */
export interface ProviderConfig {
  /** Explicit enable flag. A provider also activates when its `apiKey` is set. */
  enabled?: boolean;
  /** API key / token where the provider requires one. */
  apiKey?: string;
}

/**
 * Resolved threat-intel config. Mirrors the `[intel]` config section (see
 * @squirrelscan/config) but kept structural here so the package has no
 * dependency on the config schema.
 */
export interface IntelConfig {
  /** Master switch. When false, no intel context is built at all. */
  enabled: boolean;
  /** Feed/blocklist cache TTL in ms (daily-pull). */
  feedTtlMs: number;
  /** Per-provider config keyed by provider id. */
  providers: Partial<Record<IntelProviderId, ProviderConfig>>;
}

/** A provider that daily-pulls a blocklist of malicious URLs / domains. */
export interface FeedProvider {
  id: IntelProviderId;
  /** Pull the current blocklist. Returns the raw entries to index. */
  fetchFeed(transport: IntelTransport, config: ProviderConfig): Promise<FeedEntry[]>;
}

/** One entry in a pulled blocklist feed. */
export interface FeedEntry {
  /** The listed value — a full URL or a bare domain/host. */
  value: string;
  kind: "url" | "domain" | "host";
  threat?: string;
  reference?: string;
}

/** A provider queried on-demand per URL (memoized per run). */
export interface LookupProvider {
  id: IntelProviderId;
  /** Query the provider for one URL. Returns sources when flagged, [] when clean. */
  lookup(url: string, transport: IntelTransport, config: ProviderConfig): Promise<IntelSource[]>;
}

/** A point-in-time, fully-resolved view of feeds + lookups for one audit run. */
export interface ResolvedIntel {
  /** Providers actually consulted (configured + reachable). */
  providers: IntelProviderId[];
  /** Indexed blocklist snapshot from daily-pull feeds. */
  feeds: FeedSnapshot;
  /** Memoized on-demand verdicts keyed by the normalized URL. */
  verdicts: Map<string, IntelUrlVerdict>;
}

/** Indexed blocklist: O(1) membership over listed URLs / domains / hosts. */
export interface FeedSnapshot {
  urls: Map<string, IntelSource[]>;
  domains: Map<string, IntelSource[]>;
  hosts: Map<string, IntelSource[]>;
  /** Providers that contributed to this snapshot. */
  providers: IntelProviderId[];
}
