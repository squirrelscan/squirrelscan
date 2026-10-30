// #1379: the real supabase-js, built at test time with a minifying bundler, so
// the library strings detection keys on are the ones a production bundle ships.
// No customer bundle or host: the project ref and keys are synthetic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTechInputs, detectReportTechnologiesMulti } from "../src/technologies";

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

/** The real supabase-js plus `appCode`, minified into one browser bundle. `before` runs ahead of the client. */
async function build(name: string, appCode: string, fillerFns = 0, before = ""): Promise<string> {
  const lead = fillerFns
    ? `import { all } from "./${name}-filler.js";\nglobalThis.__sum = all.reduce((n, f) => n + f(1), 0);\n`
    : "";
  if (fillerFns) writeFileSync(join(dir, `${name}-filler.js`), filler(fillerFns));
  writeFileSync(
    join(dir, `${name}.js`),
    `${lead}${before}\nimport { createClient } from ${JSON.stringify(SUPABASE_JS)};\n${appCode}\n`,
  );
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
    const code = await build("lib", `globalThis.__c = createClient(globalThis.__u, globalThis.__k);`);
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
    expect(detect(code)).toContain("supabase");
  });

  test("dozens of earlier quoted placeholder URLs do not hide the real one", async () => {
    const earlier = Array.from({ length: 40 }, (_, i) => `globalThis.__p${i}="https://your-project.supabase.co";`).join("\n");
    const code = await build(
      "many",
      `let l="https://${REF}.supabase.co";globalThis.__c = createClient(l,globalThis.__k);`,
      7000,
      earlier,
    );
    expect(code.indexOf(`${REF}.supabase.co`)).toBeGreaterThan(256 * 1024);
    expect(detect(code)).toContain("supabase");
  });

  test("not detected: the library with no project URL (a runtime-built one)", async () => {
    const code = await build("nourl", `globalThis.__c = createClient(globalThis.__u, globalThis.__k);`);
    expect(detect(code)).not.toContain("supabase");
  });

  test("not detected: the library with a placeholder URL only", async () => {
    const code = await build(
      "ph",
      `globalThis.__c = createClient("https://your-project.supabase.co", globalThis.__k);`,
    );
    expect(detect(code)).not.toContain("supabase");
  });
});
