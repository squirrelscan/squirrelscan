// Build the `IntelContext` handle threaded onto RuleContext. Two entry points:
//
//   buildIntelContext()  — SYNC, signatures-only (no network). The audit engine
//     calls this on every opted-in run so the kit-signature rule always works.
//   prefetchIntel()      — ASYNC, pulls daily-pull feeds + runs memoized lookups
//     for a candidate URL set, returning a ResolvedIntel that buildIntelContext
//     folds in so known-malicious-url can answer from feeds/providers.
//
// Keeping the feed/lookup resolution OUT of buildIntelContext is deliberate: all
// network happens up-front in the prefetch phase, so rules stay pure.

import type { IntelContext, IntelUrlVerdict } from "@squirrelscan/core-contracts";

import { MemoryKvStore } from "./cache";
import type { KvStore } from "./cache";
import { lookupInSnapshot, refreshFeeds } from "./feeds";
import { runLookups } from "./lookups";
import { LOOKUP_PROVIDERS, isProviderEnabled } from "./providers";
import { loadSignatures, matchSignatures } from "./signatures";
import type { Signature } from "./signatures";
import type { IntelConfig, IntelTransport, ResolvedIntel } from "./types";
import { normalizeUrl } from "./url";

/** Default transport over the global `fetch`, narrowed to what providers read. */
export const defaultTransport: IntelTransport = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
    json: () => res.json(),
  };
};

export interface BuildIntelOptions {
  /** Loaded signatures (defaults to the bundled set). */
  signatures?: Signature[];
  /** Resolved feeds + memoized lookups from `prefetchIntel`, if available. */
  resolved?: ResolvedIntel;
}

/**
 * Build the synchronous `IntelContext`. With no `resolved` data the signature
 * engine still works; URL lookups return `checked: false` (unknown) so rules
 * never treat the absence of feeds as "clean".
 */
export function buildIntelContext(opts: BuildIntelOptions = {}): IntelContext {
  const signatures = opts.signatures ?? loadSignatures();
  const resolved = opts.resolved;
  const feedsPresent = (resolved?.feeds.providers.length ?? 0) > 0;

  return {
    providers: resolved?.providers ?? [],
    signatureCount: signatures.length,
    lookupUrl(url): IntelUrlVerdict {
      const memo = resolved?.verdicts.get(normalizeUrl(url));
      const feedSources = resolved ? lookupInSnapshot(resolved.feeds, url) : [];
      const sources = [...(memo?.sources ?? []), ...feedSources];
      return {
        url,
        listed: sources.length > 0,
        checked: feedsPresent || (memo?.checked ?? false),
        sources,
      };
    },
    matchSignatures(input) {
      return matchSignatures(signatures, input);
    },
  };
}

export interface PrefetchIntelInput {
  /** Candidate URLs to lookup (site domain, finalUrls, external links). */
  urls: string[];
  transport?: IntelTransport;
  /** KV-backed feed cache; defaults to a process-local memory store. */
  kv?: KvStore;
  /** Injected clock for the feed cache TTL (tests). */
  now?: number;
  lookupConcurrency?: number;
}

/**
 * Resolve feeds + on-demand lookups for one audit run. Daily-pull feeds are
 * cached (shared across runs); lookups are deduped + memoized over the candidate
 * set. The result is folded into `buildIntelContext({ resolved })`.
 */
export async function prefetchIntel(
  config: IntelConfig,
  input: PrefetchIntelInput,
): Promise<ResolvedIntel> {
  const transport = input.transport ?? defaultTransport;
  const kv = input.kv ?? new MemoryKvStore();

  const feeds = await refreshFeeds(config, { transport, kv, now: input.now });
  const verdicts = await runLookups(input.urls, config, {
    transport,
    concurrency: input.lookupConcurrency,
  });

  const lookupIds = LOOKUP_PROVIDERS.filter((p) => isProviderEnabled(config.providers[p.id])).map(
    (p) => p.id,
  );
  const providers = [...new Set([...feeds.providers, ...lookupIds])];

  return { providers, feeds, verdicts };
}
