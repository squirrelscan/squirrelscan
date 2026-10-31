// #1379: the real supabase-js, built at test time with a minifying bundler, so
// the library strings detection keys on are the ones a production bundle ships.
// No customer bundle or host: the project ref and keys are synthetic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTechInputs,
  DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
  detectReportTechnologiesMulti,
  LOCAL_TECH_DETECT_OPTIONS,
} from "../src/technologies";

const SUPABASE_JS = Bun.resolveSync("@supabase/supabase-js", import.meta.dir);
const REF = "abcdefghijklmnopqrst";
// Key-shaped values are assembled at run time so no literal sits in this file.
const SECRET_KEY = ["sb_", "secret_", "z".repeat(28)].join("");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-1379-build-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function filler(count: number): string {
  const fns = Array.from(
    { length: count },
    (_, i) =>
      `export function f${i}(x){let y=x*${i + 3};const u="https://www.google.com/a/${i}?q='"+y,t=\`//t/\${y}\`;for(let i=0;i<${(i % 5) + 2};i++)y=(y^${i * 7})+${i % 11}+u.length+t.length;return y}`,
  );
  return `${fns.join("\n")}\nexport const all=[${Array.from({ length: count }, (_, i) => `f${i}`).join(",")}];`;
}

/**
 * The real supabase-js plus `appCode`, minified into one browser bundle. With
 * `fillerFns` the app module sits between two big filler modules, so it is
 * neither in the head nor in the tail of the file. `before` runs ahead of the client.
 */
async function build(name: string, appCode: string, fillerFns = 0, before = ""): Promise<string> {
  writeFileSync(
    join(dir, `${name}-app.js`),
    `${before}\nimport { createClient } from ${JSON.stringify(SUPABASE_JS)};\n${appCode}\n`,
  );
  const lead = fillerFns
    ? `import { all } from "./${name}-filler.js";\nglobalThis.__sum = all.reduce((n, f) => n + f(1), 0);\n`
    : "";
  const tail = fillerFns
    ? `import { all as after } from "./${name}-after.js";\nglobalThis.__sum2 = after.reduce((n, f) => n + f(2), 0);\n`
    : "";
  if (fillerFns) {
    writeFileSync(join(dir, `${name}-filler.js`), filler(fillerFns));
    writeFileSync(join(dir, `${name}-after.js`), filler(fillerFns).replace(/\bf(\d+)\b/g, "g$1"));
  }
  writeFileSync(join(dir, `${name}.js`), `${lead}import "./${name}-app.js";\n${tail}`);
  const result = await Bun.build({
    entrypoints: [join(dir, `${name}.js`)],
    outdir: join(dir, `${name}-out`),
    minify: true,
    target: "browser",
    root: dir,
  });
  expect(result.success).toBe(true);
  return readFileSync(result.outputs[0]!.path, "utf8");
}

/** As the local scan reads it: whole bundle, large script limit. */
function detectLocal(code: string): string[] {
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
    DEFAULT_LOCAL_TECH_BUNDLE_LIMITS,
  );
  return detectReportTechnologiesMulti(inputs, undefined, LOCAL_TECH_DETECT_OPTIONS).items.map(
    (t) => t.id,
  );
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

describe("#1379 the real supabase-js build", () => {
  test("the library strings the signature keys on are in the minified build", async () => {
    const code = await build(
      "lib",
      `globalThis.__c = createClient(globalThis.__u, globalThis.__k);`,
    );
    expect(code).toContain("github.com/orgs/supabase/discussions/");
    expect(code).toMatch(/sb-\$\{[^}]{1,40}\}-auth-token/);
  });

  test("the URL in a variable with the key elsewhere", async () => {
    const code = await build(
      "var",
      `let l="https://${REF}.supabase.co",h=globalThis.__k;globalThis.__c = createClient(l,h);`,
    );
    expect(detect(code)).toContain("supabase");
  });

  test("a new-format secret key beside the URL", async () => {
    const code = await build(
      "sec",
      `const pD="https://${REF}.supabase.co",gD="${SECRET_KEY}";globalThis.__c = createClient(pD,gD);`,
    );
    expect(detect(code)).toContain("supabase");
  });

  test("the URL past the first 256 KB of a 1 MB bundle, default limits", async () => {
    const code = await build(
      "big",
      `let l="https://${REF}.supabase.co";globalThis.__c = createClient(l,globalThis.__k);`,
      7000,
    );
    expect(code.length).toBeGreaterThan(300_000);
    expect(code.indexOf(`${REF}.supabase.co`)).toBeGreaterThan(256 * 1024);
    expect(code.length - code.indexOf(`${REF}.supabase.co`)).toBeGreaterThan(256 * 1024);
    expect(detect(code)).toContain("supabase");
  });

  test("200 identical and 60 distinct earlier placeholder URLs do not hide the real one", async () => {
    const same = Array.from(
      { length: 200 },
      (_, i) => `globalThis.__s${i % 7}="https://your-project.supabase.co";`,
    ).join("\n");
    const distinct = Array.from(
      { length: 60 },
      (_, i) => `globalThis.__d${i}="https://your-project-${i}.supabase.co";`,
    ).join("\n");
    const code = await build(
      "many",
      `let l="https://${REF}.supabase.co";globalThis.__c = createClient(l,globalThis.__k);`,
      7000,
      `${same}\n${distinct}`,
    );
    expect(code.indexOf(`${REF}.supabase.co`)).toBeGreaterThan(256 * 1024);
    expect(code.length - code.indexOf(`${REF}.supabase.co`)).toBeGreaterThan(256 * 1024);
    expect(detect(code)).toContain("supabase");
  });

  test("not detected: the library with no project URL (a runtime-built one)", async () => {
    const code = await build(
      "nourl",
      `globalThis.__c = createClient(globalThis.__u, globalThis.__k);`,
    );
    expect(detect(code)).not.toContain("supabase");
  });

  test("not detected: the library with a placeholder URL only", async () => {
    const code = await build(
      "ph",
      `globalThis.__c = createClient("https://your-project.supabase.co", globalThis.__k);`,
    );
    expect(detect(code)).not.toContain("supabase");
  });

  // supabase-js quotes "Sentry.init()" in prose, past 64 KB of the bundle. Reading whole bundles
  // (#1387) must not turn that into a Sentry detection.
  test("a whole supabase-js bundle is not Sentry", async () => {
    const code = await build(
      "nosentry",
      `globalThis.__c = createClient(globalThis.__u, globalThis.__k);`,
    );
    expect(code).toContain("Sentry.init");
    expect(detectLocal(code)).not.toContain("sentry");
  });

  test("a real Sentry init call and the SDK's own log prefix are still Sentry", async () => {
    expect(
      detectLocal(
        `${"var a=1;\n".repeat(50_000)}Sentry.init({dsn:"https://k@o1.ingest.sentry.io/2"});`,
      ),
    ).toContain("sentry");
    expect(
      detectLocal(
        `${"var a=1;\n".repeat(50_000)}console.warn("[Sentry] Sentry.init() was called more than once");`,
      ),
    ).toContain("sentry");
    expect(
      detectLocal(`${"var a=1;\n".repeat(10)}// docs say call Sentry.init() once`),
    ).not.toContain("sentry");
  });
});
