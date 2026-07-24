// Threat-intel wiring for the audit engine (#117). Resolves the opt-in `[intel]`
// config into a synchronous `IntelContext` (threaded onto `ctx.intel`) BEFORE
// rules run, so the integrity intel rules stay pure.
//
// Two modes:
//   localIntelContext()      — signatures-only, no network. Used by the rules
//     adapter as a zero-cost fallback so kit-signature works on every opted-in
//     audit (CLI + cloud).
//   buildFullIntelContext()  — async: ALSO daily-pulls feeds + runs memoized
//     lookups for the site's own URLs, so known-malicious-url can answer from
//     feeds/providers. Wired into the cloud-runner prefetch phase.

import type { Config } from "@squirrelscan/config";

import {
  buildIntelContext,
  prefetchIntel,
  type IntelConfig,
  type IntelContext,
  type KvStore,
  type ProviderConfig,
} from "@squirrelscan/threat-intel";

import type { SiteContextPage } from "./adapter";

/** Map the `[intel]` config section into the engine's structural IntelConfig. */
export function mapIntelConfig(config: Config): IntelConfig | null {
  const intel = config.intel;
  if (!intel?.enabled) return null;
  const providers: IntelConfig["providers"] = {};
  for (const [id, pc] of Object.entries(intel.providers ?? {})) {
    providers[id as keyof IntelConfig["providers"]] = {
      enabled: pc.enabled,
      apiKey: pc.api_key,
    } satisfies ProviderConfig;
  }
  return {
    enabled: true,
    feedTtlMs: (intel.feed_ttl_hours ?? 24) * 60 * 60 * 1000,
    providers,
  };
}

/** Candidate URLs for on-demand lookups — the site's own pages (not externals). */
export function collectIntelUrls(siteContext: SiteContextPage[], baseUrl?: string): string[] {
  const urls = new Set<string>();
  if (baseUrl) urls.add(baseUrl);
  for (const { page } of siteContext) {
    if (page.url) urls.add(page.url);
    if (page.finalUrl) urls.add(page.finalUrl);
  }
  return [...urls];
}

/** Signatures-only intel (synchronous, no network). */
export function localIntelContext(): IntelContext {
  return buildIntelContext();
}

/**
 * Full intel context: signatures + daily-pull feeds + memoized lookups for the
 * site's own URLs. Falls back to signatures-only when intel is disabled. A feed
 * pull / lookup that fails degrades gracefully inside the package (partial intel
 * beats none); callers should still wrap in try/catch for total safety.
 */
export async function buildFullIntelContext(
  config: Config,
  input: { siteContext: SiteContextPage[]; baseUrl?: string; kv?: KvStore },
): Promise<IntelContext> {
  const intelConfig = mapIntelConfig(config);
  if (!intelConfig) return buildIntelContext();
  const resolved = await prefetchIntel(intelConfig, {
    urls: collectIntelUrls(input.siteContext, input.baseUrl),
    kv: input.kv,
  });
  return buildIntelContext({ resolved });
}
