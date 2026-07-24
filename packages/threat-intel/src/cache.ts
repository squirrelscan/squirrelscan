// Daily-pull feed cache. Blocklists are pulled at most once per TTL window and
// shared across audit runs (KV in the cloud, in-memory locally), so we never
// spam provider APIs. The store is a tiny KV-shaped interface so the same code
// runs against a Cloudflare KV namespace or the bundled in-memory map.

/** Minimal KV contract — a structural subset of Cloudflare's KVNamespace. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Process-local KV used when no external store is supplied (CLI / tests). */
export class MemoryKvStore implements KvStore {
  private readonly map = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
  put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
}

interface CacheEnvelope<T> {
  fetchedAt: number;
  data: T;
}

const KEY_PREFIX = "threat-intel:feed:";

/**
 * Return cached `data` for `key` when it is younger than `ttlMs`, otherwise call
 * `refresh`, store the result stamped with `now`, and return it. A failed
 * refresh falls back to STALE cached data when any exists (feeds going down must
 * not blank the blocklist) and rethrows only when there is nothing cached.
 *
 * `now` is injected (no `Date.now()` in scripts/tests) and defaults to the live
 * clock for production callers.
 */
export async function getOrRefresh<T>(
  store: KvStore,
  key: string,
  ttlMs: number,
  refresh: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const cacheKey = `${KEY_PREFIX}${key}`;
  const raw = await store.get(cacheKey);
  let cached: CacheEnvelope<T> | null = null;
  if (raw) {
    try {
      cached = JSON.parse(raw) as CacheEnvelope<T>;
    } catch {
      cached = null;
    }
  }
  if (cached && now - cached.fetchedAt < ttlMs) {
    return cached.data;
  }

  try {
    const data = await refresh();
    const envelope: CacheEnvelope<T> = { fetchedAt: now, data };
    await store.put(cacheKey, JSON.stringify(envelope));
    return data;
  } catch (err) {
    if (cached) return cached.data; // serve stale rather than blank the blocklist
    throw err;
  }
}
