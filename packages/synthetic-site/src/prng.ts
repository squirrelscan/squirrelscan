// Deterministic seeded PRNG. Never Date.now()/Math.random() — every call site
// in this package must thread a seed so the same seed reproduces byte-identical
// output (packages/synthetic-site's core determinism contract).

export type Rng = () => number;

/** mulberry32 — small, fast, good-enough distribution for synthetic fixtures. */
export function createRng(seed: number | string): Rng {
  // `>>> 0`/`| 0` here are 32-bit unsigned wraparound, not decimal truncation —
  // oxlint's prefer-math-trunc is a false positive on real bitwise hash code.
  // oxlint-disable-next-line unicorn/prefer-math-trunc
  let state = (typeof seed === "string" ? hashString32(seed) : seed) >>> 0;
  return function mulberry32(): number {
    // oxlint-disable-next-line unicorn/prefer-math-trunc
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    // oxlint-disable-next-line unicorn/prefer-math-trunc
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a — deterministic string → uint32. Also used for stable fingerprints/hashes. */
export function hashString32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // oxlint-disable-next-line unicorn/prefer-math-trunc
  return hash >>> 0;
}

/** hashString32 as zero-padded 8-char hex, for readable stable fingerprints. */
export function hashStringHex(str: string): string {
  return hashString32(str).toString(16).padStart(8, "0");
}

/** Derive a fresh, independent seed string from a parent seed + a discriminator. */
export function deriveSeed(seed: number | string, discriminator: string): string {
  return `${seed}:${discriminator}`;
}

export function rngInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function rngFloat(rng: Rng, min: number, max: number): number {
  return rng() * (max - min) + min;
}

export function rngPick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error("rngPick: items must be non-empty");
  }
  return items[Math.floor(rng() * items.length)] as T;
}

/**
 * Like {@link rngPick}, but a HARD guarantee: never returns `exclude` (unless
 * `items` contains nothing else, in which case it returns `exclude` — the
 * only way to satisfy both "non-empty result" and "never self" with no other
 * candidates). O(items.length) — a real filter+pick, not a probabilistic
 * re-roll — appropriate for call sites where `items` isn't the 25k-wide
 * shared bucket `pickFewExcluding` exists to avoid re-scanning per pick.
 */
export function pickExcluding<T>(rng: Rng, items: readonly T[], exclude: T): T {
  const candidates = items.filter((item) => item !== exclude);
  return candidates.length > 0 ? rngPick(rng, candidates) : exclude;
}

/** Fisher-Yates shuffle, deterministic given rng. Mutates and returns `items`. */
export function shuffleInPlace<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return items;
}

/** Pick `count` distinct indices from [0, poolSize), deterministic, order-preserving. */
export function pickIndices(rng: Rng, poolSize: number, count: number): number[] {
  const bounded = Math.max(0, Math.min(count, poolSize));
  const pool = Array.from({ length: poolSize }, (_, i) => i);
  shuffleInPlace(rng, pool);
  return pool.slice(0, bounded).sort((a, b) => a - b);
}

/** Pick `count` distinct elements from an arbitrary candidate list, deterministic. */
export function pickSubset<T>(rng: Rng, items: readonly T[], count: number): T[] {
  const bounded = Math.max(0, Math.min(count, items.length));
  const pool = [...items];
  shuffleInPlace(rng, pool);
  return pool.slice(0, bounded);
}

/**
 * Pick up to `count` distinct elements from `pool` (a `number[]` of indices),
 * excluding `exclude`, in O(count) — independent of `pool.length`. Mutates
 * `pool` in place via a *partial* Fisher-Yates over just its first
 * `count + 1` positions (never a full shuffle), so this is safe/cheap to
 * call once per item against a large SHARED bucket array (e.g. once per page
 * against its template's sibling bucket at 25k-page scale) without the O(n)
 * cost `pickSubset`/`pickIndices` would pay on every call.
 */
export function pickFewExcluding(
  rng: Rng,
  pool: number[],
  exclude: number,
  count: number,
): number[] {
  if (pool.length === 0 || count <= 0) return [];
  // +1 buffer: if `exclude` lands in the shuffled window, filtering it out
  // still leaves `count` picks (as long as the pool has room for one extra).
  const window = Math.min(count + 1, pool.length);
  for (let k = 0; k < window; k++) {
    const j = k + Math.floor(rng() * (pool.length - k));
    const tmp = pool[k]!;
    pool[k] = pool[j]!;
    pool[j] = tmp;
  }
  const picked = pool.slice(0, window).filter((v) => v !== exclude);
  return picked.slice(0, count);
}
