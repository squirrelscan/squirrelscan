// A 200 page carrying a framework error-shell marker is a soft-404 confirm
// candidate in BOTH engines (#235). The streamed engine releases each page's DOM
// before candidates are picked, so it can only see the marker if it was captured
// as a scalar while the document was live.
//
// Hermetic: the confirm pass runs with `enabled: false`, which still selects
// every candidate and annotates it `unconfirmed` but does no network. Selection
// is what is observed: a selected page carries a verdict on its retained parse,
// an unselected one carries none.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { hasErrorShellMarker, parsePage } from "@squirrelscan/parser";
import type { Config } from "@squirrelscan/config";
import type { PageRecord, ResponseHeaders, SecurityHeaders } from "@squirrelscan/core-contracts";

import {
  buildSiteContext,
  parseHtmlForRules,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

const CONFIG = {
  rule_options: {},
  rules: { enable: ["*"] },
  integrity: { soft404_confirm: { enabled: false } },
} as unknown as Config;

const ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const SHELL_URL = "http://synthetic.test/gone";
// The issue's repro: a root `__next_error__` id and only a few words, so the
// error-shell signal is what makes it a candidate (tiny content is supporting).
const SHELL_HTML = `<!doctype html><html id="__next_error__"><head><title>Acme Store</title></head>
<body><h1>Acme Store</h1><p>Just a few words here.</p></body></html>`;
// Negative control: the same tiny page without the marker has only the
// supporting tiny-content signal, so it is not a candidate.
const CONTROL_URL = "http://synthetic.test/tiny";
const CONTROL_HTML = `<!doctype html><html><head><title>Acme Store</title></head>
<body><h1>Acme Store</h1><p>Just a few words here.</p></body></html>`;

const HEADERS = {
  contentType: null,
  contentEncoding: null,
  cacheControl: null,
  vary: null,
  etag: null,
  server: null,
  lastModified: null,
  link: null,
  serverTiming: null,
  age: null,
  xCache: null,
  cfCacheStatus: null,
  xVercelCache: null,
  altSvc: null,
  acceptRanges: null,
} as ResponseHeaders;
const SECURITY = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
} as SecurityHeaders;

function htmlPage(url: string, html: string, parsedData: string | null = null): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: Buffer.byteLength(html, "utf8"),
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "inj",
    html,
    parsedData,
    headers: HEADERS,
    securityHeaders: SECURITY,
  };
}

async function crawl() {
  const model = generateSiteModel({ seed: 21, pageCount: 20 });
  const made = await writeCrawlToStorage(model, ":memory:");
  await run(made.storage.upsertPage(made.crawlId, htmlPage(SHELL_URL, SHELL_HTML)));
  await run(made.storage.upsertPage(made.crawlId, htmlPage(CONTROL_URL, CONTROL_HTML)));
  return made;
}

const T = 30_000;

describe("error-shell soft-404 candidates, v1 and streaming (#235)", () => {
  test("both engines select the error-shell page and not the unmarked control", async () => {
    const { storage, crawlId } = await crawl();

    const v1 = await run(
      runRulesOnStorage(
        storage,
        crawlId,
        await run(buildSiteContext(await run(storage.getPages(crawlId)))),
        CONFIG,
        ASSETS,
      ),
    );
    const v2 = await run(
      runStreamingRules(storage, crawlId, CONFIG, ASSETS, undefined, { batchSize: 4 }),
    );

    for (const result of [v1, v2]) {
      expect(result.parsedPages.get(SHELL_URL)?.soft404Confirmation).toBe("unconfirmed");
      expect(result.parsedPages.get(CONTROL_URL)?.soft404Confirmation).toBeUndefined();
    }

    await run(storage.close());
  }, T);

  test("the signal is a scalar on the retained parse, with no DOM kept", async () => {
    const { storage, crawlId } = await crawl();
    const v2 = await run(
      runStreamingRules(storage, crawlId, CONFIG, ASSETS, undefined, { batchSize: 4 }),
    );
    const shell = v2.parsedPages.get(SHELL_URL);
    expect(shell?.document).toBeNull();
    expect(shell?.errorShell).toBe(true);
    expect(v2.parsedPages.get(CONTROL_URL)?.errorShell).toBe(false);
    await run(storage.close());
  }, T);
});

describe("errorShell on the parse", () => {
  test("parsePage and parseHtmlForRules capture it from the live document", () => {
    expect(parsePage(SHELL_HTML, SHELL_URL).errorShell).toBe(true);
    expect(parseHtmlForRules(SHELL_HTML, SHELL_URL).errorShell).toBe(true);
    expect(parsePage(CONTROL_HTML, CONTROL_URL).errorShell).toBe(false);
    expect(parseHtmlForRules(CONTROL_HTML, CONTROL_URL).errorShell).toBe(false);
  });

  test("a parse stored before the field existed is recomputed from the live document", async () => {
    // What an older crawl's parsedData looks like: no errorShell key at all.
    const stored = JSON.parse(JSON.stringify(parseHtmlForRules(SHELL_HTML, SHELL_URL)));
    delete stored.errorShell;
    delete stored.document;
    const [entry] = await run(
      buildSiteContext([htmlPage(SHELL_URL, SHELL_HTML, JSON.stringify(stored))]),
    );
    expect(entry?.parsed?.errorShell).toBe(true);
    expect(hasErrorShellMarker(entry?.parsed?.document)).toBe(true);
  });

  test("a stored value is kept as stored", async () => {
    const stored = JSON.parse(JSON.stringify(parseHtmlForRules(CONTROL_HTML, CONTROL_URL)));
    delete stored.document;
    const [entry] = await run(
      buildSiteContext([htmlPage(CONTROL_URL, CONTROL_HTML, JSON.stringify(stored))]),
    );
    expect(entry?.parsed?.errorShell).toBe(false);
  });
});
