// #1756 end to end over real HTTP: the real asset phase fetches same-site linked stylesheets and the real
// a11y/color-contrast rule reads the html/body background they set. A light background warns with the
// measured ratio, a dark one does not, and a stylesheet that cannot be read keeps the pair unresolved.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parseDocument } from "@squirrelscan/parser";
import { colorContrastRule } from "@squirrelscan/rules";

import {
  absorbResourceOccurrences,
  emptySiteAssetOccurrences,
  fetchAssetsFromOccurrences,
} from "../src/adapter";

type Storage = Parameters<typeof fetchAssetsFromOccurrences>[0];
type Config = Parameters<typeof fetchAssetsFromOccurrences>[3];
type ParsedPage = Parameters<typeof absorbResourceOccurrences>[1][number]["parsed"];

function storageFor(siteBase: string): Storage {
  return {
    getCrawl: () => Effect.succeed({ baseUrl: siteBase }),
    getSitemaps: () => Effect.succeed([]),
    getCachedResources: () => Effect.succeed([]),
    getRobotsTxt: () => Effect.succeed(null),
  } as unknown as Storage;
}

const CONFIG = { rules: { enable: ["*"], disable: [] } } as unknown as Config;
const CSS = { "content-type": "text/css" };

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/light.css") return new Response("body { margin: 0; background: #ffffff; }", { headers: CSS });
      if (pathname === "/dark.css") return new Response("body { background-color: #111111 }", { headers: CSS });
      if (pathname === "/plain.css") return new Response("p { margin: 0 }", { headers: CSS });
      if (pathname === "/dark-mode.css") {
        return new Response(
          "body { background: #fff } @media (prefers-color-scheme: dark) { body { background: #000 } }",
          { headers: CSS },
        );
      }
      if (pathname === "/hero.css") {
        return new Response("body { background: #ffffff } .hero { background: #111111; padding: 2rem }", { headers: CSS });
      }
      if (pathname === "/boom.css") return new Response("boom", { status: 500 });
      if (pathname === "/soft404.css") {
        return new Response("<html>not found</html>", { headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const TAGLINE = '<p style="color:#b9b9b9">Fresh roasted every morning</p>';

async function contrastFor(
  links: string[],
  config: Config = CONFIG,
  body: string = TAGLINE,
): Promise<CheckResult[]> {
  const url = `${base}/`;
  const markup = `<!doctype html><html><head><title>x</title>${links
    .map((l) => `<link rel="stylesheet" href="${l}">`)
    .join("")}</head><body>${body}</body></html>`;
  const document = parseDocument(markup);
  const occurrences = emptySiteAssetOccurrences();
  absorbResourceOccurrences(
    occurrences,
    [{ url, finalUrl: url, parsed: { document, images: [] } as unknown as ParsedPage, hasCsp: false }],
    base,
  );
  occurrences.pageCount = 1;
  const assets = await Effect.runPromise(
    fetchAssetsFromOccurrences(storageFor(base), "fixture-crawl", occurrences, config, undefined),
  );
  return colorContrastRule.run({
    page: { url, html: markup, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as never,
    site: {
      baseUrl: base,
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      stylesheetBackgrounds: assets.stylesheetBackgrounds,
    },
    options: {},
  }).checks as CheckResult[];
}

const named = (checks: CheckResult[], name: string) => checks.filter((c) => c.name === name);

describe("a11y/color-contrast reads same-site linked stylesheets (#1756)", () => {
  test("light text on a linked light body background warns with the measured ratio", async () => {
    const checks = await contrastFor(["/light.css"]);
    const warn = named(checks, "color-contrast").find((c) => c.status === "warn");
    expect(warn?.items?.[0]?.id).toContain("#b9b9b9 on #ffffff (1.9");
    expect(named(checks, "color-contrast-unresolved")).toHaveLength(0);
  });

  test("a dark body background does not warn for light inline text", async () => {
    const checks = await contrastFor(["/dark.css"]);
    expect(named(checks, "color-contrast").map((c) => c.status)).toEqual(["pass"]);
    expect(named(checks, "color-contrast-unresolved")).toHaveLength(0);
  });

  test("a linked stylesheet with no page background keeps the white default", async () => {
    const checks = await contrastFor(["/plain.css"]);
    expect(named(checks, "color-contrast").some((c) => c.status === "warn")).toBe(true);
  });

  test("light text inside a container a linked sheet paints dark is unresolved, not a warning", async () => {
    // body is light in the same sheet, so measured against the page it would warn: the .hero rule says why not.
    const inside = await contrastFor(["/hero.css"], CONFIG, `<div class="hero"><section>${TAGLINE}</section></div>`);
    expect(named(inside, "color-contrast").some((c) => c.status === "warn")).toBe(false);
    expect(named(inside, "color-contrast-unresolved")).toHaveLength(1);
    // The same sheet and the same text outside the container is still measured against the light body.
    const outside = await contrastFor(["/hero.css"], CONFIG, `<div class="hero"><p>Title</p></div>${TAGLINE}`);
    expect(named(outside, "color-contrast").some((c) => c.status === "warn")).toBe(true);
  });

  test("a stylesheet that fails to load keeps the pair unresolved, never white", async () => {
    for (const href of ["/boom.css", "/missing.css", "/soft404.css"]) {
      const checks = await contrastFor([href]);
      expect(named(checks, "color-contrast").some((c) => c.status === "warn")).toBe(false);
      expect(named(checks, "color-contrast-unresolved")).toHaveLength(1);
    }
  });

  test("one unread stylesheet among readable ones keeps the pair unresolved", async () => {
    const checks = await contrastFor(["/light.css", "/boom.css"]);
    expect(named(checks, "color-contrast").some((c) => c.status === "warn")).toBe(false);
    expect(named(checks, "color-contrast-unresolved")).toHaveLength(1);
  });

  test("a prefers-color-scheme override of the body background is unresolved", async () => {
    const checks = await contrastFor(["/dark-mode.css"]);
    expect(named(checks, "color-contrast").some((c) => c.status === "warn")).toBe(false);
    expect(named(checks, "color-contrast-unresolved")).toHaveLength(1);
  });

  test("a stylesheet on another site is not fetched and stays unresolved", async () => {
    const checks = await contrastFor(["https://cdn.invalid/theme.css"]);
    expect(named(checks, "color-contrast-unresolved")).toHaveLength(1);
  });

  test("with the rule disabled no stylesheet is requested", async () => {
    const config = { rules: { enable: ["*"], disable: ["a11y/color-contrast"] } } as unknown as Config;
    const url = `${base}/`;
    const document = parseDocument(`<html><head><link rel="stylesheet" href="/light.css"></head><body></body></html>`);
    const occurrences = emptySiteAssetOccurrences();
    absorbResourceOccurrences(
      occurrences,
      [{ url, finalUrl: url, parsed: { document, images: [] } as unknown as ParsedPage, hasCsp: false }],
      base,
    );
    occurrences.pageCount = 1;
    const assets = await Effect.runPromise(
      fetchAssetsFromOccurrences(storageFor(base), "fixture-crawl", occurrences, config, undefined),
    );
    expect(assets.stylesheetBackgrounds).toBeUndefined();
  });
});
