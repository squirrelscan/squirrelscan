// #1379: Supabase in real production bundles. The project URL may sit in a
// variable with the key in another chunk, the key may be a new-format secret
// key, and the URL may sit far past the head of a big bundle. A bundle that ships
// supabase-js (its own strings) and quotes a project URL anywhere is Supabase.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "@squirrelscan/tech-detect";

import { buildTechInputs, detectReportTechnologiesMulti } from "../src/technologies";

const REF = "abcdefghijklmnopqrst";
// Key-shaped values are assembled at run time so no literal sits in this file.
const SECRET_KEY = ["sb_", "secret_", "z".repeat(28)].join("");
const PUBLISHABLE_KEY = ["sb_", "publishable_", "y".repeat(28)].join("");
const JWT = ["eyJ", "x".repeat(60)].join("");

// supabase-js's own strings, minified as a production build ships them.
const NOTICE = `console.warn("\\u26A0\\uFE0F  Node.js 18 and below are deprecated and will no longer be supported in future versions of @supabase/supabase-js. Please upgrade to Node.js 20 or later. For more information, visit: https://github.com/orgs/supabase/discussions/37217")`;
const STORAGE_KEY = "const k=e=>`sb-${new URL(e).hostname.split(\".\")[0]}-auth-token`;";

/** Minified-looking filler: string-heavy code with no vendor signal. */
function filler(bytes: number): string {
  const unit = `function f(x){let y=x*3;const u="https://www.example.com/a/"+y,t=\`//t/\${y}\`;return u.length+t.length}\n`;
  return unit.repeat(Math.ceil(bytes / unit.length));
}

function detect(code: string): string[] {
  const url = "https://example.com/assets/index-1.js";
  const inputs = buildTechInputs(
    [
      {
        url: "https://example.com/",
        headers: {},
        html: `<!doctype html><div id="root"></div><script type="module" src="/assets/index-1.js"></script>`,
      },
    ],
    [{ url, content: code, sourcePages: ["https://example.com/"] }],
  );
  return detectReportTechnologiesMulti(inputs).items.map((t) => t.id);
}

describe("#1379 supabase-js signature plus a quoted project URL", () => {
  test("the URL in a variable, no key beside it, the library notice elsewhere", () => {
    const code = `${filler(30_000)}${NOTICE};${filler(30_000)}let l="https://${REF}.supabase.co",h=g(l);${filler(30_000)}`;
    expect(detect(code)).toContain("supabase");
  });

  test("the sb- auth storage key template is a signature too", () => {
    const code = `${filler(20_000)}${STORAGE_KEY}${filler(20_000)}var u='https://${REF}.supabase.co/';${filler(1_000)}`;
    expect(detect(code)).toContain("supabase");
  });

  test("a URL and a notice well past the head of a 1 MB bundle, default limits", () => {
    const head = filler(150_000);
    const code = `${head}${NOTICE};${filler(250_000)}let l="https://${REF}.supabase.co",h=g(l);${filler(600_000)}`;
    expect(code.length).toBeGreaterThan(1_000_000);
    expect(code.indexOf(`${REF}.supabase.co`)).toBeGreaterThan(400_000);
    expect(detect(code)).toContain("supabase");
  });

  test("the notice far from the URL, both past the head of a big bundle", () => {
    const code = `${filler(300_000)}let l="https://${REF}.supabase.co";${filler(300_000)}${NOTICE};${filler(300_000)}`;
    expect(detect(code)).toContain("supabase");
  });

  test("not detected: library strings and no project URL", () => {
    expect(detect(`${filler(20_000)}${NOTICE};${STORAGE_KEY}${filler(20_000)}`)).not.toContain("supabase");
  });

  test("not detected: a project URL and no library signature", () => {
    expect(detect(`${filler(20_000)}let l="https://${REF}.supabase.co";${filler(20_000)}`)).not.toContain("supabase");
  });

  test("not detected: a docs link and a placeholder URL", () => {
    const code = `${filler(10_000)}${NOTICE};let a="https://your-project.supabase.co",b="https://yourprojectyourproject.supabase.co",c="see https://${REF}.supabase.co/docs";${filler(10_000)}`;
    expect(detect(code)).not.toContain("supabase");
  });
});

describe("#1379 key formats beside the project URL", () => {
  for (const [label, key] of [
    ["a secret key", SECRET_KEY],
    ["a publishable key", PUBLISHABLE_KEY],
    ["a JWT key", JWT],
  ] as const) {
    test(label, () => {
      const code = `${filler(5_000)}const pD="https://${REF}.supabase.co",gD="${key}",Cf=hD(pD,gD);${filler(5_000)}`;
      expect(detect(code)).toContain("supabase");
    });
  }
});

describe("#1379 Base44", () => {
  test("a Base44 app's shared Supabase backend is not reported as Supabase", () => {
    const code = `${NOTICE};let l="https://${REF}.supabase.co";`;
    const found = detectTechnologies({
      url: "https://my-tool.base44.app/",
      headers: {},
      html: "<div id=root></div>",
      scripts: [{ url: "https://my-tool.base44.app/a.js", content: code }],
    }).map((t) => t.id);
    expect(found).toContain("base44");
    expect(found).not.toContain("supabase");
  });
});
