// #1254: in a real bundled SPA the app's own code sits at the END of a large
// file, after the framework it ships with, and a minifier mangles the vendor
// call. These fixtures are built with a real minifying bundler (Bun.build): a
// 300 KB+ block of unrelated code, then the vendor config at the end.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTechInputs, detectReportTechnologiesMulti } from "../src/technologies";

const REF = "abcdefghijklmnopqrst";
// Key-shaped values are assembled at run time so no literal sits in this file.
const JWT = ["eyJ", "x".repeat(60)].join("");
const CLERK_KEY = ["pk_", "test_", "Y2xlcmsuZXhhbXBsZS5pbnZhbGlkJA".repeat(2)].join("");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-1254-build-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Filler: thousands of small distinct functions the entry keeps alive. */
function filler(count: number): string {
  const fns = Array.from(
    { length: count },
    (_, i) =>
      // URLs, quotes, a template literal and a regex literal in every function:
      // string-heavy code, as vendor bundles are, before the app's config.
      `export function f${i}(x){let y=x*${i + 3};const u="https://www.google.com/a/${i}?q='"+y,t=\`//t/\${y}\`,r=/["']\\/\\//.test(u);for(let i=0;i<${(i % 5) + 2};i++)y=(y^${i * 7})+${i % 11}+(r?t.length:u.length);return y}`,
  );
  return `${fns.join("\n")}\nexport const all=[${Array.from({ length: count }, (_, i) => `f${i}`).join(",")}];`;
}

/** Build `appCode` (placed after the filler) into one minified browser bundle. */
async function bundle(name: string, appCode: string): Promise<string> {
  writeFileSync(join(dir, `${name}-filler.js`), filler(3000));
  writeFileSync(
    join(dir, `${name}.js`),
    `import { all } from "./${name}-filler.js";\nglobalThis.__sum = all.reduce((n, f) => n + f(1), 0);\n${appCode}\n`,
  );
  const result = await Bun.build({
    entrypoints: [join(dir, `${name}.js`)],
    outdir: join(dir, `${name}-out`),
    minify: true,
    target: "browser",
  });
  expect(result.success).toBe(true);
  return readFileSync(result.outputs[0]!.path, "utf8");
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

function expectLateConfig(code: string, literal: string): void {
  expect(code.length).toBeGreaterThan(300 * 1024);
  expect(code.indexOf(literal)).toBeGreaterThan(code.length * 0.9);
}

describe("vendor config at the end of a real minified bundle", () => {
  test("Supabase: a mangled client call", async () => {
    const code = await bundle(
      "sb",
      `function mk(u,k){let h=0;for(const c of u+k)h=(h*31+c.charCodeAt(0))|0;return{u,k,h,from:t=>t+h}}
globalThis.__c = mk("https://${REF}.supabase.co","${JWT}");`,
    );
    expect(code).not.toContain("createClient");
    expectLateConfig(code, `${REF}.supabase.co`);
    expect(detect(code)).toContain("supabase");
  });

  test("Supabase: a publishable key and an object config", async () => {
    const code = await bundle(
      "sb2",
      `globalThis.__c = {supabaseUrl:"https://${REF}.supabase.co/",anon:"sb_publishable_${"y".repeat(24)}"};`,
    );
    expectLateConfig(code, `${REF}.supabase.co`);
    expect(detect(code)).toContain("supabase");
  });

  test("Firebase: web app config with quoted and bare keys", async () => {
    const code = await bundle(
      "fb",
      `function init(c){let n=0;for(const k in c)n+=String(c[k]).length;return n}
globalThis.__f = init({"authDomain":"demo-app.firebaseapp.com",projectId:"demo-app",storageBucket:"demo-app.appspot.com"});`,
    );
    expectLateConfig(code, "demo-app.firebaseapp.com");
    expect(detect(code)).toContain("firebase");
  });

  test("Clerk: the publishable key given to the provider", async () => {
    const code = await bundle(
      "ck",
      `function Provider(p){let n=0;for(const k in p)n+=String(p[k]).length;return n}
globalThis.__p = Provider({publishableKey:"${CLERK_KEY}",afterSignOutUrl:"/"});`,
    );
    expectLateConfig(code, CLERK_KEY);
    expect(detect(code)).toContain("clerk");
  });

  test("Clerk: the Next.js inlined env fallback", async () => {
    const code = await bundle(
      "ck2",
      `function Provider(p){return String(p.publishableKey||"").length}
globalThis.__p = Provider({publishableKey: globalThis.__pk || "${CLERK_KEY}"});`,
    );
    // the minifier keeps `publishableKey:globalThis.__pk||"pk_..."`: the property
    // and the literal are one expression, so it reads as the provider's key
    expect(detect(code)).toContain("clerk");
  });

  test("the filler alone detects none of them", async () => {
    const code = await bundle("none", `globalThis.__n = 1;`);
    const ids = detect(code);
    for (const id of ["supabase", "firebase", "clerk"]) expect(ids).not.toContain(id);
  });
});

// A window cut at the wrong place reads the rest of a minified line wrongly, so
// detection must not depend on where the app's config falls in the file.
describe("alignment sweep: string-heavy code before the config", () => {
  const UNIT = `var a="https://www.example.com/x//y",b='it\\'s "q"',c=\`t//\${a}\`,d=/["']\\//g;/* c "x */ // note 'y\n`;
  const REF = "abcdefghijklmnopqrst";
  const apps: Record<string, [string, string]> = {
    firebase: [`var cfg={apiKey:"k",authDomain:"demo-app.firebaseapp.com",projectId:"p"};`, "firebase"],
    clerk: [`var p={publishableKey:"${["pk_", "test_", "Y2xlcmsuZXhhbXBsZS5pbnZhbGlkJA".repeat(2)].join("")}"};`, "clerk"],
    supabase: [`var c=tg("https://${REF}.supabase.co","${["eyJ", "x".repeat(60)].join("")}");`, "supabase"],
  };
  for (const [name, [app, id]] of Object.entries(apps)) {
    test(`${name}: 0..400 chars of offset (81 alignments), every one detects`, () => {
      const base = UNIT.repeat(Math.ceil(90_000 / UNIT.length));
      const misses: number[] = [];
      for (let offset = 0; offset <= 400; offset += 5) {
        const code = base + `var p${"x".repeat(offset)}=1;` + "\n" + app + UNIT.repeat(40);
        if (!detect(code).includes(id)) misses.push(offset);
      }
      expect(misses).toEqual([]);
    });
  }

  test("a config that starts right after a string-heavy line, one char at a time", () => {
    const base = UNIT.repeat(Math.ceil(90_000 / UNIT.length));
    const [app] = apps.firebase!;
    const misses: number[] = [];
    for (let offset = 0; offset < 80; offset++) {
      const code = base + `var p${"x".repeat(offset)}=1;` + "\n" + app + UNIT.repeat(40);
      if (!detect(code).includes("firebase")) misses.push(offset);
    }
    expect(misses).toEqual([]);
  });

  test("clerk with 0..20 decoy pk_test_ fragments spread before the real key", () => {
    const key = ["pk_", "test_", "Y2xlcmsuZXhhbXBsZS5pbnZhbGlkJA".repeat(2)].join("");
    const misses: number[] = [];
    for (let decoys = 0; decoys <= 20; decoys++) {
      let code = UNIT.repeat(Math.ceil(90_000 / UNIT.length));
      for (let i = 0; i < decoys; i++) code += `var id${i}="pk_test_x";` + UNIT.repeat(8);
      code += `var p={publishableKey:"${key}"};` + UNIT.repeat(40);
      if (!detect(code).includes("clerk")) misses.push(decoys);
    }
    expect(misses).toEqual([]);
  });
});
