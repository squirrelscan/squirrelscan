// buildResolutionSignal (#1185) — the unsampled publish resolution signal.
// Built from PRE-sample rule results; every bound must degrade to "no signal"
// (absent key) or "non-authoritative" (truncated marker), never to a shape the
// server could mis-read as "crawled clean".

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { RESOLUTION_SIGNAL_LIMITS } from "@squirrelscan/core-contracts/limits";
import { resolutionCheckKey, resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { normalizeUrl } from "@squirrelscan/utils/url";

import { buildResolutionSignal } from "../src/resolution";

const P1 = "https://x.test/";
const P2 = "https://x.test/about";
const P3 = "https://x.test/contact";

const h = (url: string) => resolutionUrlHash(normalizeUrl(url));

function rules(checks: CheckResult[], ruleId = "meta-description") {
  return { [ruleId]: { checks } };
}

describe("resolutionUrlHash", () => {
  test("golden values — the algorithm must not drift silently", () => {
    // Producer (CLI/container) and consumer (API Worker) share this exact
    // implementation; a change re-keys every in-flight signal, so pin it.
    expect(resolutionUrlHash("https://x.test/")).toBe("9ca81ead");
    expect(resolutionUrlHash("https://x.test/about")).toBe("377b9086");
    expect(resolutionUrlHash("")).toBe("811c9dc5"); // FNV-1a 32 offset basis
  });

  test("8 lowercase hex chars, deterministic", () => {
    for (const url of [P1, P2, P3, "https://example.com/日本語/ページ"]) {
      const a = resolutionUrlHash(url);
      expect(a).toMatch(/^[0-9a-f]{8}$/);
      expect(resolutionUrlHash(url)).toBe(a);
    }
  });
});

describe("buildResolutionSignal", () => {
  test("per-page fail/warn checks hash their pageUrl; pass classes emit an EMPTY key", () => {
    const signal = buildResolutionSignal(
      rules([
        { name: "has-meta", status: "fail", message: "missing", pageUrl: P2 },
        { name: "has-meta", status: "warn", message: "short", pageUrl: P3 },
        { name: "has-meta", status: "pass", message: "ok", pageUrl: P1 },
        { name: "meta-length", status: "pass", message: "ok", pageUrl: P1 },
      ]),
      [P1, P2, P3],
    )!;

    expect(signal.crawledUrls).toEqual([P1, P2, P3]);
    expect(new Set(signal.failing[resolutionCheckKey("meta-description", "has-meta")])).toEqual(
      new Set([h(P2), h(P3)]),
    );
    // All-pass class: key emitted (proves the check RAN) with zero hashes, so
    // the server may resolve — key ABSENCE must never be produced for a class
    // that evaluated pages this run.
    expect(signal.failing[resolutionCheckKey("meta-description", "meta-length")]).toEqual([]);
    expect(signal.truncated).toBeUndefined();
  });

  test("hashes are computed over the NORMALIZED url (matches server-side finding keys)", () => {
    const denormalized = "https://x.test/about/"; // normalizeUrl strips/normalizes
    const signal = buildResolutionSignal(
      rules([{ name: "has-meta", status: "fail", message: "m", pageUrl: denormalized }]),
      [denormalized],
    )!;
    expect(signal.failing[resolutionCheckKey("meta-description", "has-meta")]).toEqual([
      resolutionUrlHash(normalizeUrl(denormalized)),
    ]);
  });

  test("folded aggregates contribute their full pages[]", () => {
    const signal = buildResolutionSignal(
      rules([
        {
          name: "has-meta",
          status: "fail",
          message: "missing (+2 more pages)",
          pages: [P1, P2, P3],
          details: { aggregated: true, occurrences: 3 },
        },
      ]),
      [P1, P2, P3],
    )!;
    expect(new Set(signal.failing[resolutionCheckKey("meta-description", "has-meta")])).toEqual(
      new Set([h(P1), h(P2), h(P3)]),
    );
  });

  test("a fold-clipped aggregate (pagesTruncated > pages.length) marks the key truncated", () => {
    const signal = buildResolutionSignal(
      rules([
        {
          name: "has-meta",
          status: "fail",
          message: "missing",
          pages: [P1, P2],
          details: { aggregated: true, occurrences: 900, pagesTruncated: 900 },
        },
      ]),
      [P1, P2],
    )!;
    const key = resolutionCheckKey("meta-description", "has-meta");
    expect(new Set(signal.failing[key])).toEqual(new Set([h(P1), h(P2)]));
    expect(signal.truncated).toEqual([key]);
  });

  test("genuine site-scope checks (no pageUrl, not aggregated) and skipped checks emit nothing", () => {
    const signal = buildResolutionSignal(
      rules([
        // site-scope with pages[] but NOT an aggregate — never a page finding
        { name: "sitemap-orphans", status: "fail", message: "orphans", pages: [P1, P2] },
        { name: "robots-check", status: "skipped", message: "no robots.txt", pageUrl: P1 },
      ]),
      [P1, P2],
    )!;
    expect(Object.keys(signal.failing)).toEqual([]);
    expect(signal.crawledUrls).toEqual([P1, P2]);
  });

  test("returns undefined when there is nothing to signal", () => {
    expect(buildResolutionSignal({}, [])).toBeUndefined();
  });

  test("crawledUrls capped at maxCrawledUrls", () => {
    const urls = Array.from(
      { length: RESOLUTION_SIGNAL_LIMITS.maxCrawledUrls + 10 },
      (_, i) => `https://x.test/p/${i}`,
    );
    const signal = buildResolutionSignal({}, urls)!;
    expect(signal.crawledUrls.length).toBe(RESOLUTION_SIGNAL_LIMITS.maxCrawledUrls);
  });

  test("a single check past maxHashesPerCheck is clipped to the cap and marked truncated", () => {
    const pages = Array.from(
      { length: RESOLUTION_SIGNAL_LIMITS.maxHashesPerCheck + 10 },
      (_, i) => `https://x.test/p/${i}`,
    );
    const signal = buildResolutionSignal(
      rules([{ name: "c", status: "fail", message: "m", pages, details: { aggregated: true } }]),
      [P1],
    )!;
    const key = resolutionCheckKey("meta-description", "c");
    // Clipped deterministically (page order) — kept hashes are still positive
    // "still failing" evidence; the marker makes absence non-authoritative.
    expect(signal.failing[key]!.length).toBeLessThanOrEqual(
      RESOLUTION_SIGNAL_LIMITS.maxHashesPerCheck,
    );
    expect(signal.failing[key]).toContain(h("https://x.test/p/0"));
    expect(signal.truncated).toEqual([key]);
  });

  test("whole-signal hash budget: sets past the budget are clipped and marked truncated", () => {
    // 21 checks × per-check-cap hashes exceeds the 100k total budget: earlier
    // checks fit; the one that crosses the budget keeps only what fits and is
    // marked truncated (server falls back to carry on absence).
    const per = RESOLUTION_SIGNAL_LIMITS.maxHashesPerCheck;
    const count = Math.ceil(RESOLUTION_SIGNAL_LIMITS.maxHashesTotal / per) + 1;
    const ruleResults: Record<string, { checks: CheckResult[] }> = {};
    for (let r = 0; r < count; r++) {
      ruleResults[`rule-${r}`] = {
        checks: [
          {
            name: "c",
            status: "fail",
            message: "m",
            pages: Array.from({ length: per }, (_, i) => `https://x.test/${r}/${i}`),
            details: { aggregated: true },
          },
        ],
      };
    }
    const signal = buildResolutionSignal(ruleResults, [P1])!;
    const firstKey = resolutionCheckKey("rule-0", "c");
    const lastKey = resolutionCheckKey(`rule-${count - 1}`, "c");
    expect(signal.failing[firstKey]!.length).toBeGreaterThan(0);
    expect(signal.failing[lastKey]!.length).toBeLessThan(
      RESOLUTION_SIGNAL_LIMITS.maxHashesPerCheck,
    );
    expect(signal.truncated).toContain(lastKey);
    const total = Object.values(signal.failing).reduce((n, hs) => n + hs.length, 0);
    expect(total).toBeLessThanOrEqual(RESOLUTION_SIGNAL_LIMITS.maxHashesTotal);
  }, 30_000);
});

// The soundness case that matters most: a page the check did not EVALUATE must
// never look like a clean page. A page-scope rule can `skipped` one page while
// passing another (perf/ttfb without timing data), and a rule can emit nothing
// at all for a page it doesn't apply to — in both shapes the page is absent
// from `failing` without being clean.
describe("buildResolutionSignal — notEvaluated (unevaluated pages never resolve)", () => {
  const KEY = resolutionCheckKey("meta-description", "c");

  test("a page the check SKIPPED lands in notEvaluated, not in the clean set", () => {
    const signal = buildResolutionSignal(
      rules([
        { name: "c", status: "pass", message: "ok", pageUrl: P1 } as CheckResult,
        { name: "c", status: "fail", message: "bad", pageUrl: P2 } as CheckResult,
        { name: "c", status: "skipped", message: "no data", pageUrl: P3 } as CheckResult,
      ]),
      [P1, P2, P3],
    )!;

    expect(signal.failing[KEY]).toEqual([h(P2)]);
    // P1 evaluated clean → absent from both sets → resolvable.
    expect(signal.notEvaluated?.[KEY]).toEqual([h(P3)]);
    expect(signal.notEvaluated?.[KEY]).not.toContain(h(P1));
  });

  test("a page the rule emitted NO check for also lands in notEvaluated", () => {
    // Only P1/P2 produced results; P3 was crawled but the rule never ran on it.
    const signal = buildResolutionSignal(
      rules([
        { name: "c", status: "pass", message: "ok", pageUrl: P1 } as CheckResult,
        { name: "c", status: "fail", message: "bad", pageUrl: P2 } as CheckResult,
      ]),
      [P1, P2, P3],
    )!;

    expect(signal.notEvaluated?.[KEY]).toEqual([h(P3)]);
  });

  test("a check that evaluated every crawled page emits NO notEvaluated (common case is free)", () => {
    const signal = buildResolutionSignal(
      rules([
        { name: "c", status: "pass", message: "ok", pageUrl: P1 } as CheckResult,
        { name: "c", status: "pass", message: "ok", pageUrl: P2 } as CheckResult,
        { name: "c", status: "fail", message: "bad", pageUrl: P3 } as CheckResult,
      ]),
      [P1, P2, P3],
    )!;

    expect(signal.notEvaluated).toBeUndefined();
    expect(signal.failing[KEY]).toEqual([h(P3)]);
  });
});

// A 32-bit hash WILL collide eventually. The contract is that every collision
// lands in the conservative direction (over-carry), never a wrong resolve —
// which is why the notEvaluated complement is computed over normalized URLs
// rather than over hashes.
describe("buildResolutionSignal — hash collisions stay in the safe direction", () => {
  const KEY = resolutionCheckKey("meta-description", "c");

  test("an unevaluated page keeps its own notEvaluated entry even when it collides with an evaluated page", () => {
    // Find a real FNV-1a 32 collision among synthetic URLs so this pins actual
    // behavior rather than a mocked hash.
    const byHash = new Map<string, string>();
    let a: string | undefined;
    let b: string | undefined;
    for (let i = 0; i < 400_000 && !a; i++) {
      const candidate = `https://x.test/p/${i}`;
      const hash = resolutionUrlHash(normalizeUrl(candidate));
      const seen = byHash.get(hash);
      if (seen) {
        a = seen;
        b = candidate;
      } else {
        byHash.set(hash, candidate);
      }
    }
    expect(a).toBeDefined();
    expect(h(a!)).toBe(h(b!));

    // `a` is evaluated (pass), `b` was skipped — and they share a hash.
    const signal = buildResolutionSignal(
      rules([
        { name: "c", status: "pass", message: "ok", pageUrl: a! } as CheckResult,
        { name: "c", status: "skipped", message: "no data", pageUrl: b! } as CheckResult,
      ]),
      [a!, b!],
    )!;

    // Subtracting by URL keeps b's hash in notEvaluated. Consequence: the
    // colliding clean page `a` also fails to resolve — over-carry, which is the
    // safe direction. Subtracting by hash would have dropped b entirely and let
    // a live finding on it be resolved.
    expect(signal.notEvaluated?.[KEY]).toContain(h(b!));
  }, 30_000);
});

test("a check clipped at EXACTLY the per-check cap is still marked truncated", () => {
  // Regression guard for the deliberate cap+1 overshoot in the hashing loop.
  // Tightening that break to `>=` would stop the set at exactly the cap, the
  // budget pass would see a complete-looking set, and the key would be treated
  // as authoritative — resolving pages that were only clipped.
  const cap = RESOLUTION_SIGNAL_LIMITS.maxHashesPerCheck;
  const pages = Array.from({ length: cap + 50 }, (_, i) => `https://x.test/p/${i}`);
  const signal = buildResolutionSignal(
    rules([
      {
        name: "c",
        status: "fail",
        message: "m",
        pages,
        details: { aggregated: true },
      } as CheckResult,
    ]),
    [P1],
  )!;

  const key = resolutionCheckKey("meta-description", "c");
  expect(signal.failing[key]!.length).toBe(cap);
  expect(signal.truncated).toContain(key);
}, 30_000);
