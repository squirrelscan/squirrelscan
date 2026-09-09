// THE DECLARATION FALSIFIER for the rule-result cache's run context (#1990).
//
// The cache hashes only three `SiteData` fields — `baseUrl`, `scripts`,
// `resourceSizes` — because those are the only ones page-scope rules read. That is
// a claim about the rule set, and the cost of it being wrong is the worst kind:
// not a crash, but a stale verdict served under a key that says nothing changed.
//
// `pages` is the field that makes this necessary. It is deliberately NOT hashed,
// because it holds every page's scalars and hashing it would make one page's edit
// invalidate the whole site — exactly the case the feature exists for. So a page
// rule that started reading `ctx.site.pages` would silently get cached results
// computed against a different set of pages.
//
// This test runs the REAL page-rule pass over a real crawl with `SiteData` behind a
// recording proxy and fails if any key outside the declared set is read.
//
// What it cannot do: prove a rule never reads another field on an input this
// fixture does not produce (the lesson of #1860 — a gate only covers the cases its
// fixtures contain). It covers the default rule surface over a mixed synthetic
// site, which is the same standard the streaming engine's own golden gates hold.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { createRunner, type SiteData } from "@squirrelscan/rules";

import {
  PAGE_RULE_RESOURCE_FIELDS,
  PAGE_RULE_SCRIPT_FIELDS,
  PAGE_RULE_SITE_FIELDS,
} from "../src/rule-cache";
import { streamPageRules } from "../src/streaming";
import { getGoldenBaselineConfig } from "./helpers/golden-baseline";

const run = <A>(e: Effect.Effect<A, never, never>) => Effect.runPromise(e);
const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-site-context-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("page rules read only the SiteData fields the cache key covers", () => {
  test("no page rule touches a field outside PAGE_RULE_SITE_FIELDS", async () => {
    const model = generateSiteModel({
      seed: "page-rule-site-context",
      pageCount: 40,
      templateCount: 3,
      minPageSizeBytes: 8_000,
      maxPageSizeBytes: 24_000,
      cleanRatio: 0.3,
      issues: {
        longH1: { ratio: 0.1 },
        oversizeTitle: { ratio: 0.1 },
        oversizeDescription: { ratio: 0.1 },
        duplicateTitles: { groupCount: 2, groupSize: 3 },
        brokenLinks: { count: 4 },
        redirectChains: { count: 2, chainLength: 2 },
      },
    });
    const dbPath = join(tmpDir, "site-context.sqlite");
    const { storage: writer } = await writeCrawlToStorage(model, dbPath);
    const crawls = await run(writer.listCrawls(1));
    const crawlId = crawls[0]!.id;
    await run(writer.close());

    const storage = new SQLiteStorage(dbPath);
    await run(storage.init());
    try {
      const runner = createRunner(getGoldenBaselineConfig());
      const readKeys = new Set<string>();
      const scriptFieldReads = new Set<string>();
      const resourceFieldReads = new Set<string>();
      /** Record every own-property read on an entry, so the ENTRY field lists are
       *  falsified too — hashing whole entries is what let `cacheReason` (per-run
       *  transport metadata) into the key and silently zeroed the cache. */
      const recordFields = <T extends object>(entry: T, into: Set<string>): T =>
        new Proxy(entry, {
          get(target, key, receiver) {
            if (typeof key === "string") into.add(key);
            return Reflect.get(target, key, receiver);
          },
        });
      // A realistic shape: every field populated the way `buildStreamingSiteData`
      // populates it, so a rule that looks for one finds it rather than
      // short-circuiting on undefined and never recording the read.
      const siteData: SiteData = {
        baseUrl: "http://synthetic.test",
        pages: [],
        robotsTxt: null,
        sitemaps: null,
        llmsTxt: null,
        markdownResponse: null,
        wellKnown: null,
        agentAccess: null,
        rsl: null,
        externalLinks: [],
        // Populated, and proxied per entry: an empty array records no field reads
        // at all, so the entry-level half of this test would be vacuous.
        resourceSizes: {
          css: [
            recordFields(
              {
                url: "http://synthetic.test/app.css",
                status: 200,
                error: null,
                contentType: "text/css",
                sizeBytes: 40_000,
                sourcePages: ["http://synthetic.test/"],
                cacheControl: "public, max-age=3600",
                cacheReason: null,
                contentEncoding: null,
                transferBytes: 12_000,
                etag: null,
                lastModified: null,
                vary: null,
              },
              resourceFieldReads,
            ),
          ],
          images: [],
        },
        scripts: [
          recordFields(
            {
              url: "http://synthetic.test/app.js",
              status: 200,
              error: null,
              contentType: "application/javascript",
              sizeBytes: 90_000,
              content: "var a = 1;\n//# sourceMappingURL=app.js.map\n",
              sourcePages: ["http://synthetic.test/"],
              redirected: false,
              finalUrl: "http://synthetic.test/app.js",
              sourceMapHeader: "app.js.map",
              contentEncoding: null,
            },
            scriptFieldReads,
          ),
        ],
        pdfSizes: [],
        sitemapUrlStatuses: [],
        cloakingProbes: [],
        crawlLimits: { pagesCrawled: 40, maxPages: 100 },
      };
      const recording = new Proxy(siteData, {
        get(target, key, receiver) {
          if (typeof key === "string") readKeys.add(key);
          return Reflect.get(target, key, receiver);
        },
      });

      const result = await run(
        streamPageRules(storage, crawlId, runner, recording, { batchSize: 20 }),
      );
      // Guard against a vacuous pass: rules must actually have run.
      expect(result.pageUrls.length).toBeGreaterThan(20);

      const undeclared = [...readKeys].filter(
        (key) => !(PAGE_RULE_SITE_FIELDS as readonly string[]).includes(key),
      );
      const undeclaredScript = [...scriptFieldReads].filter(
        (key) => !(PAGE_RULE_SCRIPT_FIELDS as readonly string[]).includes(key),
      );
      const undeclaredResource = [...resourceFieldReads].filter(
        (key) => !(PAGE_RULE_RESOURCE_FIELDS as readonly string[]).includes(key),
      );
      // Not vacuous: rules must have looked at the entries at all.
      expect(scriptFieldReads.size).toBeGreaterThan(0);
      expect(resourceFieldReads.size).toBeGreaterThan(0);
      expect(undeclaredScript).toEqual([]);
      expect(undeclaredResource).toEqual([]);
      if (undeclared.length > 0) {
        throw new Error(
          `page rules read SiteData fields the rule-result cache key does not cover: ` +
            `${undeclared.join(", ")}. Either add them to PAGE_RULE_SITE_FIELDS (and accept ` +
            `that a change to one invalidates every cached page) or stop reading them from a ` +
            `page rule. Leaving this unfixed means #1990 replays stale verdicts.`,
        );
      }
      expect(undeclared).toEqual([]);
    } finally {
      await run(storage.close());
    }
  }, 120_000);
});
