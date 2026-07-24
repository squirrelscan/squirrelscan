// cloaking-probe — integrity Phase 3 (#118): an opt-in, bounded differential
// fetch over SUSPICIOUS paths to detect cloaking.
//
// For each selected path the probe re-fetches it with the DEFAULT crawl UA
// (baseline) and with a Googlebot UA, and optionally once more with an appended
// query token. It then compares the responses (status + visible-text Jaccard) and
// records a verdict for the `integrity/cloaking` rule to read. "Material
// divergence" between the default-UA and googlebot-UA responses = UA cloaking; a
// material change when a query token is appended = token-gating.
//
// It runs in the rules phase of the audit (shared by the CLI + cloud adapters,
// like ./intel), NOT in the crawl loop — orphan selection needs the post-crawl
// inbound-link analysis that only exists once pages are parsed. OFF by default and
// capped to `maxPages` so it never multiplies crawl cost.

import { getPathname, normalizeUrl } from "@squirrelscan/utils/url";

import { DEFAULT_MAX_BODY_BYTES, readBodyCapped } from "./lib/capped-body-read";

import type { CloakingProbeData } from "@squirrelscan/core-contracts";

const DAY_MS = 86_400_000;

/** Max response bytes read per probe fetch — bounds memory on huge pages. */
const MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;

/**
 * Both-2xx text similarity below this (default UA vs googlebot UA) counts as UA
 * cloaking. Conservative: minor dynamic content keeps similarity well above it.
 */
export const UA_SIMILARITY_THRESHOLD = 0.6;

/** Both-2xx similarity below this (bare vs query-token) counts as token-gating. */
export const TOKEN_SIMILARITY_THRESHOLD = 0.5;

/** Query param appended to detect token-/query-gated responses. */
export const PROBE_QUERY_PARAM = "ss_cloak_probe";

export interface CloakingProbeOptions {
  /** Hard cap on probed paths. */
  maxPages: number;
  /** A sitemap lastmod within this many days counts as "recent". */
  recentDays: number;
  /** Also probe an appended query token (token-gating detection). */
  queryVariation: boolean;
  /** UA used for the cloaking comparison fetch. */
  googlebotUserAgent: string;
  /** UA used for the baseline fetch (the crawl's own UA). */
  defaultUserAgent: string;
  /** Custom request headers forwarded to every probe fetch (same as the crawl). */
  customHeaders?: Record<string, string>;
  /** Per-fetch timeout. Default 15s. */
  timeoutMs?: number;
  /** Concurrent probe paths. Default 3. */
  concurrency?: number;
  /** Injectable clock (ms epoch) for deterministic recency selection. */
  now?: number;
}

/** A crawled page distilled to just what suspicious-path selection needs. */
export interface CloakingCandidate {
  url: string;
  normalizedUrl: string;
  status: number;
  /** Sitemap lastmod (ISO/RFC date string) or null. */
  lastmod: string | null;
  /** Inbound internal links pointing at this page. */
  inboundCount: number;
  /** Whether the page appears in any sitemap. */
  inSitemap: boolean;
}

export interface SelectedProbe {
  url: string;
  reason: CloakingProbeData["reason"];
}

/** A single probe fetch outcome. status 0 = network error (inconclusive). */
export interface ProbeResponse {
  status: number;
  body: string;
  error?: string;
}

export type ProbeFetch = (
  url: string,
  userAgent: string,
  headers?: Record<string, string>,
) => Promise<ProbeResponse>;

// ── selection ───────────────────────────────────────────────────────

/** Parse a lastmod string to ms epoch, or null if absent/unparseable. */
export function parseLastmod(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Pick the suspicious paths to probe: orphan pages (no inbound links AND absent
 * from the sitemap — same heuristic as integrity/orphan-page) and recently
 * modified pages (sitemap lastmod within `recentDays`). Orphans rank first (the
 * stronger compromise signal), then most-recently-modified. Capped at `maxPages`.
 */
export function selectSuspiciousPaths(
  candidates: CloakingCandidate[],
  opts: { maxPages: number; recentDays: number; hasSitemap: boolean; now: number },
): SelectedProbe[] {
  const orphans: SelectedProbe[] = [];
  const recent: { probe: SelectedProbe; lastmodMs: number }[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    // Only probe pages the crawler successfully fetched.
    if (c.status < 200 || c.status >= 300) continue;
    if (seen.has(c.normalizedUrl)) continue;

    // Orphan: no inbound links AND (not in sitemap, when a sitemap exists). With
    // no sitemap at all, absence is meaningless → zero inbound links alone.
    const isOrphan = c.inboundCount === 0 && (opts.hasSitemap ? !c.inSitemap : true);

    const lastmodMs = parseLastmod(c.lastmod);
    const isRecent =
      lastmodMs !== null &&
      lastmodMs <= opts.now &&
      opts.now - lastmodMs <= opts.recentDays * DAY_MS;

    if (!isOrphan && !isRecent) continue;
    seen.add(c.normalizedUrl);

    if (isOrphan) {
      orphans.push({ url: c.url, reason: "orphan" });
    } else {
      // lastmodMs is non-null here: isRecent requires it.
      recent.push({ probe: { url: c.url, reason: "recent-lastmod" }, lastmodMs: lastmodMs! });
    }
  }

  recent.sort((a, b) => b.lastmodMs - a.lastmodMs);
  return [...orphans, ...recent.map((r) => r.probe)].slice(0, Math.max(0, opts.maxPages));
}

// ── comparison ──────────────────────────────────────────────────────

/** Strip markup + script/style and return the set of visible-text tokens. */
export function visibleTokens(html: string): Set<string> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .toLowerCase();
  const set = new Set<string>();
  for (const t of text.split(/[^a-z0-9]+/)) {
    if (t.length > 1) set.add(t);
  }
  return set;
}

/** Jaccard similarity of two token sets (1 when both empty). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Decide whether `variant` materially diverges from `base`. A network error on
 * either side (status 0) is inconclusive, never divergent. A 2xx-vs-non-2xx flip
 * (one serves content, the other blocks/404s) is the strongest signal. When both
 * are 2xx, compare visible text against `threshold`.
 */
export function classifyDivergence(
  base: ProbeResponse,
  variant: ProbeResponse,
  threshold: number,
): { similarity: number; divergent: boolean } {
  if (base.status === 0 || variant.status === 0) return { similarity: 1, divergent: false };

  const baseOk = base.status >= 200 && base.status < 300;
  const varOk = variant.status >= 200 && variant.status < 300;
  if (baseOk !== varOk) return { similarity: 0, divergent: true };
  if (!baseOk && !varOk) return { similarity: 1, divergent: false };

  const sim = jaccard(visibleTokens(base.body), visibleTokens(variant.body));
  return { similarity: Math.round(sim * 1000) / 1000, divergent: sim < threshold };
}

/** Append the probe token to a URL (query-gating detection). */
export function appendProbeToken(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(PROBE_QUERY_PARAM, "1");
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${PROBE_QUERY_PARAM}=1`;
  }
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ── orchestration ───────────────────────────────────────────────────

function defaultProbeFetch(timeoutMs: number): ProbeFetch {
  return async (url, userAgent, headers) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...headers,
        },
        redirect: "follow",
        signal: controller.signal,
      });
      let body = "";
      try {
        body = await readBodyCapped(res, MAX_BODY_BYTES);
      } catch {
        /* body read failed — keep status, treat as empty body */
      }
      return { status: res.status, body };
    } catch (e) {
      return { status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function probeOne(
  sel: SelectedProbe,
  opts: CloakingProbeOptions,
  fetchImpl: ProbeFetch,
): Promise<CloakingProbeData> {
  const errors: string[] = [];
  const note = (label: string, res: ProbeResponse) => {
    if (res.error) errors.push(`${label}: ${res.error}`);
  };

  const def = await fetchImpl(sel.url, opts.defaultUserAgent, opts.customHeaders);
  note("default", def);
  const gb = await fetchImpl(sel.url, opts.googlebotUserAgent, opts.customHeaders);
  note("googlebot", gb);

  const ua = classifyDivergence(def, gb, UA_SIMILARITY_THRESHOLD);

  let queryUrl: string | null = null;
  let queryStatus: number | null = null;
  let queryBytes: number | null = null;
  let querySimilarity: number | null = null;
  let tokenGated = false;

  if (opts.queryVariation) {
    queryUrl = appendProbeToken(sel.url);
    const q = await fetchImpl(queryUrl, opts.defaultUserAgent, opts.customHeaders);
    note("query", q);
    queryStatus = q.status;
    queryBytes = byteLen(q.body);
    const tok = classifyDivergence(def, q, TOKEN_SIMILARITY_THRESHOLD);
    querySimilarity = tok.similarity;
    tokenGated = tok.divergent;
  }

  return {
    url: sel.url,
    reason: sel.reason,
    defaultStatus: def.status,
    defaultBytes: byteLen(def.body),
    googlebotStatus: gb.status,
    googlebotBytes: byteLen(gb.body),
    uaSimilarity: ua.similarity,
    uaCloaking: ua.divergent,
    queryUrl,
    queryStatus,
    queryBytes,
    querySimilarity,
    tokenGated,
    error: errors.length ? errors.join("; ") : null,
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Run the differential probe over already-selected paths. */
export function runCloakingProbe(
  selected: SelectedProbe[],
  opts: CloakingProbeOptions,
  fetchImpl: ProbeFetch = defaultProbeFetch(opts.timeoutMs ?? 15_000),
): Promise<CloakingProbeData[]> {
  const limited = selected.slice(0, Math.max(0, opts.maxPages));
  return mapPool(limited, opts.concurrency ?? 3, (sel) => probeOne(sel, opts, fetchImpl));
}

// ── adapter entry point ─────────────────────────────────────────────

/** A crawled page reduced to what the probe needs (provided by the adapter). */
export interface CloakingProbePage {
  url: string;
  statusCode: number;
  parsed: { links: { url: string | null; isInternal: boolean }[] };
}

export interface CloakingProbeSiteInput {
  baseUrl: string;
  pages: CloakingProbePage[];
  /** Flat list of sitemap URLs (loc + optional lastmod). */
  sitemapUrls: { loc: string; lastmod?: string }[];
}

/**
 * Adapter entry point: assemble candidates from parsed pages + sitemap data
 * (mirroring integrity/orphan-page's inbound + sitemap logic), select suspicious
 * paths, and run the probe. Returns the probe array (possibly empty when nothing
 * is suspicious). Both audit adapters call this — keep the per-adapter wiring to
 * one line so the CLI/cloud paths can't drift.
 */
export function probeSiteForCloaking(
  input: CloakingProbeSiteInput,
  opts: CloakingProbeOptions,
  fetchImpl?: ProbeFetch,
): Promise<CloakingProbeData[]> {
  const sitemapSet = new Set<string>();
  const lastmodMap = new Map<string, string>();
  for (const u of input.sitemapUrls) {
    const n = normalizeUrl(u.loc);
    sitemapSet.add(n);
    if (u.lastmod) lastmodMap.set(n, u.lastmod);
  }
  const hasSitemap = sitemapSet.size > 0;

  // Inbound internal-link counts (normalized target → count).
  const inbound = new Map<string, number>();
  for (const p of input.pages) inbound.set(normalizeUrl(p.url), 0);
  for (const p of input.pages) {
    for (const link of p.parsed.links) {
      if (!link.isInternal || !link.url) continue;
      try {
        const target = normalizeUrl(new URL(link.url, p.url).href);
        if (inbound.has(target)) inbound.set(target, (inbound.get(target) ?? 0) + 1);
      } catch {
        /* ignore unparsable link */
      }
    }
  }

  const normalizedBase = input.baseUrl ? normalizeUrl(input.baseUrl) : "";
  const candidates: CloakingCandidate[] = [];
  for (const p of input.pages) {
    const n = normalizeUrl(p.url);
    if (n === normalizedBase || getPathname(p.url) === "/") continue; // never the homepage
    candidates.push({
      url: p.url,
      normalizedUrl: n,
      status: p.statusCode,
      lastmod: lastmodMap.get(n) ?? null,
      inboundCount: inbound.get(n) ?? 0,
      inSitemap: sitemapSet.has(n),
    });
  }

  const selected = selectSuspiciousPaths(candidates, {
    maxPages: opts.maxPages,
    recentDays: opts.recentDays,
    hasSitemap,
    now: opts.now ?? Date.now(),
  });

  return runCloakingProbe(selected, opts, fetchImpl);
}

/** The opt-in `[integrity.cloaking_probe]` config block (snake_case, from TOML). */
export interface CloakingProbeToggle {
  enabled: boolean;
  max_pages: number;
  recent_days: number;
  query_variation: boolean;
  googlebot_user_agent: string;
}

/**
 * Single entry point both audit adapters call. Returns `undefined` when the probe
 * is off (so the rule no-ops), an array of results otherwise. Never throws — a
 * failure degrades to an empty array (probe is best-effort, must not break the
 * audit).
 */
export async function resolveCloakingProbes(
  cfg: CloakingProbeToggle | undefined,
  site: CloakingProbeSiteInput,
  runtime: { defaultUserAgent: string; customHeaders?: Record<string, string> },
  fetchImpl?: ProbeFetch,
): Promise<CloakingProbeData[] | undefined> {
  if (!cfg?.enabled) return undefined;
  try {
    return await probeSiteForCloaking(
      site,
      {
        maxPages: cfg.max_pages,
        recentDays: cfg.recent_days,
        queryVariation: cfg.query_variation,
        googlebotUserAgent: cfg.googlebot_user_agent,
        defaultUserAgent: runtime.defaultUserAgent,
        customHeaders: runtime.customHeaders,
      },
      fetchImpl,
    );
  } catch {
    return [];
  }
}
