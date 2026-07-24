// On-demand lookups (Safe Browsing / urlscan / VirusTotal), memoized per run.
// Each distinct URL is queried at most once across all of a run's rules, and the
// candidate set is deduped up-front — so a 500-page crawl never fans out into
// thousands of provider calls.

import type { IntelSource, IntelUrlVerdict } from "@squirrelscan/core-contracts";

import { LOOKUP_PROVIDERS, isProviderEnabled } from "./providers";
import type { IntelConfig, IntelTransport } from "./types";
import { normalizeUrl } from "./url";

/**
 * Query every enabled lookup provider for each candidate URL, once. Returns a
 * verdict map keyed by the normalized URL. A provider that throws contributes no
 * sources for that URL (degrade, don't fail). When no lookup provider is enabled
 * the map is empty and callers fall back to feeds only.
 *
 * Concurrency is bounded so a large candidate set doesn't open hundreds of
 * sockets at once; within a URL the providers run in parallel.
 */
export async function runLookups(
  urls: string[],
  config: IntelConfig,
  deps: { transport: IntelTransport; concurrency?: number },
): Promise<Map<string, IntelUrlVerdict>> {
  const verdicts = new Map<string, IntelUrlVerdict>();

  const active = LOOKUP_PROVIDERS.filter((p) => isProviderEnabled(config.providers[p.id]));
  if (active.length === 0) return verdicts;

  // Dedupe candidates by normalized key — same resource queried once.
  const unique = new Map<string, string>(); // normalized → first raw url
  for (const url of urls) {
    const key = normalizeUrl(url);
    if (!unique.has(key)) unique.set(key, url);
  }

  const tasks = [...unique.entries()];
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const index = cursor++;
      const [key, rawUrl] = tasks[index]!;
      const sources: IntelSource[] = [];
      await Promise.all(
        active.map(async (provider) => {
          try {
            const hits = await provider.lookup(
              rawUrl,
              deps.transport,
              config.providers[provider.id] ?? {},
            );
            sources.push(...hits);
          } catch {
            // provider unavailable for this URL
          }
        }),
      );
      verdicts.set(key, {
        url: rawUrl,
        listed: sources.length > 0,
        checked: true,
        sources,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return verdicts;
}
