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

  test("the most selective literal, not the longest: gtag( over config, ym( over init, ml( over account", () => {
    expect(deriveHints(/gtag\(['"]config['"],\s*['"]G-/i).hints).toEqual(["gtag("]);
    expect(deriveHints(/ym\(\d+,\s*["']init["']/i).hints).toEqual(["ym("]);
    expect(deriveHints(/ml\(\s*["']account["']/i).hints).toEqual(["ml("]);
    expect(deriveHints(/window\[['"]adrum-(?:start-time|app-key)['"]\]/).hints).toEqual(["adrum-"]);
    expect(deriveHints(/_st\(\s*['"]install['"]|SwiftypeObject/i).hints).toEqual(["_st(", "swiftypeobject"]);
    // A bare common word is never a hint; with nothing else the alternative stays tail-only.
    expect(deriveHints(/\bconfig\b/).hints).toEqual([]);
    expect(deriveHints(/\binit\s*\(\s*\d/).hints).toEqual([]);
  });

  test("no literal is a common word: none of the measured common words (config, init, account...) is used", () => {
    for (const hint of bundleHints()) {
      expect(["config", "init", "account", "install", "window[", "window.", "document."]).not.toContain(hint.toLowerCase());
    }
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
          expect(hint.length).toBeGreaterThanOrEqual(3);
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

describe("review fixes (#1420)", () => {
  /** Distinct vendor calls that qualify a derived-hint window each. */
  const VENDORS = [
    'Sentry.init({dsn:"https://k@o1.ingest.sentry.io/2"});',
    'posthog.init("phc_x",{});',
    'Stripe("pk_test_x");',
    "window.__REACT_DEVTOOLS_GLOBAL_HOOK__={};",
    "window.__VUE__=!0;",
    "fbq('init','1234567890');",
    "gtag('config','G-ABC1234567');",
    'Bugsnag.start({apiKey:"x"});',
    'Countly.init({app_key:"x"});',
    'Paddle.Setup({vendor:1});',
    'Calendly.initPopupWidget({url:"x"});',
    '_paq.push(["trackPageView"]);',
    'ttq.load("ABC");',
    'jwplayer("p").setup({});',
    'Bugsnag.notify(e);',
  ];

  test("an inCode detector's real config survives any number of string mentions of the vendor", () => {
    for (const mentions of [7, 8, 9, 40]) {
      const docs = Array.from({ length: mentions }, (_, i) => `var doc${i}='{authDomain:"doc${i}.firebaseapp.com"}';`).join("\n");
      const content = [filler(100_000), docs, filler(100_000), `var cfg={authDomain:"real-app.firebaseapp.com"};`, filler(100_000)].join("\n");
      expect(sampleBundleExtras(content, HEAD, EXTRAS)).toContain("real-app.firebaseapp.com");
      expect(detect(content)).toContain("firebase");
    }
  });

  test("a docs snippet in a string does not take a window, a real call after it does", () => {
    const key = ["eyJ", "x".repeat(40)].join("");
    // Matches the Supabase pattern as text, but starts inside a string: an inCode detector rejects it.
    const mention = (i: number): string => `var note${i}='mk("https://${REF(i)}.supabase.co","${key}")';`;
    const content = [
      filler(40_000),
      ...Array.from({ length: 30 }, (_, i) => mention(i) + "\n" + filler(1_500)),
      `var real=mk("https://${REF(999)}.supabase.co","${key}");`,
      filler(40_000),
    ].join("\n");
    const extras = sampleBundleExtras(content, HEAD, EXTRAS);
    expect(extras).toContain(REF(999));
    expect(detect(content)).toContain("supabase");
  });

  test("declared hints keep their first windows when derived hints could take the whole budget", () => {
    // A 4 KB budget holds a handful of windows; fifteen vendor calls come before two real Supabase configs.
    const key = ["eyJ", "x".repeat(40)].join("");
    const supabase = (n: number): string => `var s${n}=mk("https://${REF(n)}.supabase.co","${key}");`;
    const content = [
      filler(30_000),
      ...VENDORS.map((v) => `${v}\n${filler(900)}`),
      supabase(1),
      filler(900),
      supabase(2),
      filler(60_000),
    ].join("\n");
    const extras = sampleBundleExtras(content, HEAD, 4096);
    expect(extras.length).toBeLessThanOrEqual(4096);
    expect(extras).toContain(REF(1));
    expect(extras).toContain(REF(2));
  });

  test("one U+0130 in a bundle does not switch off the case-insensitive hints", () => {
    const turkish = 'var tr={"\u0130stanbul":"\u0130stanbul","\u0130zmir":"\u0130zmir"};';
    const body = (prefix: string): string =>
      `${filler(120_000)}\n${prefix}\n${crowd(300)}\n${filler(60_000)}\nPostHog.Init("phc_x",{});\n${filler(120_000)}\n${crowd(300)}\n${filler(120_000)}`;
    for (const content of [body(""), body(turkish)]) {
      expect(sampleBundleExtras(content, HEAD, EXTRAS).toLowerCase()).toContain("posthog.init");
      expect(detect(content)).toContain("posthog");
    }
  });

  test("U+0130 after the real call and at the very end of a bundle keeps the indices aligned", () => {
    const content = `${filler(60_000)}\nPostHog.Init("phc_x",{});\n${filler(60_000)}\n\u0130\u0130\u0130`;
    expect(sampleBundleExtras(content, HEAD, EXTRAS)).toContain("PostHog.Init(");
  });
});

// Corpus re-run of #1433 (33,967 sites): small scripts whose loader (`ttq.load(`, `fbq('init'`,
// `posthog.init`) v0.0.149 found and the first version of this change dropped. The string tracker
// (a heuristic) read a quote inside a regex after `}` or `)` as the opening of a string and called
// the loader part of it, a long one, so its window was skipped; another hint's window after it then
// started the tail past the loader, and the stretch between was lost.
describe("a loader the string tracker loses is still sent (#1433 corpus)", () => {
  /** One long line the tracker reads as a string from the regex's quote to the end of the line, loader inside. */
  const lostLine = (loader: string): string => `x=a}/'/.test(c);${filler(1_500).replaceAll("\n", "")}${loader}${filler(1_000).replaceAll("\n", "")}\n`;
  const after = 'Stripe("pk_test_x");\n';
  const cases: Array<{ name: string; loader: string; id: string; before: number; rest: number }> = [
    { name: "26 KB script, ttq.load( at 21 KB", loader: "ttq.load('ABCDEFGH');ttq.page();", id: "tiktok-pixel", before: 20_000, rest: 3_500 },
    { name: "121 KB script, fbq( 2 KB from the end", loader: "fbq('init','1234567890');fbq('track','PageView');", id: "facebook-pixel", before: 116_000, rest: 1_500 },
    { name: "34 KB chunk, posthog.init at 19 KB", loader: "window.posthog||[]);posthog.init('phc_x',{api_host:'https://h.example.com'});", id: "posthog", before: 17_000, rest: 14_000 },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const content = `${filler(c.before)}\n${lostLine(c.loader)}${filler(300)}\n${after}${filler(c.rest)}`;
      const extras = sampleBundleExtras(content, HEAD, EXTRAS);
      expect(extras).toContain(c.loader.slice(0, 16));
      expect(extras.length).toBeLessThanOrEqual(EXTRAS);
      expect(detect(content)).toContain(c.id);
    });
  }

  test("the rest of the file is kept whole when it fits the extras, whatever the windows hold", () => {
    const content = `${filler(30_000)}\nStripe("pk_test_x");\n${filler(5_000)}\nposthog.init("phc_x",{});\n${filler(4_000)}`;
    const extras = sampleBundleExtras(content, HEAD, EXTRAS);
    const rest = content.slice(HEAD);
    expect(extras.length).toBeLessThanOrEqual(EXTRAS);
    expect(extras.endsWith(rest.slice(-3_000))).toBe(true);
    expect(extras).toContain("Stripe(");
    expect(extras).toContain("posthog.init(");
  });

  test("a tail the windows overlap is sent once", () => {
    const content = `${filler(40_000)}\nStripe("pk_test_x");\n${filler(2_000)}`;
    const extras = sampleBundleExtras(content, HEAD, EXTRAS);
    expect(extras.split("Stripe(").length).toBe(2);
  });

  test("a cut inside a long real string reopens it: code quoted in an inlined script is not a match", () => {
    const key = ["eyJ", "x".repeat(40)].join("");
    const inlined = `${filler(30_000)}var c=mk("https://${REF(7)}.supabase.co","${key}");\n${filler(2_000)}`;
    const content = `${filler(16_500)}\nvar worker=\`${inlined}\`;\n${filler(3_000)}`;
    const extras = sampleBundleExtras(content, HEAD, EXTRAS);
    expect(extras.length).toBeLessThanOrEqual(EXTRAS);
    expect(extras).toContain(REF(7));
    expect(extras.startsWith("`")).toBe(true);
    // The whole body reads the call as text inside a string; so must the sampled one.
    expect(detect(content)).not.toContain("supabase");
    expect(detect(content, false)).not.toContain("supabase");
  });
});

