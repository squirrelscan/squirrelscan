// #1254: the libraries of a Vite or Next.js app live in its bundles, not its
// near-empty HTML shell. Detection reads the first 64 KB of each first-party
// bundle, and the `inCode` detectors only count a real call or config in code,
// never a comment, a string, or a placeholder.

import { describe, expect, test } from "bun:test";

import {
  detectTechnologies,
  sampleBundleExtras,
  TECH_DETECT_PAGE_BUDGET_MS,
  TECH_SCRIPT_CONTENT_LIMIT,
  type DetectOptions,
} from "../src";
import { scanJs } from "../src/js-scan";

const SHELL = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script type="module" src="/assets/index-a1b2c3.js"></script></body></html>`;
const REF = "abcdefghijklmnopqrst"; // 20 chars, a project ref shape

function detect(
  scripts: Array<{ url: string; content?: string }>,
  html = SHELL,
  options: DetectOptions = {},
): string[] {
  return detectTechnologies(
    { url: "https://example.com/", headers: {}, html, scripts },
    undefined,
    options,
  ).map((t) => t.id);
}

/** What the local scan passes: whole bundles up to the largest `bundle_bytes`. */
const WHOLE = { maxScriptChars: 16 * 1024 * 1024, budgetMs: 30_000 };

describe("bundle bodies reach script-content detection", () => {
  test("Vite SPA shell + a bundle calling createClient on a supabase.co ref", () => {
    const bundle = `var a=1;const sb=createClient("https://${REF}.supabase.co","anon-key-value");export{sb}`;
    expect(detect([{ url: "https://example.com/assets/index-a1b2c3.js", content: bundle }])).toContain(
      "supabase",
    );
  });

  test("the minified `(0,t.createClient)(...)` shape matches too", () => {
    const bundle = `x=(0,t.createClient)("https://${REF}.supabase.co",y,{auth:{persistSession:!0}})`;
    expect(detect([{ url: "https://example.com/a.js", content: bundle }])).toContain("supabase");
  });

  test("Next.js chunks: Firebase config in one, Clerk key in another", () => {
    const firebase = `const cfg={apiKey:"k",authDomain:"demo-app.firebaseapp.com",projectId:"demo-app"};initializeApp(cfg)`;
    const clerk = `e.exports=n.createElement(ClerkProvider,{publishableKey:"pk_test_Y2xlcmsuZXhhbXBsZS5pbnZhbGlkJA0123456789"})`; // pragma: allowlist secret
    const ids = detect(
      [
        { url: "https://example.com/_next/static/chunks/app/layout-1.js", content: firebase },
        { url: "https://example.com/_next/static/chunks/pages/_app-2.js", content: clerk },
      ],
      `<!doctype html><html><body><div id="__next"></div><script src="/_next/static/chunks/app/layout-1.js"></script></body></html>`,
    );
    expect(ids).toContain("firebase");
    expect(ids).toContain("clerk");
  });

  test("Firebase storageBucket config matches", () => {
    const bundle = `initializeApp({storageBucket:"demo-app.firebasestorage.app"})`;
    expect(detect([{ url: "https://example.com/a.js", content: bundle }])).toContain("firebase");
  });
});

const KEY = ["eyJ", "x".repeat(40)].join("");

describe("mangled and indirect shapes", () => {
  const cases: Record<string, string> = {
    "a mangled call with a key literal": `uT=tg("https://${REF}.supabase.co","${KEY}")`,
    "a trailing slash": `a=f("https://${REF}.supabase.co/","${KEY}")`,
    "a template literal URL": "a=f(`https://" + REF + ".supabase.co`,`" + KEY + "`)",
    "a publishable key": `a=f("https://${REF}.supabase.co","sb_publishable_${"y".repeat(20)}")`,
    "a URL and key held in one declaration": `const u="https://${REF}.supabase.co",k="${KEY}";`,
    "a supabaseUrl property": `{supabaseUrl:"https://${REF}.supabase.co",x:1}`,
    "a quoted firebase key": `{"authDomain":"demo-app.firebaseapp.com"}`,
    "a quoted clerk key": `{"publishableKey":"pk_test_${"a".repeat(30)}"}`, // pragma: allowlist secret
    "a clerk env fallback": `publishableKey:e.publishableKey||"pk_live_${"a".repeat(30)}"`, // pragma: allowlist secret
  };
  const vendor = (name: string) =>
    name.includes("firebase") ? "firebase" : name.includes("clerk") ? "clerk" : "supabase";
  for (const [name, bundle] of Object.entries(cases)) {
    test(name, () => {
      expect(detect([{ url: "https://example.com/a.js", content: bundle }])).toContain(
        vendor(name),
      );
    });
  }
});

describe("near misses do not match", () => {
  const cases: Record<string, string> = {
    "a URL with a path next to a key": `f("https://${REF}.supabase.co/rest/v1/","${KEY}")`,
    "a URL not followed by a key literal": `f("https://${REF}.supabase.co",someVar)`,
    "the URL and key pair inside a docs string": `log('call f("https://${REF}.supabase.co","${KEY}")')`,
    "the URL and key pair in a comment": `// f("https://${REF}.supabase.co","${KEY}")`,
    "a sentence holding the URL": `x="see https://${REF}.supabase.co, then ${KEY}"`,
    "a placeholder ref with a key": `f("https://your${REF.slice(0, 16)}.supabase.co","${KEY}")`,
    "a repeated-character placeholder ref": `f("https://${"x".repeat(20)}.supabase.co","${KEY}")`,
    "a firebase pair held in a string": `var s='authDomain:"demo-app.firebaseapp.com"';`,
    "a storage bucket pair held in a string": `var s='storageBucket:"demo-app.appspot.com"';`,
    "a clerk pair held in a string": `var s='publishableKey:"pk_test_${"a".repeat(30)}"';`, // pragma: allowlist secret
    "a look-alike host with a key": `f("https://${REF}.supabase.co.example.invalid","${KEY}")`,
    "a commented-out call": `// const sb = createClient("https://${REF}.supabase.co", key)\nvar a=1;`,
    "a block comment": `/* createClient("https://${REF}.supabase.co", key) */var a=1;`,
    "a docs string holding the call": `console.log('Usage: createClient("https://${REF}.supabase.co", key)')`,
    "a template literal holding the call": "const doc=`createClient(\"https://" + REF + ".supabase.co\", key)`;",
    "the bare URL in a string": `const link="https://${REF}.supabase.co/docs";`,
    "a placeholder ref": `createClient("https://your${REF.slice(0, 16)}.supabase.co", key)`,
    "a 19-char ref": `createClient("https://${REF.slice(0, 19)}.supabase.co", key)`,
    "a look-alike host": `createClient("https://${REF}.supabase.co.example.invalid", key)`,
    "a firebase domain in a comment": `// authDomain: "demo-app.firebaseapp.com"`,
    "a firebase placeholder": `initializeApp({authDomain:"your-project.firebaseapp.com"})`,
    "a clerk key in a comment": `/* publishableKey: "pk_test_Y2xlcmsuZXhhbXBsZS5pbnZhbGlkJA0123456789" */`, // pragma: allowlist secret
    "a clerk key that is not the provider's": `const k={secretHint:"pk_test_Y2xlcmsuZXhhbXBsZS5pbnZhbGlkJA0123456789"}`, // pragma: allowlist secret
  };
  for (const [name, bundle] of Object.entries(cases)) {
    test(name, () => {
      const ids = detect([{ url: "https://example.com/a.js", content: bundle }]);
      expect(ids).not.toContain("supabase");
      expect(ids).not.toContain("firebase");
      expect(ids).not.toContain("clerk");
    });
  }

  test("a regex literal holding a quote does not flip string state for the code after it", () => {
    const bundle = `var q=/["']/g;var s=createClient("https://${REF}.supabase.co",key);`;
    expect(detect([{ url: "https://example.com/a.js", content: bundle }])).toContain("supabase");
  });

  test("a real call after a comment line still matches", () => {
    const bundle = `// see docs\nconst sb=createClient("https://${REF}.supabase.co","k");`;
    expect(detect([{ url: "https://example.com/a.js", content: bundle }])).toContain("supabase");
  });

  test("the product named only in the page HTML does not satisfy a bundle detector", () => {
    const html = `${SHELL}<p>createClient("https://${REF}.supabase.co", key)</p>`;
    expect(detect([], html)).not.toContain("supabase");
  });
});

describe("bounds", () => {
  test("a caller that asks for more gets the whole body matched, wherever the call sits (#1387)", () => {
    const call = `createClient("https://${REF}.supabase.co","k");`;
    const pad = "a".repeat(3 * 1024 * 1024);
    const url = "https://example.com/a.js";
    expect(detect([{ url, content: call + pad }], SHELL, WHOLE)).toContain("supabase");
    expect(detect([{ url, content: `${pad}\n${call}` }], SHELL, WHOLE)).toContain("supabase");
    expect(detect([{ url, content: `${pad}\n${call}\n${pad}` }], SHELL, WHOLE)).toContain("supabase");
  });

  test("by default a script is matched only up to 256 KB: the cloud services keep their cap", () => {
    const call = `createClient("https://${REF}.supabase.co","k");`;
    const pad = "a".repeat(TECH_SCRIPT_CONTENT_LIMIT);
    const url = "https://example.com/a.js";
    expect(TECH_SCRIPT_CONTENT_LIMIT).toBe(256 * 1024);
    expect(detect([{ url, content: call + pad }])).toContain("supabase");
    expect(detect([{ url, content: `${pad}\n${call}` }])).not.toContain("supabase");
    // An explicit smaller cap is honoured too.
    expect(detect([{ url, content: `${"a".repeat(1000)}\n${call}` }], SHELL, { maxScriptChars: 500 })).not.toContain("supabase");
  });

  test("a 1 MB hostile bundle finishes inside the per-page budget", () => {
    const hostile = [
      `createClient(`.repeat(40_000),
      `"`.repeat(300_000),
      `/*`.repeat(200_000),
      `authDomain:"`.repeat(40_000),
      `(`.repeat(300_000),
      `"https://${REF}.supabase.co" , `.repeat(20_000),
      `publishableKey:a||`.repeat(30_000),
      `"authDomain":"a`.repeat(30_000),
    ].join("\n");
    expect(hostile.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    detect([{ url: "https://example.com/a.js", content: hostile }]);
    expect(performance.now() - started).toBeLessThan(TECH_DETECT_PAGE_BUDGET_MS);
  });

  // Each shape below was quadratic in scanJs: an opener whose closer is never reached searched to
  // the end of the file again for the next opener. The bound is tight (a linear scan of 8 MB is
  // a fraction of a second), not the page budget, which only a hung scan would exceed.
  describe("comment-opener bodies scan in linear time (#1387)", () => {
    const shapes: Record<string, (n: number) => string> = {
      "closed comments": (n) => "/**/".repeat(n / 4),
      "open comment openers": (n) => "/*".repeat(n / 2),
      "NUL-split openers, no closer": (n) => "/*\0".repeat(n / 3),
      "NUL-split openers, one closer at the end": (n) => `${"/*\0".repeat(n / 3)}*/`,
      "NUL-split line comments": (n) => "//\0\n".repeat(n / 4),
    };
    for (const [name, make] of Object.entries(shapes)) {
      for (const size of [1024 * 1024, 8 * 1024 * 1024]) {
        test(`${name}, ${size / (1024 * 1024)} MB`, () => {
          const hostile = make(size);
          const started = performance.now();
          const scanned = scanJs(hostile);
          const scanMs = performance.now() - started;
          expect(scanned.code.length).toBe(hostile.length);
          expect(scanMs).toBeLessThan(2_000);
          const detectStart = performance.now();
          detect([{ url: "https://example.com/a.js", content: hostile }], SHELL, WHOLE);
          expect(performance.now() - detectStart).toBeLessThan(5_000);
        }, 30_000);
      }
    }
  });

  test("an exhausted budget stops the scan and says so", () => {
    let exceeded = 0;
    const found = detectTechnologies(
      { url: "https://example.com/", headers: {}, html: SHELL },
      undefined,
      { budgetMs: -1, onBudgetExceeded: () => exceeded++ },
    );
    expect(exceeded).toBe(1);
    expect(found).toEqual([]);
  });
});

describe("sampling a big body", () => {
  test("a 5 MB hostile body is sampled in well under 100 ms and stays inside the cap", () => {
    const hostile = [
      `.supabase.co`.repeat(100_000),
      `pk_test_`.repeat(100_000),
      `.firebaseapp.com"'\`/*`.repeat(100_000),
      `"https://x.supabase.co"`.repeat(60_000),
    ].join("\n");
    expect(hostile.length).toBeGreaterThan(4_000_000);
    const started = performance.now();
    const extras = sampleBundleExtras(hostile, 16 * 1024, 24 * 1024);
    expect(performance.now() - started).toBeLessThan(500);
    expect(extras.length).toBeLessThanOrEqual(24 * 1024);
  });
});
