// security/leaked-secrets — corpus-driven harness.
//
// Every pattern the detector knows, generated fresh from a seeded RNG, placed
// into every embedding context it can appear in, plus hand-written negatives
// and probes for interactions between patterns. Each case states the exact
// (pattern, check, location) set the rule must report, and a checked-in
// snapshot of the raw per-case scanner output turns any detector change into
// a reviewable diff.
//
// Cases carrying `knownGap` assert CURRENT (wrong) behaviour so the suite is
// green, and each one also registers a todo naming the fix, so the gap list
// is visible in the test output. Fixing a gap = flip its expectation here.
//
// See ./leaked-secrets/README.md for how to run and how to update the snapshot.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parsePage } from "@squirrelscan/parser";

import {
  CONTEXT_KEYWORD_GAP,
  CONTEXT_PATTERNS,
  FAST_PATTERNS,
  leakedSecretsRule,
  scanContent,
  scanPageForSecrets,
  selectFastPatterns,
  type LeakedSecret,
} from "../../src/security/leaked-secrets";
import type { RuleContext, RuleResult } from "../../src/types";
import { CASES, type Case, type Check, type Expectation } from "./leaked-secrets/cases";
import { CONTEXTS } from "./leaked-secrets/contexts";
import { GENERATORS, GENERATORS_BY_PATTERN, seededRng } from "./leaked-secrets/generators";

const SNAPSHOT_PATH = join(import.meta.dir, "leaked-secrets", "expected.json");
const UPDATE = process.env.UPDATE_SECRETS_SNAPSHOT === "1";

function ctxFor(c: Case): RuleContext {
  return {
    site: {
      baseUrl: "https://app.acme.test",
      pages: [{ url: c.url, statusCode: 200, parsed: parsePage(c.html, c.url) }],
      robotsTxt: null,
      sitemaps: null,
      scripts: (c.scripts ?? []).map((s) => ({
        url: s.url,
        status: 200,
        error: null,
        contentType: "application/javascript",
        sizeBytes: s.content.length,
        content: s.content,
        sourcePages: [c.url],
      })),
    },
    options: {},
  } as unknown as RuleContext;
}

const CHECK_NAMES: Record<Check, string> = {
  high: "leaked-secrets-high",
  medium: "leaked-secrets-medium",
  public: "leaked-secrets-public",
};

/** What the rule reported, in the same shape as a case's `expect`. */
function observed(c: Case): { findings: Expectation[]; ids: string[]; passed: boolean } {
  const { checks } = leakedSecretsRule.run(ctxFor(c)) as RuleResult;
  const findings: Expectation[] = [];
  const ids: string[] = [];
  for (const [check, name] of Object.entries(CHECK_NAMES) as Array<[Check, string]>) {
    const found = checks.find((k) => k.name === name);
    for (const item of found?.items ?? []) {
      // id = `${type}: ${masked}`; label = `Found in ${location} (${url})`
      const pattern = item.id.slice(0, item.id.lastIndexOf(": "));
      const location = /^Found in ([a-z-]+)/.exec(item.label ?? "")?.[1] as Expectation["location"];
      findings.push({ pattern, check, location });
      ids.push(item.id);
    }
  }
  return { findings, ids, passed: checks.some((k) => k.name === "leaked-secrets" && k.status === "pass") };
}

const key = (e: Expectation) => `${e.pattern}|${e.check}|${e.location}`;
const sorted = (xs: Expectation[]) => xs.map(key).sort();

/** The raw scanner output for one case, before the rule's dedup. */
function rawScan(c: Case): LeakedSecret[] {
  const doc = parsePage(c.html, c.url).document!;
  const out = scanPageForSecrets(doc, c.url);
  for (const s of c.scripts ?? []) out.push(...scanContent(s.content, "external-script", s.url));
  return out;
}

const ok = CASES.filter((c) => !c.knownGap);
const gaps = CASES.filter((c) => c.knownGap);

describe("security/leaked-secrets corpus: coverage", () => {
  test("every FAST and CONTEXT pattern has a generator, and no generator is stale", () => {
    const names = [...FAST_PATTERNS, ...CONTEXT_PATTERNS].map((p) => p.name);
    const missing = names.filter((n) => !GENERATORS_BY_PATTERN.has(n));
    const stale = GENERATORS.map((g) => g.pattern).filter((n) => !names.includes(n));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  test("every pattern has a positive in at least two contexts", () => {
    const perPattern = new Map<string, number>();
    for (const c of CASES) {
      const at = c.id.indexOf("@");
      if (at === -1) continue;
      const pattern = c.id.slice(0, at);
      perPattern.set(pattern, (perPattern.get(pattern) ?? 0) + 1);
    }
    const thin = [...perPattern].filter(([, n]) => n < 2).map(([p]) => p);
    expect(perPattern.size).toBe(GENERATORS.length);
    expect(thin).toEqual([]);
  });

  test("generators are deterministic for a given seed", () => {
    for (const g of GENERATORS) {
      expect(g.make(seededRng(42))).toEqual(g.make(seededRng(42)));
      expect(g.make(seededRng(42)).text).not.toBe(g.make(seededRng(43)).text);
    }
  });

  test("every generator's own value fires its own pattern when scanned bare", () => {
    // Bare, i.e. with no context around it at all: `key:"value"` in a script.
    // Keyed values get their keyword from the key name. This is the floor —
    // if it fails, nothing above it is meaningful.
    const wrong: string[] = [];
    for (const g of GENERATORS) {
      const v = g.make(seededRng(7));
      const keyName = g.keyName ?? "value";
      const js = g.tier === "assignment" ? `var c={${v.text}};` : `var c={${keyName}:${JSON.stringify(v.text)}};`;
      const types = scanContent(js, "inline-script").map((f) => f.type);
      const expected = g.pattern === "Clerk Secret Key" ? "Stripe Live Key" : g.pattern;
      if (!types.includes(expected)) {
        wrong.push(`${g.pattern}: got [${types.join(", ")}]`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("case ids are unique", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// pub#363: for every pattern, mechanically from its generator — a positive,
// a prefilter assertion, a corrupted-keyword near-miss, a mid-token near-miss
// (prefixed tier), a duplicate that collapses to one finding, and for the
// context tier the three directions of the bounded look-behind.
describe("security/leaked-secrets corpus: meta (every pattern, derived from its generator)", () => {
  const CLAIMED: Record<string, string> = { "Clerk Secret Key": "Stripe Live Key" };

  /** The bare embedding every generator fires in: `var c={key:"value"};`. */
  const bare = (g: (typeof GENERATORS)[number], text: string) =>
    g.tier === "assignment" ? `var c={${text}};` : `var c={${g.keyName ?? "value"}:${JSON.stringify(text)}};`;

  /** The keywords the detector declares for a pattern, whichever tier. */
  const keywordsOf = (name: string): string[] => {
    const fast = FAST_PATTERNS.find((p) => p.name === name);
    if (fast) return fast.keywords ?? [];
    const ctx = CONTEXT_PATTERNS.find((p) => p.name === name);
    return ctx ? [ctx.keyword] : [];
  };

  test("every FAST pattern declares at least one keyword, and none is an English word", () => {
    const missing = FAST_PATTERNS.filter((p) => !p.keywords || p.keywords.length === 0).map((p) => p.name);
    expect(missing).toEqual([]);
    const words = FAST_PATTERNS.flatMap((p) => p.keywords ?? []);
    expect(words.every((k) => k === k.toLowerCase())).toBe(true);
    // The tier is prefix tokens; a bare dictionary word here would gate
    // nothing. `bearer`/`basic`/`secret`/`password` are the generic
    // patterns' own literals and the one exception the tier has.
    const english = ["key", "token", "api", "auth", "user", "id", "data", "value", "name"];
    expect(words.filter((k) => english.includes(k))).toEqual([]);
  });

  for (const g of GENERATORS) {
    const expected = CLAIMED[g.pattern] ?? g.pattern;
    const value = g.make(seededRng(11));
    const input = bare(g, value.text);
    const keywords = keywordsOf(g.pattern);
    const isFast = FAST_PATTERNS.some((p) => p.name === g.pattern);

    test(`${g.pattern}: positive, and its input carries a declared keyword`, () => {
      expect(scanContent(input, "inline-script").map((f) => f.type)).toContain(expected);
      const lower = input.toLowerCase();
      expect(keywords.some((k) => lower.includes(k))).toBe(true);
    });

    // Every keyword occurrence with its last character replaced.
    const corrupt = (text: string) => {
      let out = text;
      for (const k of keywords) {
        const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        out = out.replace(re, (m) => m.slice(0, -1) + "#");
      }
      return out;
    };
    // The gram index is only built past 256 characters; pad so the prefilter
    // has something to decide with, the way a real body does.
    const pad = (text: string) => `${text}\n/* ${"-".repeat(300)} */`;

    test(`${g.pattern}: the prefilter selects it for its own positive and deselects a corrupted keyword`, () => {
      if (isFast) {
        expect(selectFastPatterns(pad(input))).toContain(expected);
        // A keyword under four characters proves nothing to a 4-gram index,
        // so its pattern is always selected; only longer ones can deselect.
        // The keyword is REMOVED here rather than corrupted by a character:
        // a PEM trailer repeats most of its header's grams and a run of `A`s
        // repeats its own, so one changed character leaves the index able to
        // say "maybe", which is the sound answer.
        if (keywords.every((k) => k.length >= 4)) {
          let removed = input;
          for (const k of keywords) {
            removed = removed.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "#");
          }
          expect(selectFastPatterns(pad(removed))).not.toContain(expected);
        }
      } else {
        expect(input.toLowerCase().includes(keywords[0]!)).toBe(true);
      }
    });

    test(`${g.pattern}: one corrupted character in the keyword and it no longer fires`, () => {
      const corrupted = corrupt(input);
      expect(corrupted).not.toBe(input);
      expect(scanContent(corrupted, "inline-script").map((f) => f.type)).not.toContain(expected);
    });

    if (g.tier === "prefixed") {
      test(`${g.pattern}: the prefix mid-token (foo…) does not fire`, () => {
        const midToken = bare(g, `foo${value.text}`);
        expect(scanContent(midToken, "inline-script").map((f) => f.type)).not.toContain(expected);
      });
    }

    test(`${g.pattern}: the same value twice collapses to one finding`, () => {
      // Two complete fixtures, each detectable on its own (the keyed tier
      // needs its keyword in front of BOTH), so the one finding is dedup's.
      const once = bare(g, value.text);
      expect(scanContent(once, "inline-script").filter((f) => f.type === expected)).toHaveLength(1);
      const found = scanContent(`${once}\n${once}`, "inline-script").filter((f) => f.type === expected);
      expect(found).toHaveLength(1);
    });

    if (g.tier === "keyed") {
      const keyword = keywords[0]!;
      // From the end of the keyword to the first character of the value:
      // ` */` (3), the filler, `;` (1) and `credential:"` (12).
      const at = (gap: number) =>
        `/* ${keyword} */${"x".repeat(gap - 3 - 1 - 'credential:"'.length)};credential:${JSON.stringify(value.text)}`;
      test(`${g.pattern}: keyword 30 before the value fires, 60 before does not, after does not`, () => {
        expect(scanContent(at(30), "inline-script").map((f) => f.type)).toEqual([g.pattern]);
        expect(scanContent(at(CONTEXT_KEYWORD_GAP), "inline-script").map((f) => f.type)).toEqual([g.pattern]);
        expect(scanContent(at(CONTEXT_KEYWORD_GAP + 1), "inline-script")).toEqual([]);
        expect(scanContent(at(60), "inline-script")).toEqual([]);
        expect(scanContent(`credential:${JSON.stringify(value.text)}; /* ${keyword} */`, "inline-script")).toEqual([]);
      });
    }
  }
});

describe("security/leaked-secrets corpus: rule output", () => {
  for (const c of ok) {
    test(c.id, () => {
      const got = observed(c);
      expect(sorted(got.findings)).toEqual(sorted(c.expect));
      for (const pattern of c.mustNotFire ?? []) {
        expect(got.findings.map((f) => f.pattern)).not.toContain(pattern);
      }
      // A page with only public-tier findings still passes the rule.
      const leaks = c.expect.filter((e) => e.check !== "public");
      expect(got.passed).toBe(leaks.length === 0);
      // Masked output never carries the sensitive core.
      if (c.secret && c.secret.length > 12) {
        for (const id of got.ids) expect(id).not.toContain(c.secret);
      }
    });
  }
});

describe("security/leaked-secrets corpus: known gaps (asserting CURRENT behaviour; each fix is its own PR)", () => {
  test("the gap list (printed, since bun hides todo names)", () => {
    const distinct = new Map<string, number>();
    for (const c of gaps) distinct.set(c.knownGap!, (distinct.get(c.knownGap!) ?? 0) + 1);
    const lines = [...distinct].map(([gap, n]) => `  [${String(n).padStart(2)} cases] ${gap}`);
    console.log(`\nleaked-secrets known gaps (${distinct.size}):\n${lines.join("\n")}\n`);
    expect(distinct.size).toBeGreaterThan(0);
  });

  for (const c of gaps) {
    test(`${c.id} — today: ${c.expect.map((e) => `${e.pattern} (${e.check})`).join(", ") || "nothing"}`, () => {
      const got = observed(c);
      expect(sorted(got.findings)).toEqual(sorted(c.expect));
      for (const pattern of c.mustNotFire ?? []) {
        expect(got.findings.map((f) => f.pattern)).not.toContain(pattern);
      }
    });
    test.todo(`GAP ${c.id}: ${c.knownGap}`, () => {
      throw new Error(c.knownGap);
    });
  }
});

describe("security/leaked-secrets corpus: invariants", () => {
  test("the same value in three locations is reported once, at the last location scanned", () => {
    const c = CASES.find((k) => k.id === "probe:same-value-in-three-locations-reports-once")!;
    const raw = rawScan(c);
    // html (meta) + html (script, via the serialized document) is one html
    // scan with one value, then the inline script, then the external script.
    expect(raw.map((f) => f.location)).toEqual(["html", "inline-script", "external-script"]);
    expect(new Set(raw.map((f) => f.value)).size).toBe(1);
    const got = observed(c);
    expect(got.findings).toHaveLength(1);
    expect(got.findings[0]?.location).toBe("external-script");
  });

  test("KNOWN DEFECT: an inline script is scanned twice, once inside the serialized HTML and once on its own", () => {
    const c = CASES.find((k) => k.id === "github-personal-access-token@inline-config-object")!;
    const raw = rawScan(c);
    expect(raw).toHaveLength(2);
    expect(raw.map((f) => f.location)).toEqual(["html", "inline-script"]);
    expect(raw[0]?.value).toBe(raw[1]?.value);
  });
  test.todo("GAP inline scripts are scanned twice (html serialization + script text); the rule's dedup hides it but the cost is paid", () => {
    throw new Error("known gap");
  });

  test("masking keeps the head and tail only", () => {
    const c = CASES.find((k) => k.id === "github-personal-access-token@window-env")!;
    const [id] = observed(c).ids;
    const masked = id!.slice(id!.lastIndexOf(": ") + 2);
    expect(masked).toMatch(/^.{6}\*{10,20}.{4}$/);
    expect(masked.startsWith(c.secret!.slice(0, 6))).toBe(true);
    expect(masked.endsWith(c.secret!.slice(-4))).toBe(true);
  });

  test("a context's own location matches where the rule reports", () => {
    // Every positive case is built by a context that declares a location; the
    // per-case tests already check it, this makes the mapping explicit.
    for (const ctx of CONTEXTS) {
      const sample = CASES.find((c) => c.id.endsWith(`@${ctx.id}`) && !c.knownGap)!;
      expect(sample.expect[0]?.location).toBe(ctx.location);
    }
  });
});

// One record per raw finding, stable across runs: the masked value is what a
// user sees and the only thing about the value that belongs in git.
type SnapshotRow = { type: string; confidence: string; publicByDesign: boolean; location: string; masked: string };
type Snapshot = Record<string, SnapshotRow[]>;

function mask(value: string): string {
  return value.length <= 12
    ? value.slice(0, 4) + "*".repeat(value.length - 4)
    : value.slice(0, 6) + "*".repeat(Math.min(value.length - 10, 20)) + value.slice(-4);
}

describe("security/leaked-secrets corpus: snapshot", () => {
  test("raw scanner output matches leaked-secrets/expected.json (UPDATE_SECRETS_SNAPSHOT=1 to rewrite)", () => {
    const current: Snapshot = {};
    for (const c of CASES) {
      // The 5 MB probe is about cost, not shape; keep the snapshot small.
      if (c.id === "probe:no-size-cap-on-external-script") continue;
      current[c.id] = rawScan(c).map((f) => ({
        type: f.type,
        confidence: f.confidence,
        publicByDesign: f.publicByDesign,
        location: f.location,
        masked: mask(f.value),
      }));
    }
    if (UPDATE) {
      // One row per line: a detector change then diffs as one line per finding.
      const body = Object.entries(current)
        .map(([id, rows]) => `  ${JSON.stringify(id)}: [${rows.length ? "\n" + rows.map((r) => `    ${JSON.stringify(r)}`).join(",\n") + "\n  " : ""}]`)
        .join(",\n");
      writeFileSync(SNAPSHOT_PATH, `{\n${body}\n}\n`);
    }
    const stored = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;
    expect(current).toEqual(stored);
  });
});
