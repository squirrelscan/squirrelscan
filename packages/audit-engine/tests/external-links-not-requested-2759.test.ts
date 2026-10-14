// squirrelscan/repo#2759: the external link checker requested every external
// link it found, a third party's one-time unsubscribe link or signed download
// URL included, and followed redirects wherever they went. The URL itself can
// be the credential, so a link that looks like an action or carries a token is
// now never requested: not by the local check, not by the cloud's bulk
// checker, and not as a redirect hop. The same rules as the internal link
// probe (link-target-probe.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";

import {
  runStreamingRules,
  splitNotRequestedExternalLinks,
  type ExternalLinkOccurrences,
} from "../src/adapter";
import { checkExternalLinks, type ExternalCheckResult } from "../src/external-checker";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Every path (with query) the server was asked for, since the last serve. */
let requested: string[] = [];

const TOKEN = "0123456789abcdef0123456789abcdef";
const UNSUBSCRIBE = `/unsubscribe?token=${TOKEN}`;
const SIGNED = "/files/report.pdf?sig=Zm9vYmFyYmF6cXV4MTIzNDU2";

/**
 * The audited site is `localhost`; its outbound links point at the same
 * server under 127.0.0.1, so they are external and a local check reaches
 * them. `/short` redirects into the unsubscribe link, `/moved` to a page.
 */
function serve(): { port: string; third: string } {
  requested = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requested.push(`${url.pathname}${url.search}`);
      const third = `http://127.0.0.1:${url.port}`;
      const html = (body: string) =>
        new Response(
          `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      switch (url.pathname) {
        case "/":
          return html(
            [
              `<a href="${third}/partner">Partner</a>`,
              `<a href="${third}${UNSUBSCRIBE}">Manage email</a>`,
              `<a href="${third}${SIGNED.replace("&", "&amp;")}">Report</a>`,
              `<a href="${third}/short">Short link</a>`,
              `<a href="${third}/moved">Moved</a>`,
              `<a href="${third}/account" rel="nofollow">Log out</a>`,
            ].join(" "),
          );
        case "/short":
          return new Response(null, { status: 302, headers: { location: UNSUBSCRIBE } });
        case "/moved":
          return new Response(null, { status: 301, headers: { location: "/partner" } });
        case "/loop":
          return new Response(null, { status: 302, headers: { location: "/loop" } });
        default:
          return html("A page");
      }
    },
  });
  servers.push(server);
  return { port: String(server.port), third: `http://127.0.0.1:${server.port}` };
}

const occurrence = (text = "link", isNofollow = false) => ({
  pageUrl: "https://example.com/",
  text,
  position: "content" as const,
  isNofollow,
});

describe("splitNotRequestedExternalLinks", () => {
  test("action and token URLs, and action-worded links, are left out; pages stay", () => {
    const occurrences: ExternalLinkOccurrences = new Map([
      ["https://partner.example/pricing", [occurrence()]],
      [`https://mail.example${UNSUBSCRIBE}`, [occurrence("Manage email")]],
      [`https://cdn.example${SIGNED}`, [occurrence("Report")]],
      [
        "https://auth.example/magic-login/eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q",
        [occurrence()],
      ],
      ["https://app.example/account", [occurrence("Log out")]],
      ["https://shop.example/basket", [occurrence("Remove", true)]],
      ["https://blog.example/how-to-verify-your-domain", [occurrence()]],
    ]);
    const { requestable, notRequested } = splitNotRequestedExternalLinks(occurrences);
    expect([...requestable.keys()]).toEqual([
      "https://partner.example/pricing",
      "https://blog.example/how-to-verify-your-domain",
    ]);
    expect(notRequested.count).toBe(5);
    expect(notRequested.sample.map((l) => l.href).sort()).toEqual(
      [
        `https://mail.example${UNSUBSCRIBE}`,
        `https://cdn.example${SIGNED}`,
        "https://auth.example/magic-login/eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q",
        "https://app.example/account",
        "https://shop.example/basket",
      ].sort(),
    );
    expect(notRequested.sample[0]!.sourcePages).toEqual(["https://example.com/"]);
  });
});

describe("checkExternalLinks redirects", () => {
  const options = { concurrency: 2, timeoutMs: 5_000, userAgent: "squirrel-test" };

  test("a redirect into an action or token link is not followed: the 3xx is the answer", async () => {
    const { third } = serve();
    const [result] = await Effect.runPromise(checkExternalLinks([`${third}/short`], null, options));
    expect(result).toMatchObject({
      status: 302,
      error: null,
      redirectTarget: `${third}${UNSUBSCRIBE}`,
    });
    expect(requested).toEqual(["/short"]);
  });

  test("an ordinary redirect is still followed to its end", async () => {
    const { third } = serve();
    const [result] = await Effect.runPromise(checkExternalLinks([`${third}/moved`], null, options));
    expect(result).toMatchObject({ status: 200, error: null, redirectTarget: `${third}/partner` });
    expect(requested).toEqual(["/moved", "/partner"]);
  });

  test("a redirect loop is still an error", async () => {
    const { third } = serve();
    const [result] = await Effect.runPromise(checkExternalLinks([`${third}/loop`], null, options));
    expect(result!.status).toBeNull();
    expect(result!.error).toBe("too many redirects");
  });

  test("an action URL handed to it directly is not requested, by the bulk checker or locally", async () => {
    const { third } = serve();
    const bulkAsked: string[][] = [];
    const results = await Effect.runPromise(
      checkExternalLinks([`${third}${UNSUBSCRIBE}`, `${third}/partner`], null, {
        ...options,
        bulkChecker: async (urls) => {
          bulkAsked.push(urls);
          return new Map<string, ExternalCheckResult>();
        },
      }),
    );
    expect(bulkAsked).toEqual([[`${third}/partner`]]);
    expect(requested).toEqual(["/partner"]);
    const byHref = new Map(results.map((r) => [r.href, r]));
    expect(byHref.get(`${third}${UNSUBSCRIBE}`)).toMatchObject({ status: null, error: null });
  });
});

describe("an audit with external link checks on (repo#2759)", () => {
  test("records zero requests to third-party action and token links, and reports them as not requested", async () => {
    const { port, third } = serve();
    const home = `http://localhost:${port}/`;
    const bulkAsked: string[] = [];
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
      rules: { enable: ["links/broken-external-links"] },
      crawler: { max_pages: 1, exclude: [] },
      external_links: { enabled: true, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
      internal_links: { enabled: false },
    } as unknown as Config;
    const preRules = await Effect.runPromise(
      runStreamingPreRules(storage, crawlId, config, {
        externalLinks: {
          config: config.external_links,
          linkCache: null,
          // The cloud's dead-links service stands in here: it must never be
          // asked about them either.
          bulkChecker: async (urls) => {
            bulkAsked.push(...urls);
            return new Map<string, ExternalCheckResult>();
          },
        },
      }),
    );

    // Not one request to the unsubscribe link, the signed URL or the
    // "Log out" link, directly or through the short link's redirect.
    const notRequested = [UNSUBSCRIBE, SIGNED, "/account"];
    for (const path of notRequested) {
      expect(requested).not.toContain(path);
      expect(bulkAsked).not.toContain(`${third}${path}`);
    }
    expect(requested).toEqual(expect.arrayContaining(["/partner", "/short", "/moved"]));

    const ran = await Effect.runPromise(
      runStreamingRules(storage, crawlId, config, preRules.assets) as Effect.Effect<
        { siteRuleResults: Map<string, CheckResult[]> },
        never,
        never
      >,
    );
    const checks = ran.siteRuleResults.get("links/broken-external-links") ?? [];
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      "broken-external-links:pass",
      "not-requested-external-links:info",
    ]);
    expect(checks[0]!.message).toBe("All 3 external link(s) are working");
    const info = checks[1]!;
    expect(info.message).toBe(
      "3 external link(s) were not requested because they look like actions (log out, unsubscribe) or carry a token or signature in the URL, so their status was not checked",
    );
    expect(info.items?.map((i) => i.id).sort()).toEqual(
      notRequested.map((p) => `${third}${p}`).sort(),
    );
  });
});
