// Sticky per-project user-agent (#875)
//
// An empty `[crawler] user_agent` used to draw a fresh random UA every run.
// Sites serve UA-dependent markup (mobile themes, responsive server-side
// variants), so per-run UA churn shifted the served HTML and defeated every
// content-keyed cache at once: the conditional-render fingerprint (#839/#845),
// the server render cache (#193/#822), and the LLM page cache (#825).
//
// Fix: draw once per project and persist to project_meta; later runs reuse it.
// Explicit config still overrides, and `--fresh-ua` re-rolls (and re-persists).

import { Effect } from "effect";

import {
  getRandomUserAgent,
  isModernUserAgentString,
} from "@squirrelscan/utils/user-agent";

import type { CrawlStorage } from "./storage/types";

/** project_meta key holding the project's pinned random user-agent. */
export const USER_AGENT_META_KEY = "crawler_user_agent";

export interface StickyUserAgentResolution {
  userAgent: string;
  /** config = explicit override; sticky = reused pin; fresh = new draw (persisted) */
  source: "config" | "sticky" | "fresh";
}

/**
 * Resolve the crawl user-agent against the project store. An explicit config
 * value always wins and is never persisted. Otherwise the pinned UA from
 * project_meta is reused; when absent (first crawl), `freshUa` was passed, or
 * the pin no longer passes the modern-browser floor (#854 — the floor ratchets
 * up across releases), a new random UA is drawn and persisted.
 *
 * Storage failures never fail the crawl: reads fall back to a fresh draw and
 * the persist is best-effort.
 */
export function resolveStickyUserAgent(
  configValue: string,
  storage: CrawlStorage,
  options: { freshUa?: boolean } = {}
): Effect.Effect<StickyUserAgentResolution, never, never> {
  return Effect.gen(function* () {
    if (configValue !== "") {
      return { userAgent: configValue, source: "config" as const };
    }

    if (!options.freshUa) {
      const pinned = yield* storage
        .getProjectMeta(USER_AGENT_META_KEY)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (pinned && isModernUserAgentString(pinned)) {
        return { userAgent: pinned, source: "sticky" as const };
      }
    }

    const userAgent = getRandomUserAgent();
    yield* storage
      .setProjectMeta(USER_AGENT_META_KEY, userAgent)
      .pipe(Effect.catchAll(() => Effect.void));
    return { userAgent, source: "fresh" as const };
  });
}
