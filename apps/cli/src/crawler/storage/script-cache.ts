// The CLI's script cache for the engine's script fetcher (repo#1415).
// Keyed by hashContent(url) in the shared content store, replayed for 24 hours.
// The value is the engine's opaque JSON envelope (body plus the response
// metadata the rules read); the row keeps the script content type label. The
// store is shared by every audit on the machine, so without a ceiling a
// script at a stable URL (app.js, not app.[hash].js) would never be re-read.

import type { ScriptContentCache } from "@squirrelscan/audit-engine";

import {
  getGlobalContentStore,
  hashContent,
  type ContentStore,
} from "./content-store";

export const SCRIPT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function createScriptContentCache(
  getStore: () => ContentStore = getGlobalContentStore,
  now: () => number = Date.now
): ScriptContentCache {
  return {
    get(url) {
      const store = getStore();
      const key = hashContent(url);
      const meta = store.getMeta(key);
      if (meta === null || now() - meta.createdAt > SCRIPT_CACHE_MAX_AGE_MS)
        return null;
      return store.getString(key);
    },
    put(url, value) {
      getStore().putForKey(url, value, "application/javascript");
    },
  };
}
