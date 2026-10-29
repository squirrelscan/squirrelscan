// #1254: the libraries of a Vite or Next.js app live in its bundles, not its
// near-empty HTML shell. Detection reads the first 64 KB of each first-party
// bundle, and the `inCode` detectors only count a real call or config in code,
// never a comment, a string, or a placeholder.

import { describe, expect, test } from "bun:test";

import {
  detectTechnologies,
  TECH_DETECT_PAGE_BUDGET_MS,
  TECH_SCRIPT_CONTENT_LIMIT,
} from "../src";

const SHELL = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script type="module" src="/assets/index-a1b2c3.js"></script></body></html>`;
const REF = "abcdefghijklmnopqrst"; // 20 chars, a project ref shape

function detect(scripts: Array<{ url: string; content?: string }>, html = SHELL): string[] {
  return detectTechnologies({ url: "https://example.com/", headers: {}, html, scripts }).map(
    (t) => t.id,
  );
}

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

describe("near misses do not match", () => {
  const cases: Record<string, string> = {
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
  test("only the first 64 KB of a bundle is matched", () => {
    const call = `createClient("https://${REF}.supabase.co","k");`;
    const early = call + "a".repeat(TECH_SCRIPT_CONTENT_LIMIT);
    const late = "a".repeat(TECH_SCRIPT_CONTENT_LIMIT) + call;
    expect(detect([{ url: "https://example.com/a.js", content: early }])).toContain("supabase");
    expect(detect([{ url: "https://example.com/a.js", content: late }])).not.toContain("supabase");
  });

  test("a 1 MB hostile bundle finishes inside the per-page budget", () => {
    const hostile = [
      `createClient(`.repeat(40_000),
      `"`.repeat(300_000),
      `/*`.repeat(200_000),
      `authDomain:"`.repeat(40_000),
      `(`.repeat(300_000),
    ].join("\n");
    expect(hostile.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    detect([{ url: "https://example.com/a.js", content: hostile }]);
    expect(performance.now() - started).toBeLessThan(TECH_DETECT_PAGE_BUDGET_MS);
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
