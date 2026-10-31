// #1420: the 24 KB of extras a big bundle is sampled into past its head was eaten by hint windows, so a
// detector with no `hint` (Sentry.init, the React devtools hook, posthog.init...) lost its only chance, the
// leftover tail. Hints are now derived from every pattern, windows are shared out round by round across
// them, and the tail keeps a reserve.

import { describe, expect, test } from "bun:test";

import { bundleHints, detectTechnologies, sampleBundleExtras } from "../src";
import { ALL_FINGERPRINTS } from "../src/fingerprints";
import { deriveHints } from "../src/hint-derive";

const HEAD = 16 * 1024;
const EXTRAS = 24 * 1024;
const REF = (n: number): string => `p${String(n).padStart(19, "0")}`;

/** Benign code, `bytes` long. */
function filler(bytes: number): string {
  const unit = `function f(x){let y=x*3;const u="https://www.example.com/a/"+y;return u.length}\n`;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/** Many windows that qualify (a Supabase URL beside a key, a Firebase config): they fill a 24 KB budget several times over. */
function crowd(count: number): string {
  const key = ["eyJ", "x".repeat(40)].join("");
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`var s${i}=mk("https://${REF(i)}.supabase.co","${key}");`);
    lines.push(`var f${i}={authDomain:"app${i}.firebaseapp.com",storageBucket:"app${i}.appspot.com"};`);
  }
  return lines.join("\n");
}

function detect(content: string, extras = true): string[] {
  const body = extras ? `${content.slice(0, HEAD)}\n\\0\n${sampleBundleExtras(content, HEAD, EXTRAS)}` : content;
  return detectTechnologies(
    { url: "https://example.com/", headers: {}, html: "<html></html>", scripts: [{ url: "https://example.com/a.js", content: body }] },
    undefined,
    { maxScriptChars: 16 * 1024 * 1024 },
  ).map((t) => t.id);
}

describe("deriveHints", () => {
  test("the longest literal every match must contain, per alternative", () => {
    expect(deriveHints(/\[Sentry\]|Sentry\.init\(\s*\{/).hints).toEqual(["[Sentry]", "Sentry.init("]);
    expect(deriveHints(/__REACT_DEVTOOLS_GLOBAL_HOOK__/).hints).toEqual(["__REACT_DEVTOOLS_GLOBAL_HOOK__"]);
    expect(deriveHints(/Stripe\(/).hints).toEqual(["Stripe("]);
    expect(deriveHints(/fbq\(['"]init['"]/).hints).toEqual(["fbq("]);
    expect(deriveHints(/(?:foo|bar)baz12/).hints).toEqual(["baz12"]);
  });

  test("a case-insensitive pattern gives lower-cased hints and says so", () => {
    expect(deriveHints(/posthog\.init/i)).toEqual({ hints: ["posthog.init"], caseInsensitive: true });
    expect(deriveHints(/PostHog\.Init/i).hints).toEqual(["posthog.init"]);
    expect(deriveHints(/posthog\.init/).caseInsensitive).toBe(false);
  });

  test("never a literal a match can lack: optional, repeated and grouped text is left out", () => {
    expect(deriveHints(/a?bcdef/).hints).toEqual(["bcdef"]);
    expect(deriveHints(/abcdef?/).hints).toEqual(["abcde"]);
    expect(deriveHints(/abcde*/).hints).toEqual(["abcd"]);
    expect(deriveHints(/abcde{0,2}fg/).hints).toEqual(["abcd"]);
    expect(deriveHints(/abc{0,2}defg/).hints).toEqual(["defg"]);
    expect(deriveHints(/ab+cdefg/).hints).toEqual(["cdefg"]);
    expect(deriveHints(/(?:abcdef)?ghij/).hints).toEqual(["ghij"]);
    expect(deriveHints(/(abcdef|ghijkl)mnop/).hints).toEqual(["mnop"]);
    expect(deriveHints(/[a-z]+\s*\d+abc/).hints).toEqual([]);
    expect(deriveHints(/abc.defgh/).hints).toEqual(["defgh"]);
  });

  test("nothing under four characters, and nothing from a pure class or quantifier pattern", () => {
    expect(deriveHints(/abc/).hints).toEqual([]);
    expect(deriveHints(/[a-f0-9]{32}/).hints).toEqual([]);
    expect(deriveHints(/\bfoo\b|bar/).hints).toEqual([]);
  });

  test("every derived hint is a literal part of the pattern it came from (all script-content patterns)", () => {
    let derived = 0;
    for (const fp of ALL_FINGERPRINTS) {
      for (const d of fp.detectors) {
        if (d.type !== "script-content" || d.hint) continue;
        const { hints, caseInsensitive } = deriveHints(d.pattern);
        const plain = d.pattern.source.replace(/\\(.)/g, "$1");
        const haystack = caseInsensitive ? plain.toLowerCase() : plain;
        for (const hint of hints) {
          derived++;
          expect(haystack).toContain(hint);
          expect(hint.length).toBeGreaterThanOrEqual(4);
        }
      }
    }
    // Most of the unhinted detectors now have a literal to search for.
    expect(derived).toBeGreaterThan(120);
  });

  test("bundleHints lists the declared and the derived literals", () => {
    const all = bundleHints();
    expect(all).toContain("Sentry.init(");
    expect(all).toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
    expect(all).toContain("posthog.init");
    expect(all).toContain(".supabase.co");
  });
});

describe("the extras budget (#1420)", () => {
  test("a late Sentry.init survives hundreds of earlier hint windows that fill the budget", () => {
    const content = `${filler(300_000)}\n${crowd(400)}\n${filler(120_000)}\nSentry.init({dsn:"https://k@o1.ingest.sentry.io/2"});\n${filler(120_000)}`;
    const extras = sampleBundleExtras(content, HEAD, EXTRAS);
    expect(extras.length).toBeLessThanOrEqual(EXTRAS);
    expect(extras).toContain("Sentry.init(");
    expect(detect(content)).toContain("sentry");
  });

  test("every unhinted detector's first window is kept before any detector's second", () => {
    const hits = (token: string, n: number): string =>
      Array.from({ length: n }, (_, i) => `var t${token}${i}=${token}(${i});\n${filler(2_000)}`).join("");
    const content = [
      filler(100_000),
      crowd(300),
      `Stripe("pk_x");\n`,
      filler(50_000),
      `posthog.init("phc_x");\n`,
      filler(50_000),
      `window.__REACT_DEVTOOLS_GLOBAL_HOOK__={};\n`,
      filler(50_000),
      hits("Stripe", 40),
      filler(90_000),
    ].join("\n");
    const extras = sampleBundleExtras(content, HEAD, EXTRAS);
    expect(extras).toContain("posthog.init(");
    expect(extras).toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
    expect(extras).toContain("Stripe(");
    expect(extras.length).toBeLessThanOrEqual(EXTRAS);
  });

  test("a case-insensitive detector is found by its derived hint", () => {
    const content = `${filler(200_000)}\n${crowd(300)}\n${filler(100_000)}\nPostHog.Init("phc_x",{});\n${filler(100_000)}`;
    expect(sampleBundleExtras(content, HEAD, EXTRAS).toLowerCase()).toContain("posthog.init");
    expect(detect(content)).toContain("posthog");
  });

  test("the tail keeps a reserve however many windows qualify", () => {
    const marker = "\nvar tailMarker=1;\n";
    const content = `${filler(200_000)}\n${crowd(800)}\n${filler(400_000)}${marker}${filler(3_000)}`;
    const extras = sampleBundleExtras(content, HEAD, EXTRAS);
    const tail = content.slice(-3_000 - marker.length);
    expect(extras.endsWith(tail.slice(-2_500))).toBe(true);
    expect(extras.length).toBeLessThanOrEqual(EXTRAS);
  });

  test("no budget: with room for everything the windows are all there", () => {
    const content = `${filler(100_000)}\nSentry.init({dsn:"x"});\n${filler(100_000)}`;
    expect(sampleBundleExtras(content, HEAD, EXTRAS)).toContain("Sentry.init(");
  });

  test("a body that fits the head has no extras, as before", () => {
    expect(sampleBundleExtras(filler(10_000), HEAD, EXTRAS)).toBe("");
  });

  test("a hostile body of one repeated hint literal is sampled in well under a second", () => {
    const hostile = `${filler(50_000)}${"Sentry.init({".repeat(200_000)}${filler(1_000)}`;
    const started = performance.now();
    const extras = sampleBundleExtras(hostile, HEAD, EXTRAS);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(extras.length).toBeLessThanOrEqual(EXTRAS);
  });
});
