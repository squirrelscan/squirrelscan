// The extra bodies security/leaked-secrets reads (#362): same-origin source
// maps and config endpoints the fetched scripts reference. Which URLs, and the
// cap, come from the rules package (`planSecretSources`); this fetches them.
//
// Bounds, all of them hard:
// - at most SECRET_SOURCE_FETCH_LIMITS.MAX_FETCHES targets per audit;
// - one request per target: no retry after a network error, and a redirect is
//   the answer rather than a second request (so a same-origin URL can never
//   become a cross-origin one);
// - the asset phase's shared FetchBudget, so a spent budget or a tarpitting
//   host skips them before they are sent;
// - the script size cap per body, and the site's own egress policy.

import type { SecretSourceData } from "@squirrelscan/rules";

import {
  planSecretSources,
  type SecretSourceScript,
} from "@squirrelscan/rules";
import { SCRIPT_FETCH_LIMITS } from "@squirrelscan/utils/constants";
import { Effect } from "effect";

import {
  fetchScriptContents,
  type ScriptFetcherOptions,
} from "./script-fetcher";

export interface FetchedSecretSources {
  sources: SecretSourceData[];
  /** Distinct targets the cap left out, never requested. */
  dropped: number;
}

/**
 * Plan and fetch the leaked-secrets sources for `scripts` (the script rows the
 * rules read). `options` are the script fetcher's (budget, egress, headers,
 * timeout); this overrides everything that would let a target cost more than
 * one request or skip the caps.
 */
export function fetchSecretSources(
  scripts: readonly SecretSourceScript[],
  options: Partial<ScriptFetcherOptions>
): Effect.Effect<FetchedSecretSources, never, never> {
  const { targets, total } = planSecretSources(scripts);
  if (targets.length === 0)
    return Effect.succeed({ sources: [], dropped: total });
  const {
    contentCache: _contentCache,
    maxTotalBytes: _maxTotalBytes,
    totalTimeoutMs: _totalTimeoutMs,
    pageCount: _pageCount,
    ...shared
  } = options;
  return fetchScriptContents(
    targets.map((t) => t.url),
    {
      ...shared,
      anyContentType: true,
      fetchAll: true,
      maxScripts: targets.length,
      maxSizeBytes: SCRIPT_FETCH_LIMITS.MAX_SCRIPT_SIZE_BYTES,
      maxRetries: 0,
      followRedirects: false,
    }
  ).pipe(
    Effect.map((fetched) => {
      const byUrl = new Map(fetched.map((f) => [f.url, f]));
      const sources = targets.map((target): SecretSourceData => {
        const f = byUrl.get(target.url);
        return {
          kind: target.kind,
          url: target.url,
          referencedBy: target.referencedBy,
          sourcePages: target.sourcePages,
          status: f?.status ?? null,
          error: f?.error ?? null,
          contentType: f?.contentType ?? null,
          content: f?.content ?? null,
        };
      });
      return { sources, dropped: total - targets.length };
    })
  );
}
