// pub#753: the signed-in CLI checks external links through the cloud
// dead-links service in chunks, and any url the service leaves out of its
// answer is checked locally. A chunk answered with none of its urls ends the
// bulk pass: the service is overloaded or out of time, and every further
// chunk would cost the same wait for the same empty answer. Those urls take
// the local per-link check straight away, and their LOCAL status is what the
// rules read. An empty answer is never "all links fine".

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import { runStreamingRules } from "../src/adapter";
import {
  BULK_CHECK_CHUNK_SIZE,
  checkExternalLinks,
  runBulkChecker,
  type ExternalCheckResult,
} from "../src/external-checker";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Paths the local server was asked for (any method), since the last serve. */
let requested: string[] = [];

/**
 * A link target: `/gone*` is a 404, everything else a 200. Its home page `/`
 * links two of its own paths under the 127.0.0.1 host name, so a crawl of
 * `http://localhost:<port>/` finds two external links a local check can reach.
 */
function serveTargets(): string {
  requested = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requested.push(url.pathname);
      const html = (body: string) =>
        new Response(
          `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      if (url.pathname === "/") {
        const elsewhere = `http://127.0.0.1:${url.port}`;
        return html(
          `<a href="${elsewhere}/elsewhere">Elsewhere</a> <a href="${elsewhere}/gone">Gone</a>`,
        );
      }
      if (url.pathname.startsWith("/gone")) return new Response("gone", { status: 404 });
      return html("Another site");
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

/** A stand-in for the dead-links service: answers whichever urls `pick` names, as live. */
function service(pick: (urls: string[], call: number) => string[]) {
  const calls: string[][] = [];
  const checker = async (urls: string[]): Promise<Map<string, ExternalCheckResult>> => {
    calls.push(urls);
    return new Map(
      pick(urls, calls.length).map((url) => [
        url,
        { href: url, status: 200, error: null, redirectTarget: null, fromCache: true },
      ]),
    );
  };
  return { calls, checker };
}

const URLS = ["a", "b", "c", "d", "e", "f"].map((p) => `https://example.com/${p}`);

describe("runBulkChecker", () => {
  test("a chunk answered with none of its urls ends the pass", async () => {
    const { calls, checker } = service(() => []);
    const resolved = await runBulkChecker(checker, URLS, 2);
    expect(calls).toHaveLength(1);
    expect(resolved.size).toBe(0);
  });

  test("an unanswered chunk after answered ones ends the pass there", async () => {
    const { calls, checker } = service((urls, call) => (call === 1 ? urls : []));
    const resolved = await runBulkChecker(checker, URLS, 2);
    expect(calls).toEqual([URLS.slice(0, 2), URLS.slice(2, 4)]);
    expect([...resolved.keys()]).toEqual(URLS.slice(0, 2));
  });

  test("a chunk that answers one of its urls keeps the pass going", async () => {
    const { calls, checker } = service((urls) => [urls[0]!]);
    const resolved = await runBulkChecker(checker, URLS, 2);
    expect(calls).toHaveLength(3);
    expect([...resolved.keys()]).toEqual([URLS[0], URLS[2], URLS[4]]);
  });

  test("an answer for urls the chunk did not ask about is no answer", async () => {
    const { calls, checker } = service(() => ["https://example.com/not-asked"]);
    await runBulkChecker(checker, URLS, 2);
    expect(calls).toHaveLength(1);
  });

  test("a chunk that throws ends the pass", async () => {
    let callCount = 0;
    const resolved = await runBulkChecker(
      async () => {
        callCount++;
        throw new Error("service_unavailable");
      },
      URLS,
      2,
    );
    expect(callCount).toBe(1);
    expect(resolved.size).toBe(0);
  });
});

describe("checkExternalLinks with a bulk checker", () => {
  // The targets are on loopback: the policy a private site's audit uses. They
  // are named by a public-looking name that resolves there, because the bulk
  // checker is never sent a link whose URL names a non-public host (pub#775).
  const OPTIONS = {
    concurrency: 25,
    timeoutMs: 5_000,
    userAgent: "squirrel-test",
    egress: { allowPrivateNetwork: true, resolve: async () => ["127.0.0.1"] },
  };
  const byName = (origin: string) =>
    origin.replace("http://127.0.0.1", "http://targets.example.com");

  test("urls the service leaves out of a chunk are checked locally, with their local status", async () => {
    const origin = byName(serveTargets());
    const [answered, gone, unanswered] = [`${origin}/ok-1`, `${origin}/gone-1`, `${origin}/ok-2`];
    const { calls, checker } = service(() => [answered]);

    const results = await Effect.runPromise(
      checkExternalLinks([answered, gone, unanswered], null, { ...OPTIONS, bulkChecker: checker }),
    );

    expect(calls).toHaveLength(1);
    const byHref = new Map(results.map((r) => [r.href, r]));
    expect(byHref.get(answered)).toMatchObject({ status: 200, fromCache: true });
    expect(byHref.get(gone)).toMatchObject({ status: 404, error: null, fromCache: false });
    expect(byHref.get(unanswered)).toMatchObject({ status: 200, fromCache: false });
    // The answered url never left the machine; the other two did.
    expect(new Set(requested)).toEqual(new Set(["/gone-1", "/ok-2"]));
  });

  test("a first chunk with no answers: no further chunks are sent, every url is checked locally", async () => {
    const origin = byName(serveTargets());
    // Three chunks' worth; every tenth url is a 404.
    const urls = Array.from({ length: BULK_CHECK_CHUNK_SIZE * 2 + 50 }, (_, i) =>
      i % 10 === 0 ? `${origin}/gone-${i}` : `${origin}/ok-${i}`,
    );
    const { calls, checker } = service(() => []);

    const results = await Effect.runPromise(
      checkExternalLinks(urls, null, { ...OPTIONS, bulkChecker: checker }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(BULK_CHECK_CHUNK_SIZE);
    expect(results).toHaveLength(urls.length);
    for (const r of results) {
      expect(r.fromCache).toBe(false);
      expect(r.status).toBe(r.href.includes("/gone-") ? 404 : 200);
    }
    expect(new Set(requested).size).toBe(urls.length);
  });

  test("chunks that answer some of their urls do not stop the pass", async () => {
    const origin = byName(serveTargets());
    const urls = Array.from(
      { length: BULK_CHECK_CHUNK_SIZE * 2 + 50 },
      (_, i) => `${origin}/ok-${i}`,
    );
    const { calls, checker } = service((chunk) => [chunk[0]!]);

    const results = await Effect.runPromise(
      checkExternalLinks(urls, null, { ...OPTIONS, bulkChecker: checker }),
    );

    expect(calls.map((c) => c.length)).toEqual([BULK_CHECK_CHUNK_SIZE, BULK_CHECK_CHUNK_SIZE, 50]);
    expect(results).toHaveLength(urls.length);
    expect(results.filter((r) => r.fromCache)).toHaveLength(3);
    expect(new Set(requested).size).toBe(urls.length - 3);
  });
});

describe("a local site's external links and the dead-links service", () => {
  // pub#775: the page's external links are on loopback, so the service is
  // never sent one; every one is checked locally, and the summary reports those
  // results, never all links fine (pub#753). The unanswered-chunk path itself is
  // covered by the checkExternalLinks tests above.
  test("are never sent to it, and the summary reports the local results", async () => {
    const port = new URL(serveTargets()).port;
    const home = `http://localhost:${port}/`;
    const { calls, checker } = service(() => []);
    const crawler = await Effect.runPromise(
      createCrawler({
        config: {
          maxPages: 1,
          concurrency: 1,
          perHostConcurrency: 1,
          delayMs: 0,
          perHostDelayMs: 0,
          timeoutMs: 5_000,
          userAgent: "squirrel-test",
          respectRobots: false,
          incremental: false,
          useCacheControl: false,
        },
      }),
    );
    const crawlId = await Effect.runPromise(crawler.start(home, home));
    const storage = crawler.storage;
    const config = {
      rule_options: {},
      rules: { enable: ["links/dead-links", "links/broken-external-links"] },
      crawler: { max_pages: 1, exclude: [] },
      external_links: { enabled: true, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
      internal_links: { enabled: false },
    } as unknown as Config;

    const preRules = await Effect.runPromise(
      runStreamingPreRules(storage, crawlId, config, {
        externalLinks: { config: config.external_links, linkCache: null, bulkChecker: checker },
      }),
    );
    expect(calls).toEqual([]);
    expect(requested).toContain("/gone");

    const ran = await Effect.runPromise(
      runStreamingRules(storage, crawlId, config, preRules.assets) as Effect.Effect<
        { siteRuleResults: Map<string, CheckResult[]> },
        never,
        never
      >,
    );
    const checksOf = (id: string) => ran.siteRuleResults.get(id) ?? [];
    expect(checksOf("links/dead-links").map((c) => c.message)).toEqual([
      "Checked 2 external link(s); 1 dead",
    ]);
    // And the per-link finding names the 404 the local check found.
    const broken = checksOf("links/broken-external-links");
    expect(broken.map((c) => c.status)).toEqual(["warn"]);
    expect(broken[0]!.items?.map((i) => i.id)).toEqual([`http://127.0.0.1:${port}/gone`]);
  });
});
