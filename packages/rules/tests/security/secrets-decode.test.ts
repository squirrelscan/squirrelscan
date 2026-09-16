// security/leaked-secrets — content decoders (#360).
//
// Each decoder is a pure function of the text and bounded in cost. These
// tests pin what each one decodes, what it refuses to decode (data URIs, SRI
// hashes, binary, an escaped backslash), the depth it stops at, and the cost
// of the acceptance-criterion case: a 200 KB image data URI must add under 5
// ms and report nothing.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { scanContent, scanPageForSecrets } from "../../src/security/leaked-secrets";
import {
  base64Location,
  decodeBase64Text,
  decodeForLocation,
  decodeHtmlEntities,
  decodePercentRun,
  decodePercentRuns,
  findBase64Runs,
  isExcludedBase64Run,
  looksLikeBase64Text,
  scanBase64Blobs,
  unescapeJsStrings,
} from "../../src/security/secrets/decode";

const j = (parts: string[]) => parts.join("");
const STRIPE = j(["sk_li", "ve_"]) + "4eC39HqLyjWDarjtT1zdp7dc"; // pragma: allowlist secret

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("HTML entities", () => {
  test("decodes named, decimal and hex references; leaves unknown names alone", () => {
    expect(decodeHtmlEntities("a &quot;b&quot; &amp; &lt;c&gt; &#39;d&#x27; &nbsp;e")).toBe("a \"b\" & <c> 'd'  e");
    expect(decodeHtmlEntities("&foo; &notanentity; &#; &#x; &")).toBe("&foo; &notanentity; &#; &#x; &");
    expect(decodeHtmlEntities("no entities here")).toBe("no entities here");
  });

  test("refuses NUL, surrogates and out-of-range code points", () => {
    expect(decodeHtmlEntities("&#0;&#xD800;&#x110000;")).toBe("&#0;&#xD800;&#x110000;");
    expect(decodeHtmlEntities("&#x1F600;")).toBe("😀");
  });

  test("a key entity-encoded inside an attribute is reported at location html", () => {
    const html = `<!DOCTYPE html><html><head><title>x</title></head><body><div data-cfg="{&quot;apiKey&quot;:&quot;${STRIPE}&quot;}"></div></body></html>`;
    const doc = parsePage(html, "https://a.test/").document!;
    const found = scanPageForSecrets(doc, "https://a.test/");
    expect(found.map((f) => [f.type, f.location])).toEqual([["Stripe Live Key", "html"]]);
    // The serializer really does write the quotes back as entities.
    expect(doc.toString()).toContain("&quot;apiKey&quot;");
  });

  test("a key whose own characters are entity-encoded is reported too", () => {
    const encoded = [...STRIPE].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join("");
    const html = `<!DOCTYPE html><html><head><title>x</title></head><body><p>${encoded}</p></body></html>`;
    const found = scanPageForSecrets(parsePage(html, "https://a.test/").document!, "https://a.test/");
    expect(found.map((f) => f.type)).toEqual(["Stripe Live Key"]);
  });
});

describe("JavaScript string escapes", () => {
  test("decodes \\uXXXX, \\u{X} and \\xXX", () => {
    expect(unescapeJsStrings("\\u0041\\x42\\u{43}\\u{1F600}")).toBe("ABC😀");
    expect(unescapeJsStrings("plain")).toBe("plain");
    expect(unescapeJsStrings("\\u00zz \\xg1 \\u{}")).toBe("\\u00zz \\xg1 \\u{}");
  });

  test("an escaped backslash before u is not an escape", () => {
    expect(unescapeJsStrings("\\\\u0041")).toBe("\\\\u0041");
    expect(unescapeJsStrings("\\\\\\u0041")).toBe("\\\\A");
  });

  test("a surrogate pair written as two escapes decodes to one character", () => {
    expect(unescapeJsStrings("\\uD83D\\uDE00")).toBe("😀");
  });

  test("a key written with escapes inside a script string reports at the script's location", () => {
    const escaped = [...STRIPE].map((c, i) => (i % 2 ? `\\x${c.charCodeAt(0).toString(16)}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)).join("");
    const html = `<!DOCTYPE html><html><head><title>x</title></head><body><script>window.k="${escaped}";</script></body></html>`;
    const found = scanPageForSecrets(parsePage(html, "https://a.test/").document!, "https://a.test/");
    // Both the serialized document and the script itself are decoded, so the
    // same value is found in both; the rule keeps the script's record.
    expect(found.map((f) => [f.type, f.location])).toEqual([
      ["Stripe Live Key", "html"],
      ["Stripe Live Key", "inline-script"],
    ]);
    expect(scanContent(`var k="${escaped}";`, "external-script", "https://a.test/app.js").map((f) => f.location)).toEqual(["external-script"]);
  });
});

describe("percent-encoding", () => {
  test("decodes a URL-encoded document in place; a run needs three escapes", () => {
    const json = JSON.stringify({ key: STRIPE, currency: "usd" });
    expect(decodePercentRuns(`<div data-settings="${encodeURIComponent(json)}"></div>`)).toBe(`<div data-settings="${json}"></div>`);
    expect(decodePercentRuns("?q=hello%20world%20foo%20bar&x=1")).toBe("?q=hello world foo bar&x=1");
    expect(decodePercentRuns("?q=hello%20world&x=1")).toBe("?q=hello%20world&x=1");
    expect(decodePercentRuns("no percent here")).toBe("no percent here");
  });

  test("a % not followed by two hex digits is a percent sign and never decodes", () => {
    expect(decodePercentRuns("100%25 sure %zz %")).toBe("100%25 sure %zz %");
    expect(decodePercentRuns("50% off, 60% off, 70% off")).toBe("50% off, 60% off, 70% off");
    expect(decodePercentRun("a%2Gb%2Hc%2I")).toBeNull();
    // Mixed: the good escapes decode, the bad one stays.
    expect(decodePercentRun("a%20b%20c%20d%zz")).toBe("a b c d%zz");
  });

  test("binary or invalid UTF-8 is refused; UTF-8 and raw non-ASCII decode", () => {
    expect(decodePercentRun("%FF%FE%00%01")).toBeNull();
    expect(decodePercentRun("%00%00%00")).toBeNull();
    expect(decodePercentRun("caf%C3%A9%20au%20lait")).toBe("café au lait");
    expect(decodePercentRun("café%20au%20lait%21")).toBe("café au lait!");
    expect(decodePercentRun("😀%20a%20b%20c")).toBe("😀 a b c");
  });

  test("a key inside URL-encoded JSON reports at the plain location", () => {
    const json = JSON.stringify({ apiKey: STRIPE, currency: "usd" });
    const html = `<!DOCTYPE html><html><head><title>x</title></head><body><div data-settings="${encodeURIComponent(json)}"></div></body></html>`;
    expect(scanPageForSecrets(parsePage(html, "https://a.test/").document!, "https://a.test/").map((f) => [f.type, f.location])).toEqual([["Stripe Live Key", "html"]]);
    expect(scanContent(`var s=JSON.parse(decodeURIComponent("${encodeURIComponent(json)}"));`, "external-script").map((f) => f.location)).toEqual(["external-script"]);
  });

  test("a run is bounded by code punctuation, so minified code with many escapes stays linear", () => {
    // 20k `%2F` escapes inside one unquoted, unspaced minified statement:
    // each is its own short run (bounded by the brackets), not a re-walk of
    // everything since the last quote.
    const parts: string[] = [];
    for (let i = 0; i < 20_000; i++) parts.push(`f${i}(a%2Fb%2Fc%2Fd)`);
    const code = parts.join(";");
    const started = performance.now();
    const decoded = decodePercentRuns(code);
    expect(performance.now() - started).toBeLessThan(200);
    // Only the first 256 runs decode; the shape is what is under test.
    expect(decoded.startsWith("f0(a/b/c/d);f1(a/b/c/d)")).toBe(true);
    // A URL-encoded JSON document still decodes whole: its own punctuation is
    // all escaped, so nothing inside it ends the run.
    const json = JSON.stringify({ key: STRIPE, list: [1, 2, 3], nested: { a: "b;c" } });
    expect(decodePercentRuns(`x=${encodeURIComponent(json)};`)).toBe(`x=${json};`);
  });

  test("runs are bounded and the pass is cheap without a percent sign", () => {
    let filler = "";
    while (filler.length < 2_000_000) filler += `var ab${filler.length % 977}=function(a,b){return a+b};`;
    const started = performance.now();
    expect(decodePercentRuns(filler)).toBe(filler);
    expect(performance.now() - started).toBeLessThan(50);
    // 300 runs: only the first 256 are decoded.
    const many = Array.from({ length: 300 }, () => "a%20b%20c%20d").join(" ");
    const decoded = decodePercentRuns(many).split(" ");
    expect(decoded.filter((w) => w === "a").length).toBe(256);
    // A run past the size cap is left alone.
    const huge = "%41".repeat(400_000);
    expect(decodePercentRuns(huge)).toBe(huge);
  });
});

describe("base64 run finder", () => {
  const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_"; // pragma: allowlist secret

  /** The obvious, slow definition: every maximal run, padding included. */
  function brute(text: string) {
    const re = /[A-Za-z0-9+/_-]+={0,2}/g;
    const out: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length >= 64) out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  test("the sampling finder agrees with the brute-force definition on random text", () => {
    const r = rng(1);
    for (let t = 0; t < 3000; t++) {
      let s = "";
      const n = 40 + Math.floor(r() * 500);
      for (let i = 0; i < n; i++) s += r() < 0.03 ? " =\"':;{}<"[Math.floor(r() * 10)] : ALPH[Math.floor(r() * ALPH.length)];
      expect(findBase64Runs(s)).toEqual(brute(s));
    }
  });

  test("boundary lengths: 63 is not a run, 64 is, padding counts", () => {
    expect(findBase64Runs(`x ${"A".repeat(63)} y`)).toEqual([]);
    expect(findBase64Runs(`x ${"A".repeat(64)} y`)).toEqual([{ start: 2, end: 66 }]);
    expect(findBase64Runs(`x ${"A".repeat(62)}== y`)).toEqual([{ start: 2, end: 66 }]);
    expect(findBase64Runs("A".repeat(64))).toEqual([{ start: 0, end: 64 }]);
  });

  test("data: URI payloads and SRI hashes are excluded by their lead-in", () => {
    const text = `<img src="data:image/png;base64,${"A".repeat(80)}"><script integrity="sha384-${"B".repeat(64)}"></script><i data-x="${"C".repeat(70)}">`;
    const runs = findBase64Runs(text);
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => isExcludedBase64Run(text, run.start))).toEqual([true, true, false]);
  });

  test("is linear on identifier-dense code", () => {
    let filler = "";
    while (filler.length < 2_000_000) filler += `var ab${filler.length % 977}=function(a,b){return a+b};`;
    const started = performance.now();
    expect(findBase64Runs(filler)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("base64 text decode", () => {
  test("decodes text and refuses binary, short and oversized input", () => {
    const text = JSON.stringify({ apiKey: STRIPE, locale: "en-GB", theme: "dark", flags: [1, 2, 3] });
    expect(decodeBase64Text(Buffer.from(text).toString("base64"))).toBe(text);
    expect(decodeBase64Text(Buffer.from(text).toString("base64url"))).toBe(text);
    const r = rng(2);
    const binary = Buffer.from(Array.from({ length: 300 }, () => Math.floor(r() * 256))).toString("base64");
    expect(decodeBase64Text(binary)).toBeNull();
    expect(decodeBase64Text("A".repeat(63))).toBeNull();
    expect(decodeBase64Text("A".repeat(5 * 1024 * 1024))).toBeNull();
    // Latin-1 bytes above 0x7f that are not UTF-8.
    expect(decodeBase64Text(Buffer.from("caf\xe9 ".repeat(20), "latin1").toString("base64"))).toBeNull();
    expect(decodeBase64Text(Buffer.from("café ".repeat(20), "utf8").toString("base64"))).toBe("café ".repeat(20));
  });

  test("URL paths and single-case runs are rejected before anything is allocated", () => {
    // What a Shopify product page's 300 base64-shaped runs actually are.
    expect(looksLikeBase64Text("com/cdn/shopifycloud/storefront/assets/storefront/original/1234567890abcdef")).toBe(false);
    expect(looksLikeBase64Text("apps/pagefly-ai-page-builder/blocks/app-embed/8312/assets/app-embed-block")).toBe(false);
    expect(looksLikeBase64Text("com/extensions/01a0a352-6f62-78ee-897f-0ae2860fdb47/assets/index-abc123def")).toBe(false);
    expect(looksLikeBase64Text("A".repeat(64))).toBe(false);
    expect(looksLikeBase64Text("0123456789abcdef".repeat(4))).toBe(false);
    // Real encodings of text pass, in both alphabets and with padding.
    const r = rng(4);
    for (let i = 0; i < 200; i++) {
      const text = JSON.stringify({ k: STRIPE, v: Array.from({ length: 4 }, () => Math.floor(r() * 1e6)), s: "x".repeat(Math.floor(r() * 40)) });
      expect(looksLikeBase64Text(Buffer.from(text).toString("base64"))).toBe(true);
      expect(looksLikeBase64Text(Buffer.from(text).toString("base64url"))).toBe(true);
    }
    expect(decodeBase64Text("com/cdn/shopifycloud/storefront/assets/storefront/original/1234567890abcdef")).toBeNull();
  });

  test("a control character anywhere rejects the blob", () => {
    const withNul = Buffer.from(`${"a".repeat(60)}\u0000${"b".repeat(60)}`).toString("base64");
    expect(decodeBase64Text(withNul)).toBeNull();
    const withTabs = Buffer.from(`${"a".repeat(60)}\t\n\r${"b".repeat(60)}`).toString("base64");
    expect(decodeBase64Text(withTabs)).not.toBeNull();
  });
});

describe("base64 blobs through the scanner", () => {
  const blob = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

  test("a key inside a base64 blob assigned to a global reports with the (base64) suffix", () => {
    const b = blob({ env: "prod", apiKey: STRIPE, features: { billing: true, sso: false } });
    const found = scanContent(`window.__CONFIG__="${b}";`, "inline-script", "https://a.test/");
    expect(found.map((f) => [f.type, f.location, f.sourceUrl])).toEqual([["Stripe Live Key", "inline-script (base64)", "https://a.test/"]]);
  });

  test("a key inside a base64 blob in a data attribute reports at html (base64)", () => {
    const b = blob({ session: null, config: { apiKey: STRIPE, locale: "en" } });
    const html = `<!DOCTYPE html><html><head><title>x</title></head><body><div id="root" data-state="${b}"></div></body></html>`;
    const found = scanPageForSecrets(parsePage(html, "https://a.test/").document!, "https://a.test/");
    expect(found.map((f) => [f.type, f.location])).toEqual([["Stripe Live Key", "html (base64)"]]);
  });

  test("unwraps two levels and stops there; the suffix is written once", () => {
    const one = blob({ config: { apiKey: STRIPE, locale: "en-GB", theme: "dark" } });
    const two = blob({ payload: one, v: 2 });
    const three = blob({ outer: two, v: 3 });
    expect(scanContent(`a="${one}";`, "html").map((f) => f.location)).toEqual(["html (base64)"]);
    expect(scanContent(`a="${two}";`, "html").map((f) => f.location)).toEqual(["html (base64)"]);
    expect(scanContent(`a="${three}";`, "html")).toEqual([]);
    expect(base64Location("html (base64)")).toBe("html (base64)");
  });

  test("never decodes inside a data: image URI or an SRI hash", () => {
    const b = blob({ token: STRIPE, padding: "p".repeat(100) });
    const html = `<!DOCTYPE html><html><head><title>x</title><script src="/v.js" integrity="sha256-${blob({ t: STRIPE }).slice(0, 64)}"></script></head><body><img src="data:image/png;base64,${b}"></body></html>`;
    expect(scanPageForSecrets(parsePage(html, "https://a.test/").document!, "https://a.test/")).toEqual([]);
  });

  test("a 200 KB base64 image data URI adds under 5 ms and reports nothing", () => {
    const r = rng(3);
    const img = Buffer.from(Array.from({ length: 150_000 }, () => Math.floor(r() * 256))).toString("base64");
    const html = `<!DOCTYPE html><html><head><title>x</title></head><body><img alt="" src="data:image/png;base64,${img}"></body></html>`;
    const serialized = parsePage(html, "https://a.test/").document!.toString();
    expect(serialized.length).toBeGreaterThan(200_000);

    // Warm, then best of five: the decoders only, since that is what this
    // change adds to the page scan.
    const added = () => {
      const started = performance.now();
      const decoded = decodeForLocation(serialized, "html");
      const found = scanBase64Blobs(decoded, "html", undefined, 0, () => []);
      return { ms: performance.now() - started, found };
    };
    added();
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const run = added();
      expect(run.found).toEqual([]);
      best = Math.min(best, run.ms);
    }
    expect(best).toBeLessThan(5);
  });

  test("a real-shaped 3 MB page (inline base64 fonts, 2000 entities, percent escapes) costs under half its scan", () => {
    // What a heavy marketing page looks like: a few hundred KB of woff2 in
    // CSS `url(data:…;base64,…)`, entity-encoded attributes, URL-encoded
    // query strings, and ordinary markup. The decoders must add less than the
    // scan itself costs, i.e. the decoded scan stays within 2x of a scan with
    // nothing to decode.
    const r = rng(9);
    const font = () => Buffer.from(Array.from({ length: 360_000 }, () => Math.floor(r() * 256))).toString("base64");
    const css = Array.from({ length: 6 }, (_, i) => `@font-face{font-family:F${i};src:url(data:font/woff2;base64,${font()}) format("woff2")}`).join("\n");
    const entities = Array.from({ length: 2000 }, (_, i) => `<a href="/p?a=${i}&amp;b=2" title="&quot;q${i}&quot;">Item &#39;${i}&#39; &lt;b&gt;</a>`).join("");
    const percents = Array.from({ length: 200 }, (_, i) => `<a href="/s?q=term%20${i}%20x%2Fy">s</a>`).join("");
    const html = `<!DOCTYPE html><html><head><title>x</title><style>${css}</style></head><body>${entities}${percents}<p>${"lorem ipsum dolor ".repeat(20_000)}</p></body></html>`;
    const serialized = parsePage(html, "https://a.test/").document!.toString();
    expect(serialized.length).toBeGreaterThan(3_000_000);

    const decodersOnly = () => {
      const started = performance.now();
      const decoded = decodeForLocation(serialized, "html");
      scanBase64Blobs(decoded, "html", undefined, 0, () => []);
      return performance.now() - started;
    };
    const wholeScan = () => {
      const started = performance.now();
      const found = scanContent(serialized, "html");
      expect(found).toEqual([]);
      return performance.now() - started;
    };
    let decoders = Infinity;
    let whole = Infinity;
    for (let i = 0; i < 2; i++) {
      decoders = Math.min(decoders, decodersOnly());
      whole = Math.min(whole, wholeScan());
    }
    // The scan without the decoders is (whole - decoders); within 2x of it
    // means the decoders cost at most as much as everything else.
    expect(decoders).toBeLessThan(whole - decoders);
  });

  test("decoded findings dedup against the rule like any other", () => {
    const b = blob({ apiKey: STRIPE, locale: "en-GB", theme: "dark" });
    const found = scanContent(`var a="${STRIPE}";var b="${b}";`, "inline-script");
    // The raw value first, then the decoded copy: same value, two records,
    // which the rule's dedup-by-value folds to one.
    expect(found.map((f) => f.location)).toEqual(["inline-script", "inline-script (base64)"]);
  });

  test("hostile blobs neither throw nor run away: a blob of `=`, all padding, a giant run", () => {
    for (const text of ["=".repeat(100), `${"A".repeat(70)}${"=".repeat(50)}`, "A".repeat(3_000_000), "/".repeat(2000), "-_".repeat(500)]) {
      expect(() => scanContent(`x="${text}";`, "inline-script")).not.toThrow();
    }
  });
});
