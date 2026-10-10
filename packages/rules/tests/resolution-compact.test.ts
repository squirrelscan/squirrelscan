// The compact resolution signal (#2658): the #1185 signal deflated and indexed
// into a fixed byte budget shared with `pageStatuses`.
//
// Two properties carry the whole design, and each has its own block below:
//  - under the budget it decodes to exactly what `buildResolutionSignal` sends,
//    so the server merge cannot tell which shape a producer used;
//  - over it, everything it gives up degrades toward carrying a finding, never
//    toward resolving one: dropped keys are listed in `truncated`, and a clipped
//    page list says so (`crawledComplete: false`) and still counts every page.

import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";

import type { CheckResult, ResolutionSignal } from "@squirrelscan/core-contracts";
import {
  RESOLUTION_PUBLISH_LIMITS,
  RESOLUTION_SIGNAL_LIMITS,
} from "@squirrelscan/core-contracts/limits";
import {
  type CompactResolutionSignal,
  decodeResolutionSignal,
  resolutionCheckKey,
  resolutionUrlHash,
} from "@squirrelscan/core-contracts/resolution";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import {
  buildCompactResolutionSignal,
  buildPublishResolution,
  buildResolutionSignal,
} from "../src/resolution";

type Rules = Record<string, { checks: CheckResult[] }>;

const P1 = "https://x.test/";
const P2 = "https://x.test/about";
const P3 = "https://x.test/contact?ref=nav";
const P4 = "https://x.test/blog/";
const h = (url: string) => resolutionUrlHash(normalizePageUrl(url));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** A signal as sets, so two shapes compare on content rather than order. */
function asSets(signal: ResolutionSignal) {
  const sets = (record: Record<string, string[]> | undefined) =>
    Object.fromEntries(Object.entries(record ?? {}).map(([k, v]) => [k, new Set(v)]));
  return {
    crawled: new Set(signal.crawledUrls.map(normalizePageUrl)),
    failing: sets(signal.failing),
    notEvaluated: sets(signal.notEvaluated),
    truncated: new Set(signal.truncated ?? []),
  };
}

async function roundTrip(ruleResults: Rules, crawled: string[]) {
  const legacy = buildResolutionSignal(ruleResults, crawled)!;
  const compact = buildCompactResolutionSignal(ruleResults, crawled)!;
  const decoded = await decodeResolutionSignal(compact);
  return { legacy, compact, decoded };
}

// ── Synthetic crawls ─────────────────────────────────────────────────────
//
// URL text decides the signal's size (it is ~all of it once deflated), so these
// are calibrated against real crawls rather than the `/p/1, /p/2` lists that
// compress to nothing: "shop" deflates to ~10 bytes a page (a real 4,000-page
// shop: 9.6), "news" to ~37 (a real 10,000-page news archive: 35).

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) >>> 0;
    return s / 2 ** 32;
  };
}

const SYLLABLES = "ka lo mi ne ra su te vo zi bu da fe gi ho ju ly mo pi qu sa".split(" ");

function vocabulary(random: () => number, size: number): string[] {
  const words = new Set<string>();
  while (words.size < size) {
    let word = "";
    const n = 2 + Math.floor(random() * 3);
    for (let i = 0; i < n; i++) word += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
    words.add(word);
  }
  return [...words];
}

function shopUrls(count: number, seed = 1): string[] {
  const random = rng(seed);
  const words = vocabulary(random, 400);
  const sections = ["products", "collections", "pages", "blogs/news", "en-gb/products"];
  const urls = new Set<string>();
  while (urls.size < count) {
    const section = sections[Math.floor(random() * sections.length)];
    const slug = Array.from(
      { length: 2 + Math.floor(random() * 3) },
      () => words[Math.floor(random() * words.length)],
    ).join("-");
    const variant = random() < 0.1 ? `?variant=${4_000_000 + Math.floor(random() * 99_999)}` : "";
    urls.add(`https://shop.example.test/${section}/${slug}${variant}`);
  }
  return [...urls];
}

function newsUrls(count: number, seed = 2): string[] {
  const random = rng(seed);
  const words = vocabulary(random, 3000);
  const urls = new Set<string>();
  while (urls.size < count) {
    const month = 1 + Math.floor(random() * 12);
    const day = 1 + Math.floor(random() * 28);
    const id = 24_000_000 + Math.floor(random() * 999_999);
    const slug = Array.from(
      { length: 5 + Math.floor(random() * 6) },
      () => words[Math.floor(random() * words.length)],
    ).join("-");
    urls.add(`https://news.example.test/2024/${month}/${day}/${id}/${slug}`);
  }
  return [...urls];
}

/**
 * Rule results shaped like the real 50-page surface fixture (#2634): ~150 page
 * check classes, ~40 of them failing somewhere, at densities from a handful of
 * pages to nearly every page, plus one class a rule skipped on a few pages.
 * Per-page results arrive as folded aggregates (as they do past the fold cap),
 * chunked under the fold's page cap.
 */
function fixtureShapedResults(urls: string[], seed = 3): Rules {
  const random = rng(seed);
  const results: Rules = {};
  const aggregate = (name: string, status: "pass" | "fail" | "warn", pages: string[]) => {
    const out: CheckResult[] = [];
    for (let i = 0; i < pages.length; i += 1000) {
      const chunk = pages.slice(i, i + 1000);
      out.push({
        name,
        status,
        message: `${name} ${status}`,
        pages: chunk,
        details: { aggregated: true, occurrences: chunk.length },
      });
    }
    return out;
  };
  for (let r = 0; r < 150; r++) {
    const ruleId = `rule-${r}`;
    const checks: CheckResult[] = [];
    const density = r < 40 ? [0.01, 0.05, 0.2, 0.5, 0.9, 0.99][r % 6]! : 0;
    const failing: string[] = [];
    const passing: string[] = [];
    for (const url of urls) (random() < density ? failing : passing).push(url);
    if (failing.length > 0) checks.push(...aggregate("check", r % 2 ? "warn" : "fail", failing));
    if (r === 45) {
      // A rule that could not evaluate some pages (no timing data, say).
      const skipped = passing.splice(0, Math.min(25, passing.length));
      for (const url of skipped) {
        checks.push({ name: "check", status: "skipped", message: "no data", pageUrl: url });
      }
    }
    if (passing.length > 0) checks.push(...aggregate("check", "pass", passing));
    results[ruleId] = { checks };
  }
  return results;
}

describe("under the budget it carries exactly the original signal", () => {
  test("per-page, aggregated, skipped, noindex and query-string pages", async () => {
    const ruleResults: Rules = {
      "meta-description": {
        checks: [
          { name: "has-meta", status: "fail", message: "missing", pageUrl: P2 },
          { name: "has-meta", status: "warn", message: "short", pageUrl: P3 },
          { name: "has-meta", status: "pass", message: "ok", pageUrl: P1 },
          { name: "meta-length", status: "pass", message: "ok", pageUrl: P1 },
        ],
      },
      "perf/ttfb": {
        checks: [
          { name: "ttfb", status: "pass", message: "ok", pageUrl: P1 },
          { name: "ttfb", status: "skipped", message: "no timing", pageUrl: P2 },
        ],
      },
      "images/alt": {
        checks: [
          {
            name: "alt",
            status: "fail",
            message: "missing",
            pages: [P1, P4],
            details: { aggregated: true, occurrences: 2 },
          },
          {
            name: "alt",
            status: "skipped",
            message: "noindex",
            skipReason: "noindex",
            pageUrl: P3,
          },
        ],
      },
      "links/broken": {
        checks: [
          {
            name: "broken",
            status: "fail",
            message: "broken",
            pages: [P2],
            details: { aggregated: true, occurrences: 40, pagesTruncated: 40 },
          },
        ],
      },
    };
    const crawled = [P1, P2, P3, P4, P1];
    const { legacy, decoded } = await roundTrip(ruleResults, crawled);
    expect(asSets(decoded)).toEqual(asSets(legacy));
    expect(decoded.crawledComplete).toBeUndefined();
    // The fixture exercises every map: a failing set, a not-evaluated complement,
    // and a key the fold had already clipped.
    expect(decoded.notEvaluated?.[resolutionCheckKey("perf/ttfb", "ttfb")]).toEqual(
      expect.arrayContaining([h(P2)]),
    );
    expect(decoded.truncated).toEqual([resolutionCheckKey("links/broken", "broken")]);
  });

  test("a failing page the crawl never listed still rides along, as the original hashed it", async () => {
    const outside = "https://x.test/never-crawled";
    const ruleResults: Rules = {
      r: { checks: [{ name: "c", status: "fail", message: "m", pageUrl: outside }] },
    };
    const { legacy, decoded } = await roundTrip(ruleResults, [P1, P2]);
    expect(asSets(decoded)).toEqual(asSets(legacy));
    expect(decoded.failing[resolutionCheckKey("r", "c")]).toEqual([h(outside)]);
    expect(decoded.crawledUrls).not.toContain(normalizePageUrl(outside));
  });

  test("fixture-shaped crawls at 50 and 500 pages decode to the original signal", async () => {
    for (const pages of [50, 500]) {
      const urls = shopUrls(pages);
      const { legacy, decoded } = await roundTrip(fixtureShapedResults(urls), urls);
      expect(asSets(decoded)).toEqual(asSets(legacy));
    }
  });

  test("count caps clip at the same page as the original, hash collisions included", async () => {
    // Two crawled pages that share a 32-bit hash count once in the original's
    // hash sets. Ten checks failing everywhere then leave room under the
    // whole-signal cap for an eleventh, and the compact shape must agree.
    const byHash = new Map<string, number>();
    let pair: [number, number] | undefined;
    for (let i = 0; !pair; i++) {
      const hash = h(`https://x.test/p/${i}`);
      const seen = byHash.get(hash);
      if (seen === undefined) byHash.set(hash, i);
      else pair = [seen, i];
    }
    const cap = RESOLUTION_SIGNAL_LIMITS.maxHashesPerCheck;
    const urls = Array.from({ length: cap - 2 }, (_, i) => `https://x.test/q/${i}`);
    urls.push(`https://x.test/p/${pair[0]}`, `https://x.test/p/${pair[1]}`);
    const ruleResults: Rules = {};
    const failingEverywhere = RESOLUTION_SIGNAL_LIMITS.maxHashesTotal / cap;
    for (let r = 0; r < failingEverywhere; r++) {
      ruleResults[`wide-${r}`] = {
        checks: [
          { name: "c", status: "fail", message: "m", pages: urls, details: { aggregated: true } },
        ],
      };
    }
    ruleResults.narrow = {
      checks: [{ name: "c", status: "fail", message: "m", pageUrl: urls[0]! }],
    };
    const { legacy, decoded } = await roundTrip(ruleResults, urls);
    expect(legacy.truncated ?? []).not.toContain("narrow|c");
    expect(asSets(decoded)).toEqual(asSets(legacy));
  }, 60_000);

  test("same input, same bytes (the publish content hash must not churn)", () => {
    const urls = shopUrls(300);
    const results = fixtureShapedResults(urls);
    expect(buildCompactResolutionSignal(results, urls)).toEqual(
      buildCompactResolutionSignal(results, urls)!,
    );
  });

  test("nothing to signal → undefined, as before", () => {
    expect(buildCompactResolutionSignal({}, [])).toBeUndefined();
    expect(buildPublishResolution({}, [])).toEqual({});
  });
});

describe("the byte budget", () => {
  const budget = RESOLUTION_PUBLISH_LIMITS.maxBytes;

  test("2,800 and 10,000 fixture-shaped pages stay within it, signal plus pageStatuses", async () => {
    for (const [label, urls] of [
      ["shop", shopUrls(10_000)],
      ["news", newsUrls(10_000)],
    ] as const) {
      for (const pages of [2_800, 10_000]) {
        const crawl = urls.slice(0, pages);
        // One page in twenty a redirect or a 404, as on a site mid-migration.
        const reportPages = crawl.map((url, i) => ({
          url,
          statusCode: i % 20 === 0 ? (i % 40 === 0 ? 404 : 301) : 200,
        }));
        const out = buildPublishResolution(fixtureShapedResults(crawl), reportPages);
        const used = bytes(out.resolutionSignalCompact) + bytes(out.pageStatuses ?? []);
        expect(used).toBeLessThanOrEqual(budget);
        const decoded = await decodeResolutionSignal(out.resolutionSignalCompact!);
        if (label === "shop" || pages === 2_800) {
          // A typical site lists every page, with every key the count caps allow.
          expect(decoded.crawledComplete).toBeUndefined();
          expect(decoded.crawledUrls).toHaveLength(pages);
        } else {
          // 10,000 long news slugs do not fit: the list is clipped and says so,
          // but still counts every page.
          expect(decoded.crawledComplete).toBe(false);
          expect(decoded.crawledCount).toBe(pages);
          expect(decoded.crawledUrls.length).toBeGreaterThan(3_000);
        }
      }
    }
  }, 120_000);

  /**
   * What any over-budget signal must hold against the original built from the
   * same input: the listed pages are the crawl's first pages; a key it kept is
   * exact for those pages; a key it dropped is listed in `truncated`. Each loss
   * therefore reads as "no evidence" (carry), never as "crawled clean".
   */
  function expectSafeDegrade(urls: string[], legacy: ResolutionSignal, decoded: ResolutionSignal) {
    const listed = decoded.crawledUrls;
    expect(new Set(listed)).toEqual(new Set(urls.slice(0, listed.length).map(normalizePageUrl)));
    if (decoded.crawledComplete === false) expect(decoded.crawledCount).toBe(urls.length);
    else expect(listed).toHaveLength(urls.length);
    const listedHashes = new Set(listed.map((u) => resolutionUrlHash(u)));
    const onListed = (hashes: string[] | undefined) =>
      new Set((hashes ?? []).filter((hash) => listedHashes.has(hash)));
    const truncated = new Set(decoded.truncated ?? []);
    const legacyTruncated = new Set(legacy.truncated ?? []);
    for (const key of Object.keys(legacy.failing)) {
      if (!(key in decoded.failing)) {
        expect(truncated.has(key)).toBe(true);
        continue;
      }
      expect(new Set(decoded.failing[key])).toEqual(onListed(legacy.failing[key]));
      if (!truncated.has(key) && !legacyTruncated.has(key)) {
        expect(new Set(decoded.notEvaluated?.[key] ?? [])).toEqual(
          onListed(legacy.notEvaluated?.[key]),
        );
      }
    }
  }

  test("over budget, keys or pages give way, and only ever toward carrying", async () => {
    const urls = shopUrls(2_000);
    const results = fixtureShapedResults(urls);
    const legacy = buildResolutionSignal(results, urls)!;
    const whole = bytes(buildCompactResolutionSignal(results, urls));
    for (const budget of [whole - 2_000, Math.floor(whole / 2), Math.floor(whole / 4)]) {
      const signal = buildCompactResolutionSignal(results, urls, budget)!;
      expect(bytes(signal)).toBeLessThanOrEqual(budget);
      expectSafeDegrade(urls, legacy, await decodeResolutionSignal(signal));
    }
  });

  test("when the page list fits, the costliest keys go and the cheap ones stay", async () => {
    const urls = shopUrls(1_000);
    const random = rng(9);
    const results: Rules = {};
    for (let r = 0; r < 100; r++) {
      results[`clean-${r}`] = {
        checks: [
          { name: "c", status: "pass", message: "ok", pages: urls, details: { aggregated: true } },
        ],
      };
    }
    for (let r = 0; r < 20; r++) {
      // Failing on a random half of the pages: the most a page set can cost.
      const failing = urls.filter(() => random() < 0.5);
      const passing = urls.filter((url) => !failing.includes(url));
      results[`noisy-${r}`] = {
        checks: [
          {
            name: "c",
            status: "fail",
            message: "bad",
            pages: failing,
            details: { aggregated: true },
          },
          {
            name: "c",
            status: "pass",
            message: "ok",
            pages: passing,
            details: { aggregated: true },
          },
        ],
      };
    }
    const legacy = buildResolutionSignal(results, urls)!;
    const budget = bytes(buildCompactResolutionSignal(results, urls)) - 300;
    const signal = buildCompactResolutionSignal(results, urls, budget)!;
    expect(bytes(signal)).toBeLessThanOrEqual(budget);
    const decoded = await decodeResolutionSignal(signal);
    expectSafeDegrade(urls, legacy, decoded);
    expect(decoded.crawledComplete).toBeUndefined();
    const dropped = Object.keys(legacy.failing).filter((key) => !(key in decoded.failing));
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((key) => key.startsWith("noisy-"))).toBe(true);
  });

  test("a page list too big for the budget is clipped in crawl order and counts every page", async () => {
    const urls = newsUrls(3_000);
    const results = fixtureShapedResults(urls);
    const signal = buildCompactResolutionSignal(results, urls, 24 * 1024)!;
    expect(bytes(signal)).toBeLessThanOrEqual(24 * 1024);
    const decoded = await decodeResolutionSignal(signal);
    expect(decoded.crawledComplete).toBe(false);
    expect(decoded.crawledCount).toBe(3_000);
    expectSafeDegrade(urls, buildResolutionSignal(results, urls)!, decoded);
    // Nothing outside the list is named failing: the merge gives an unlisted
    // page no authority, so its evidence would be dead weight.
    const listedHashes = new Set(decoded.crawledUrls.map((u) => resolutionUrlHash(u)));
    for (const hashes of Object.values(decoded.failing)) {
      for (const hash of hashes) expect(listedHashes.has(hash)).toBe(true);
    }
    // ...and the listed pages keep their failing evidence, not just a URL list.
    expect(Object.values(decoded.failing).filter((hashes) => hashes.length > 0).length).toBe(40);
  });

  test("pageStatuses gets its own share, 404/410 first, and the signal the rest", () => {
    const urls = shopUrls(3_000);
    const pages = urls.map((url, i) => ({
      url,
      statusCode: i < 2_000 ? 301 : i % 2 ? 404 : 410,
    }));
    const out = buildPublishResolution(fixtureShapedResults(urls), pages);
    const statuses = out.pageStatuses!;
    expect(bytes(statuses)).toBeLessThanOrEqual(RESOLUTION_PUBLISH_LIMITS.maxPageStatusBytes);
    // All 1,000 removed pages do not fit either, but they lead the list.
    expect(statuses.every((s) => s.status === 404 || s.status === 410)).toBe(true);
    expect(bytes(out.resolutionSignalCompact) + bytes(statuses)).toBeLessThanOrEqual(
      RESOLUTION_PUBLISH_LIMITS.maxBytes,
    );
  });

  test("a healthy site's pageStatuses are untouched and in crawl order", () => {
    const urls = shopUrls(50);
    const pages = urls.map((url, i) => ({ url, statusCode: i === 7 ? 500 : i === 3 ? 404 : 200 }));
    expect(buildPublishResolution(fixtureShapedResults(urls), pages).pageStatuses).toEqual([
      { url: urls[3]!, status: 404 },
      { url: urls[7]!, status: 500 },
    ]);
  });
});

describe("decodeResolutionSignal refuses what it cannot bound", () => {
  const encode = (payload: unknown): CompactResolutionSignal => ({
    v: 1,
    data: deflateRawSync(Buffer.from(JSON.stringify(payload))).toString("base64"),
  });
  const ok = { v: 1, urls: [P1, P2], complete: true, pages: 2, failing: { "r|c": [1] } };

  test("a well-formed payload decodes", async () => {
    const decoded = await decodeResolutionSignal(encode(ok));
    expect(decoded.failing["r|c"]).toEqual([resolutionUrlHash(P2)]);
  });

  test.each([
    ["an index past the list", { ...ok, failing: { "r|c": [2] } }],
    ["a negative gap", { ...ok, failing: { "r|c": [-1] } }],
    ["a fractional gap", { ...ok, failing: { "r|c": [0.5] } }],
    ["a not-evaluated index into `other`", { ...ok, other: [P3], notEvaluated: { "r|c": [2] } }],
    ["fewer pages than listed", { ...ok, pages: 1 }],
    ["more pages than a crawl can have", { ...ok, complete: false, pages: 1e9 }],
    ["no failing map", { v: 1, urls: [P1], complete: true, pages: 1 }],
    ["a non-string url", { ...ok, urls: [P1, 7] }],
    ["an unknown version", { ...ok, v: 2 }],
    [
      "more keys than the signal allows",
      {
        ...ok,
        failing: Object.fromEntries(
          Array.from({ length: RESOLUTION_SIGNAL_LIMITS.maxChecks + 1 }, (_, i) => [`r|${i}`, []]),
        ),
      },
    ],
  ])("%s", async (_label, payload) => {
    await expect(decodeResolutionSignal(encode(payload))).rejects.toThrow();
  });

  test("a payload that inflates past the cap is refused without reading it all", async () => {
    // ~5 MiB of zeros deflates to a few KB: the shape of a decompression bomb.
    const bomb = deflateRawSync(Buffer.alloc(RESOLUTION_PUBLISH_LIMITS.maxInflatedBytes + 1024));
    expect(bomb.byteLength).toBeLessThan(16 * 1024);
    await expect(decodeResolutionSignal({ v: 1, data: bomb.toString("base64") })).rejects.toThrow(
      /inflates past/,
    );
  });

  test("garbage that is not deflate data is refused", async () => {
    await expect(decodeResolutionSignal({ v: 1, data: "bm90IGRlZmxhdGU=" })).rejects.toThrow();
  });
});
