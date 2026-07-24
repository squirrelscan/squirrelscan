// Feed aggregation: daily-pull each enabled feed provider (through the cache),
// index the entries by normalized URL / registrable-domain / host, and answer
// synchronous membership queries against that snapshot.

import type { IntelProviderId, IntelSource } from "@squirrelscan/core-contracts";

import { getOrRefresh } from "./cache";
import type { KvStore } from "./cache";
import { FEED_PROVIDERS, isProviderEnabled } from "./providers";
import type { FeedEntry, FeedSnapshot, IntelConfig, IntelTransport } from "./types";
import { hostOf, normalizeUrl, registrableDomain } from "./url";

function emptySnapshot(): FeedSnapshot {
  return { urls: new Map(), domains: new Map(), hosts: new Map(), providers: [] };
}

function push(map: Map<string, IntelSource[]>, key: string, source: IntelSource): void {
  const existing = map.get(key);
  if (existing) existing.push(source);
  else map.set(key, [source]);
}

/** Index a provider's pulled entries into the running snapshot. */
function indexEntries(
  snapshot: FeedSnapshot,
  provider: IntelProviderId,
  entries: FeedEntry[],
): void {
  for (const entry of entries) {
    const source: IntelSource = {
      provider,
      matched: entry.kind,
      threat: entry.threat,
      reference: entry.reference,
    };
    if (entry.kind === "url") {
      push(snapshot.urls, normalizeUrl(entry.value), source);
    } else if (entry.kind === "domain") {
      // Index a domain IOC under the listed host VERBATIM (not collapsed to
      // eTLD+1): a feed listing `phish.shared-host.com` must flag that host and
      // its subdomains, NOT every sibling under `shared-host.com`. Subdomain
      // matching is done by the suffix walk in lookupInSnapshot.
      const dom = (hostOf(entry.value) ?? entry.value.toLowerCase()).replace(/\.$/, "");
      if (dom) push(snapshot.domains, dom, source);
    } else {
      const host = (hostOf(entry.value) ?? entry.value.toLowerCase()).replace(/\.$/, "");
      push(snapshot.hosts, host, source);
    }
  }
}

/**
 * Build the blocklist snapshot from all enabled feed providers. Each provider's
 * pull is cached for `config.feedTtlMs` (daily-pull) keyed by provider id, so
 * concurrent / repeated audits share one fetch. A provider that throws is
 * skipped — partial intel beats none. `now` is injected for deterministic tests.
 */
export async function refreshFeeds(
  config: IntelConfig,
  deps: { transport: IntelTransport; kv: KvStore; now?: number },
): Promise<FeedSnapshot> {
  const snapshot = emptySnapshot();
  const providers: IntelProviderId[] = [];

  for (const provider of FEED_PROVIDERS) {
    const pconfig = config.providers[provider.id];
    if (!isProviderEnabled(pconfig)) continue;
    try {
      const entries = await getOrRefresh(
        deps.kv,
        provider.id,
        config.feedTtlMs,
        () => provider.fetchFeed(deps.transport, pconfig ?? {}),
        deps.now,
      );
      indexEntries(snapshot, provider.id, entries);
      providers.push(provider.id);
    } catch {
      // Provider unavailable — skip; other feeds still contribute.
    }
  }

  snapshot.providers = providers;
  return snapshot;
}

/**
 * Synchronous membership check of one URL against a snapshot:
 *   1. exact normalized URL,
 *   2. exact host (host IOCs), and
 *   3. the listed domain or any of its parent labels down to — but not below —
 *      the URL's registrable domain (eTLD+1). So a listed `bad.tk` flags
 *      `www.bad.tk`, a listed `phish.legit.com` flags `a.phish.legit.com` but
 *      NOT `www.legit.com`, and no IOC ever collapses to a bare public suffix.
 * Returns the matched sources (deduped by provider) or `[]`.
 */
export function lookupInSnapshot(snapshot: FeedSnapshot, url: string): IntelSource[] {
  const out: IntelSource[] = [];
  const urlHit = snapshot.urls.get(normalizeUrl(url));
  if (urlHit) out.push(...urlHit);

  const host = hostOf(url);
  if (host) {
    const hostHit = snapshot.hosts.get(host);
    if (hostHit) out.push(...hostHit);

    // Walk host → parent → … → registrable domain (inclusive) against domains.
    const reg = registrableDomain(url);
    let h: string | undefined = host;
    while (h) {
      const domHit = snapshot.domains.get(h);
      if (domHit) out.push(...domHit);
      if (!reg || h === reg) break; // never go shorter than eTLD+1
      const dot = h.indexOf(".");
      h = dot === -1 ? undefined : h.slice(dot + 1);
      if (h && h.length < reg.length) break; // stepped past the registrable floor
    }
  }

  // Dedupe by provider+matched+reference so one feed listing both URL and domain
  // counts once.
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.provider}:${s.matched}:${s.reference ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
