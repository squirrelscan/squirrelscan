// Prototype-pollution regression suite for every path that turns an untrusted
// document into a JS object: JSON-LD (including nested `@graph`), `.well-known`
// and OpenAPI JSON, sitemap XML, response headers, `<meta>` maps, and the
// TOML config a repo under audit can ship.
//
// Every assertion is on the GLOBAL prototype, not on the returned value: a
// pollution that only shows up as `({}).polluted` is invisible in the parsed
// object, so checking the return value alone would pass against vulnerable code.
//
// Fixtures are built with real `JSON.parse`, never object literals. A literal
// `{ __proto__: {...} }` is spec-special-cased to SET THE PROTOTYPE at
// construction time instead of creating an own property, so a fixture written
// that way cannot reproduce the bug at all and the test would be a false
// negative.

import { clampDetailsRecord } from "@squirrelscan/core-contracts/clamp";
import { isUnsafeObjectKey } from "@squirrelscan/core-contracts/untrusted-keys";
import { varyMatches } from "@squirrelscan/crawler";
import { parseSitemap } from "@squirrelscan/crawler/sitemaps";
import {
  extractOAuthFields,
  sniffJson,
} from "@squirrelscan/crawler/well-known";
import { createFetchDocumentFetcher } from "@squirrelscan/fetchers";
import { flattenJsonLdNodes } from "@squirrelscan/utils/schema-rich-results";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@/config";
import { setConfigValue } from "@/controllers/config";

const CANARY = "polluted";
// Held in a const so the lookups below are computed, not a literal `["__proto__"]`
// member access (which oxlint's no-proto rule rejects on sight).
const PROTO_KEY = "__proto__";

let baselineProtoKeys: string[] = [];

beforeEach(() => {
  baselineProtoKeys = Object.getOwnPropertyNames(Object.prototype);
});

afterEach(() => {
  const added = Object.getOwnPropertyNames(Object.prototype).filter(
    (key) => !baselineProtoKeys.includes(key)
  );
  const canary = (Object.prototype as Record<string, unknown>)[CANARY];
  // Clean up before asserting so one leak can't cascade into every later test.
  for (const key of added)
    delete (Object.prototype as Record<string, unknown>)[key];
  expect(added).toEqual([]);
  expect(canary).toBeUndefined();
  expect(({} as Record<string, unknown>)[CANARY]).toBeUndefined();
});

/** A JSON-LD document whose `@graph` nests the three dangerous keys at every level. */
const HOSTILE_JSONLD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Article", headline: "benign" },
    JSON.parse(`{"@type":"Person","name":"a","__proto__":{"${CANARY}":"yes"}}`),
    JSON.parse(
      `{"@type":"Organization","constructor":{"prototype":{"${CANARY}":"yes"}}}`
    ),
    JSON.parse(`{"@type":"WebSite","prototype":{"${CANARY}":"yes"}}`),
    JSON.parse(
      `{"@graph":[{"@type":"BreadcrumbList","__proto__":{"${CANARY}":"yes"},"itemListElement":[{"@type":"ListItem","constructor":{"prototype":{"${CANARY}":"yes"}}}]}]}`
    ),
  ],
});

const HOSTILE_JSON_DOC = `{"__proto__":{"${CANARY}":"yes"},"constructor":{"prototype":{"${CANARY}":"yes"}},"prototype":{"${CANARY}":"yes"},"registration_endpoint":"https://idp.test/register","client_id_metadata_document_supported":true}`;

describe("prototype pollution — JSON-LD", () => {
  test("flattenJsonLdNodes leaves the global prototype alone for a hostile @graph", () => {
    const nodes = flattenJsonLdNodes(HOSTILE_JSONLD);
    // The nested @graph is walked, so the hostile nodes really were visited.
    expect(nodes.length).toBeGreaterThanOrEqual(6);
  });

  test("flattenJsonLdNodes survives multi-block raw joined by blank lines", () => {
    const raw = `${HOSTILE_JSONLD}\n\n${HOSTILE_JSONLD}`;
    expect(flattenJsonLdNodes(raw).length).toBeGreaterThanOrEqual(6);
  });

  test("parsing a page whose JSON-LD and meta tags are hostile pollutes nothing", async () => {
    const { parsePage } = await import("@squirrelscan/parser");
    const html = `<!doctype html><html><head><title>t</title>
      <script type="application/ld+json">${HOSTILE_JSONLD}</script>
      <meta name="__proto__" content="x"><meta name="constructor" content="y">
      <meta property="prototype" content="z"><meta name="generator" content="WordPress">
      </head><body><h1>h</h1></body></html>`;
    const parsed = parsePage(html, "https://hostile.test/");
    expect(parsed).toBeDefined();
  });
});

describe("prototype pollution — .well-known and OpenAPI JSON", () => {
  test("sniffJson reports the dangerous keys instead of dropping or applying them", () => {
    const result = sniffJson(HOSTILE_JSON_DOC);
    expect(result.valid).toBe(true);
    expect(result.keys).toContain("__proto__");
    expect(result.keys).toContain("constructor");
  });

  test("extractOAuthFields reads real fields past the dangerous keys", () => {
    const fields = extractOAuthFields(HOSTILE_JSON_DOC);
    expect(fields.registrationEndpoint).toBe("https://idp.test/register");
    expect(fields.clientIdMetadataDocumentSupported).toBe(true);
  });
});

describe("prototype pollution — sitemap XML", () => {
  test("a sitemap carrying reserved element names still yields its real URLs or a parse error", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://hostile.test/a</loc></url>
      </urlset>`;
    const clean = parseSitemap(xml, "https://hostile.test/sitemap.xml");
    expect(clean.urls.map((u) => u.loc)).toEqual(["https://hostile.test/a"]);

    // Reserved tag names and attributes must not reach a bracket assignment.
    for (const hostile of [
      `<urlset><__proto__><${CANARY}>yes</${CANARY}></__proto__><url><loc>https://hostile.test/b</loc></url></urlset>`,
      `<urlset><constructor><prototype><${CANARY}>yes</${CANARY}></prototype></constructor><url><loc>https://hostile.test/c</loc></url></urlset>`,
      `<urlset><url __proto__="x" constructor="y"><loc>https://hostile.test/d</loc></url></urlset>`,
    ]) {
      const parsed = parseSitemap(hostile, "https://hostile.test/sitemap.xml");
      // Either the URL survives or the parse is rejected outright; both are
      // acceptable, silently polluting the prototype is not.
      expect(parsed.urls.length + parsed.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("prototype pollution — response headers", () => {
  test("a `__proto__` response header is recorded, not silently swallowed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const headers = new Headers({ "content-type": "text/html" });
        headers.set("__proto__", "hostile-value");
        headers.set("constructor", "hostile-value");
        return new Response("<html><body>ok</body></html>", {
          status: 200,
          headers,
        });
      },
    });

    try {
      const fetcher = createFetchDocumentFetcher();
      const response = await fetcher.fetch({ url: server.url.toString() });
      // The whole point of the null-prototype accumulator: the header survives
      // as an own property instead of vanishing into the inherited setter.
      expect(response.headers[PROTO_KEY]).toBe("hostile-value");
      expect(response.headers["constructor"]).toBe("hostile-value");
    } finally {
      await server.stop(true);
    }
  });

  test("varyMatches compares real headers, not inherited Object.prototype members", () => {
    const stored = JSON.parse('{"accept":"text/html"}') as Record<
      string,
      string
    >;
    const current = JSON.parse('{"accept":"text/html"}') as Record<
      string,
      string
    >;
    // A site can name any header in Vary, so the lookup keys are attacker-chosen.
    // Nothing here is currently mis-decided on a plain `{}` (both sides resolve
    // the same inherited function and compare equal) — this pins the behaviour
    // now that the lookup map has no prototype to fall through to.
    expect(varyMatches("accept, constructor, __proto__", stored, current)).toBe(
      true
    );

    const differing = JSON.parse(
      '{"accept":"text/html","constructor":"x"}'
    ) as Record<string, string>;
    expect(varyMatches("constructor", stored, differing)).toBe(false);
  });
});

describe("prototype pollution — CLI config", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "squirrel-proto-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The schema parse at the end of loadConfig already discards a repointed
  // prototype, so this passes without the deepMerge guard too. It pins the
  // end-to-end guarantee so a future refactor that drops or moves that parse
  // cannot quietly expose the merge.
  test("a hostile squirrel.toml cannot repoint the loaded config's prototype", async () => {
    const configPath = join(dir, "squirrel.toml");
    writeFileSync(
      configPath,
      `[project]\nname = "x"\n\n[__proto__]\n${CANARY} = "yes"\n\n[constructor.prototype]\n${CANARY} = "yes"\n`
    );

    const config = await loadConfig(configPath, { silent: true });
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    expect((config as Record<string, unknown>)[CANARY]).toBeUndefined();
  });

  test("`config set` rejects a dotted key that walks through the prototype", () => {
    const configPath = join(dir, "squirrel.toml");
    writeFileSync(configPath, `[project]\nname = "x"\n`);

    for (const key of [
      "__proto__.polluted",
      "constructor.prototype.polluted",
      "prototype.x",
    ]) {
      const result = setConfigValue(configPath, key, "yes");
      expect(result.ok).toBe(false);
    }

    // A normal nested key still works.
    const ok = setConfigValue(configPath, "project.name", "renamed");
    expect(ok.ok).toBe(true);
  });
});

describe("prototype pollution — clamped check details", () => {
  test("clamping an oversized hostile details record keeps the dangerous key as data", () => {
    const details = JSON.parse(
      `{"__proto__":{"${CANARY}":"yes"},"constructor":{"prototype":{"${CANARY}":"yes"}},"blob":"${"x".repeat(200_000)}"}`
    ) as Record<string, unknown>;
    const clamped = clampDetailsRecord(details);
    expect(clamped).toBeDefined();
  });
});

describe("unsafe key helper", () => {
  test("covers exactly the three keys that reach Object.prototype", () => {
    expect(isUnsafeObjectKey("__proto__")).toBe(true);
    expect(isUnsafeObjectKey("constructor")).toBe(true);
    expect(isUnsafeObjectKey("prototype")).toBe(true);
    expect(isUnsafeObjectKey("toString")).toBe(false);
    expect(isUnsafeObjectKey("project")).toBe(false);
  });
});
