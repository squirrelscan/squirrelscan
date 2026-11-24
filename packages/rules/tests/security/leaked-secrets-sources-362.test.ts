// #362: the places a repository scanner cannot see. A key in an HTML comment
// reports at `html-comment`; in a framework's server-side data payload at
// `framework-payload`, naming the framework; in a same-origin source map's
// original sources at `source-map (<map url>)`; in a same-origin config a
// bundle fetches at `config-endpoint (<url>)`. The planner that tells the
// engine what to fetch never names a cross-origin URL and never more than 10.

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type {
  RuleContext,
  RuleResult,
  SecretSourceData,
} from "../../src/types";

import {
  leakedSecretsRule,
  scanPageForSecrets,
} from "../../src/security/leaked-secrets";
import {
  configEndpointUrlsOf,
  planSecretSources,
  sourceMapSources,
  sourceMapUrlOf,
} from "../../src/security/secrets/sources";
import { runOf, seededRng } from "./leaked-secrets/generators";

const ORIGIN = "https://app.acme.test";
const PAGE = `${ORIGIN}/dashboard`;
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const rng = seededRng(362);
/** A Stripe live secret key shape, assembled at runtime: server-only, so critical wherever the browser can read it. */
const stripeKey = () => ["s", "k_li", "ve_"].join("") + runOf(rng, ALNUM, 24);

const page = (body: string) =>
  `<!DOCTYPE html><html><head><title>Acme</title></head><body><main><h1>Hi</h1>${body}</main></body></html>`;

function ctxFor(
  html: string,
  secretSources: SecretSourceData[] = []
): RuleContext {
  return {
    site: {
      baseUrl: ORIGIN,
      pages: [{ url: PAGE, statusCode: 200, parsed: parsePage(html, PAGE) }],
      robotsTxt: null,
      sitemaps: null,
      scripts: [],
      secretSources,
    },
    options: {},
  } as unknown as RuleContext;
}

async function items(ctx: RuleContext) {
  const { checks } = (await leakedSecretsRule.run(ctx)) as RuleResult;
  return checks.flatMap((c) =>
    (c.items ?? []).map((i) => ({
      check: c.name,
      label: i.label ?? "",
      meta: i.meta,
    }))
  );
}

const source = (
  kind: SecretSourceData["kind"],
  url: string,
  content: string,
  contentType = "application/json"
): SecretSourceData => ({
  kind,
  url,
  referencedBy: `${ORIGIN}/static/app.js`,
  sourcePages: [PAGE],
  status: 200,
  error: null,
  contentType,
  content,
});

describe("html-comment (#362)", () => {
  test("a key inside an HTML comment reports at html-comment, once", async () => {
    const key = stripeKey();
    const got = await items(
      ctxFor(page(`<!-- deploy note: STRIPE_KEY=${key} -->`))
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.label).toBe(`Found in html-comment (${PAGE})`);
    // Not browser-served code: the HTML tier, not critical.
    expect(got[0]!.check).toBe("leaked-secrets-high");
  });

  test("the same page outside a comment still reports at html", async () => {
    const key = stripeKey();
    const got = await items(ctxFor(page(`<pre>STRIPE_KEY=${key}</pre>`)));
    expect(got.map((g) => g.label)).toEqual([`Found in html (${PAGE})`]);
  });

  test("the HTML pass no longer reads the comment's text", () => {
    const key = stripeKey();
    const doc = parsePage(page(`<!-- STRIPE_KEY=${key} -->`), PAGE).document!;
    expect(scanPageForSecrets(doc, PAGE).map((f) => f.location)).toEqual([
      "html-comment",
    ]);
  });
});

describe("framework-payload (#362)", () => {
  const cases: Array<[string, (key: string) => string, string]> = [
    [
      "Next.js",
      (k) =>
        `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"stripeKey":"${k}"}},"page":"/"}</script>`,
      "__NEXT_DATA__",
    ],
    [
      "Nuxt",
      (k) =>
        `<script>window.__NUXT__={state:{},config:{public:{stripeKey:"${k}"}}};</script>`,
      "__NUXT__",
    ],
    [
      "Nuxt",
      (k) =>
        `<script type="application/json" id="__NUXT_DATA__">[{"stripeKey":"${k}"}]</script>`,
      "__NUXT__",
    ],
    [
      "Remix",
      (k) =>
        `<script>window.__remixContext = {"state":{"loaderData":{"root":{"stripeKey":"${k}"}}}};</script>`,
      "__remixContext",
    ],
    [
      "SvelteKit",
      (k) =>
        `<script>__sveltekit_1x2y3z = {base: ""};const data = [{type:"data",data:{stripeKey:"${k}"}}];</script>`,
      "__sveltekit_*",
    ],
  ];
  for (const [name, build, payload] of cases) {
    test(`${name} ${payload}: framework-payload, framework named`, async () => {
      const got = await items(ctxFor(page(build(stripeKey()))));
      expect(got).toHaveLength(1);
      expect(
        got[0]!.label.startsWith(`Found in framework-payload (${PAGE})`)
      ).toBe(true);
      expect(got[0]!.label).toContain(`the ${name} ${payload} payload`);
      expect(got[0]!.meta?.framework).toBe(name);
      // Shipped to every visitor: a server-only key there is critical.
      expect(got[0]!.check).toBe("leaked-secrets-critical");
    });
  }

  test("an ordinary inline script stays inline-script", async () => {
    const got = await items(
      ctxFor(page(`<script>window.APP={stripeKey:"${stripeKey()}"};</script>`))
    );
    expect(got.map((g) => g.label)).toEqual([
      `Found in inline-script (${PAGE})`,
    ]);
  });
});

describe("source-map and config-endpoint (#362)", () => {
  const MAP = `${ORIGIN}/static/app.js.map`;
  const CONFIG = `${ORIGIN}/config.json`;

  test("a key in a source map's sourcesContent reports at source-map (<map url>)", async () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["webpack://app/./src/env.ts"],
      sourcesContent: [`export const stripeKey = "${stripeKey()}";\n`],
      mappings: "AAAA",
    });
    const got = await items(ctxFor(page(""), [source("source-map", MAP, map)]));
    expect(got.map((g) => g.label)).toEqual([`Found in source-map (${MAP})`]);
    expect(got[0]!.check).toBe("leaked-secrets-critical");
  });

  test("sources under node_modules are not read", async () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["webpack://app/./node_modules/sdk/fixtures.js"],
      sourcesContent: [`export const stripeKey = "${stripeKey()}";\n`],
      mappings: "AAAA",
    });
    const got = await items(ctxFor(page(""), [source("source-map", MAP, map)]));
    expect(got).toEqual([]);
  });

  test("a key in a same-origin config reports at config-endpoint (<url>)", async () => {
    const got = await items(
      ctxFor(page(""), [
        source("config-endpoint", CONFIG, `{"stripeKey":"${stripeKey()}"}`),
      ])
    );
    expect(got.map((g) => g.label)).toEqual([
      `Found in config-endpoint (${CONFIG})`,
    ]);
  });

  test("a single-page app's HTML shell answering the config path is not read", async () => {
    const got = await items(
      ctxFor(page(""), [
        source(
          "config-endpoint",
          CONFIG,
          `<!doctype html><html><body><script>var stripeKey="${stripeKey()}"</script></body></html>`,
          "text/html"
        ),
      ])
    );
    expect(got).toEqual([]);
  });

  test("an unread source contributes nothing and does not block the clean pass", async () => {
    const { checks } = (await leakedSecretsRule.run(
      ctxFor(page(""), [
        { ...source("source-map", MAP, ""), status: 404, content: null },
      ])
    )) as RuleResult;
    expect(checks.map((c) => c.name)).toEqual(["leaked-secrets"]);
  });
});

describe("planSecretSources (#362)", () => {
  const script = (name: string, content: string, sourceMapHeader?: string) => ({
    url: `${ORIGIN}/static/${name}`,
    content,
    sourcePages: [PAGE],
    ...(sourceMapHeader !== undefined ? { sourceMapHeader } : {}),
  });

  test("a relative map comment resolves against the script", () => {
    expect(
      sourceMapUrlOf(script("a.js", "x();\n//# sourceMappingURL=a.js.map\n"))
    ).toBe(`${ORIGIN}/static/a.js.map`);
  });

  test("the SourceMap header wins over the comment", () => {
    expect(
      sourceMapUrlOf(
        script("a.js", "x();\n//# sourceMappingURL=a.js.map\n", "/maps/a.map")
      )
    ).toBe(`${ORIGIN}/maps/a.map`);
  });

  test("cross-origin and inline maps are never planned", () => {
    expect(
      sourceMapUrlOf(
        script(
          "a.js",
          "x();\n//# sourceMappingURL=https://cdn.other.test/a.js.map\n"
        )
      )
    ).toBeNull();
    expect(
      sourceMapUrlOf(script("a.js", "x();", "https://cdn.other.test/a.js.map"))
    ).toBeNull();
    expect(
      sourceMapUrlOf(
        script(
          "a.js",
          "x();\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n"
        )
      )
    ).toBeNull();
  });

  test("config literals: same-origin config, env, api and well-known paths only", () => {
    const urls = configEndpointUrlsOf(
      script(
        "boot.js",
        [
          `fetch("/config.json")`,
          `fetch('/env.js')`,
          "fetch(`/api/config`)",
          `fetch("/.well-known/app-settings")`,
          `fetch("${ORIGIN}/assets/runtime-config.json?v=3")`,
          `fetch("https://cdn.other.test/config.json")`,
          "fetch(`${base}/config.json`)",
          `fetch("/products.json")`,
        ].join(";")
      )
    );
    expect(urls).toEqual([
      `${ORIGIN}/config.json`,
      `${ORIGIN}/env.js`,
      `${ORIGIN}/api/config`,
      `${ORIGIN}/.well-known/app-settings`,
      `${ORIGIN}/assets/runtime-config.json`,
    ]);
  });

  test("a config literal's query never reaches a planned URL, so a key in it never reaches a label", () => {
    const key = stripeKey();
    const scripts = [script("boot.js", `fetch("/config.json?key=${key}")`)];
    expect(configEndpointUrlsOf(scripts[0]!)).toEqual([
      `${ORIGIN}/config.json`,
    ]);
    const { targets } = planSecretSources(scripts);
    expect(targets.map((t) => t.url)).toEqual([`${ORIGIN}/config.json`]);
    expect(JSON.stringify(targets)).not.toContain(key);
  });

  test("a same-origin map URL carrying credentials is never planned", () => {
    expect(
      sourceMapUrlOf(
        script("a.js", "x();", "https://deploy:hunter2@app.acme.test/a.js.map")
      )
    ).toBeNull();
  });

  test("a map URL's query never reaches a planned URL, from the comment or the header", () => {
    const key = stripeKey();
    const fromComment = script(
      "a.js",
      `x();\n//# sourceMappingURL=a.js.map?token=${key}\n`
    );
    const fromHeader = script("b.js", "x();", `/b.js.map?sig=${key}`);
    expect(sourceMapUrlOf(fromComment)).toBe(`${ORIGIN}/static/a.js.map`);
    expect(sourceMapUrlOf(fromHeader)).toBe(`${ORIGIN}/b.js.map`);
    const { targets } = planSecretSources([fromComment, fromHeader]);
    expect(targets.map((t) => t.url)).toEqual([
      `${ORIGIN}/static/a.js.map`,
      `${ORIGIN}/b.js.map`,
    ]);
    expect(JSON.stringify(targets)).not.toContain(key);
  });

  test("at most 10 targets, the two kinds taken in turn, the rest counted", () => {
    const scripts = Array.from({ length: 8 }, (_, i) =>
      script(
        `s${i}.js`,
        `fetch("/c${i}/config.json");\n//# sourceMappingURL=s${i}.js.map\n`
      )
    );
    const { targets, total } = planSecretSources(scripts);
    expect(targets).toHaveLength(10);
    expect(total).toBe(16);
    expect(targets.map((t) => t.kind).slice(0, 4)).toEqual([
      "source-map",
      "config-endpoint",
      "source-map",
      "config-endpoint",
    ]);
    // A larger cap asked for is still held to 10.
    expect(planSecretSources(scripts, 50).targets).toHaveLength(10);
  });

  test("a URL two scripts name is one target with both scripts' pages", () => {
    const { targets } = planSecretSources([
      { ...script("a.js", `fetch("/config.json")`), sourcePages: [PAGE] },
      {
        ...script("b.js", `fetch("/config.json")`),
        sourcePages: [`${ORIGIN}/other`],
      },
    ]);
    expect(targets).toEqual([
      {
        kind: "config-endpoint",
        url: `${ORIGIN}/config.json`,
        referencedBy: `${ORIGIN}/static/a.js`,
        sourcePages: [PAGE, `${ORIGIN}/other`],
      },
    ]);
  });
});

describe("sourceMapSources (#362)", () => {
  test("reads sourcesContent, and each section of an indexed map", () => {
    expect(
      sourceMapSources(
        JSON.stringify({
          version: 3,
          sections: [
            {
              offset: { line: 0, column: 0 },
              map: { version: 3, sources: ["a.ts"], sourcesContent: ["A"] },
            },
            {
              offset: { line: 9, column: 0 },
              map: { version: 3, sources: ["b.ts"], sourcesContent: ["B"] },
            },
          ],
        })
      )
    ).toEqual(["A", "B"]);
  });

  test("not a source map: null", () => {
    expect(sourceMapSources("<html></html>")).toBeNull();
    expect(sourceMapSources('{"name":"pkg"}')).toBeNull();
  });
});
