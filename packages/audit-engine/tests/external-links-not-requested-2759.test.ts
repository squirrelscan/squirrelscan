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
import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";

import {
  buildSiteContext,
  checkCollectedExternalLinks,
  runRulesOnStorage,
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

const TOKEN = "0123456789abcdef0123456789abcdef"; // pragma: allowlist secret
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
              `<a href="${third}${SIGNED}">Report</a>`,
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
        case "/head-404":
          // HEAD refused, so the checker falls back to GET, whose redirect
          // leads into the unsubscribe link.
          return req.method === "HEAD"
            ? new Response(null, { status: 404 })
            : new Response(null, { status: 302, headers: { location: UNSUBSCRIBE } });
        case "/to-mailto":
          return new Response(null, {
            status: 302,
            headers: { location: "mailto:list@example.com" },
          });
        case "/choices":
          return new Response(null, { status: 300, headers: { location: "/partner" } });
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
      ["https://partner.example.com/pricing", [occurrence()]],
      [
        `https://mail.example.com${UNSUBSCRIBE}`,
        [occurrence("Manage email"), occurrence("Manage email")],
      ],
      [`https://cdn.example.com${SIGNED}`, [occurrence("Report")]],
      [
        "https://auth.example.com/magic-login/eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q",
        [occurrence()],
      ],
      ["https://app.example.com/account", [occurrence("Log out")]],
      ["https://shop.example.com/basket", [occurrence()]],
      ["https://blog.example.com/how-to-verify-your-domain", [occurrence()]],
      // rel=nofollow on an external link marks a paid or untrusted link, not
      // an action: an affiliate "Buy on Amazon" is still checked.
      ["https://www.amazon.example.com/dp/B00EXAMPLE", [occurrence("Buy on Amazon", true)]],
      ["https://social.example.com/squirrelscan", [occurrence("Follow us", true)]],
    ]);
    const { requestable, notRequested } = splitNotRequestedExternalLinks(occurrences);
    expect([...requestable.keys()]).toEqual([
      "https://partner.example.com/pricing",
      "https://blog.example.com/how-to-verify-your-domain",
      "https://www.amazon.example.com/dp/B00EXAMPLE",
      "https://social.example.com/squirrelscan",
    ]);
    expect(notRequested.count).toBe(5);
    // The sample masks every query value and token-like path segment, so a
    // published report never carries the credential.
    expect(notRequested.sample.map((l) => l.href).sort()).toEqual(
      [
        "https://mail.example.com/unsubscribe?token=…",
        "https://cdn.example.com/files/report.pdf?sig=…",
        "https://auth.example.com/magic-login/…",
        "https://app.example.com/account",
        "https://shop.example.com/basket",
      ].sort(),
    );
    expect(notRequested.sample[0]).toMatchObject({
      sourcePages: ["https://example.com/"],
      pageCount: 1,
    });
  });

  test("links that mask the same are one sample entry, with their pages merged", () => {
    const occurrences: ExternalLinkOccurrences = new Map([
      [
        "https://mail.example.com/unsubscribe?u=1",
        [{ ...occurrence(), pageUrl: "https://example.com/a" }],
      ],
      [
        "https://mail.example.com/unsubscribe?u=2",
        [{ ...occurrence(), pageUrl: "https://example.com/b" }],
      ],
    ]);
    const { notRequested } = splitNotRequestedExternalLinks(occurrences);
    expect(notRequested.count).toBe(2);
    expect(notRequested.sample).toEqual([
      {
        href: "https://mail.example.com/unsubscribe?u=…",
        sourcePages: ["https://example.com/a", "https://example.com/b"],
        pageCount: 2,
      },
    ]);
  });

  test("the sample keeps the 50 most-linked, each with 10 of its pages and the full page count", () => {
    const occurrences: ExternalLinkOccurrences = new Map();
    for (let i = 0; i < 60; i++) {
      const pages = Array.from({ length: i === 0 ? 25 : 1 }, (_, p) => ({
        ...occurrence(),
        pageUrl: `https://example.com/p${p}`,
      }));
      occurrences.set(`https://mail.example.com/unsubscribe/${i}`, pages);
    }
    const { notRequested } = splitNotRequestedExternalLinks(occurrences);
    expect(notRequested.count).toBe(60);
    expect(notRequested.sample).toHaveLength(50);
    expect(notRequested.sample[0]).toMatchObject({
      href: "https://mail.example.com/unsubscribe/0",
      pageCount: 25,
    });
    expect(notRequested.sample[0]!.sourcePages).toHaveLength(10);
  });
});

describe("checkExternalLinks redirects", () => {
  // The fixture is on loopback: the policy a private site's audit uses.
  const options = {
    concurrency: 2,
    timeoutMs: 5_000,
    userAgent: "squirrel-test",
    egress: { allowPrivateNetwork: true },
  };

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

  test("the GET fallback's redirect into an action link is not followed either", async () => {
    const { third } = serve();
    const [result] = await Effect.runPromise(
      checkExternalLinks([`${third}/head-404`], null, options),
    );
    expect(result).toMatchObject({ status: 302, redirectTarget: `${third}${UNSUBSCRIBE}` });
    expect(requested).toEqual(["/head-404", "/head-404"]);
  });

  test("a Location that is not http(s), and a 300, are answers, not hops", async () => {
    const { third } = serve();
    const results = await Effect.runPromise(
      checkExternalLinks([`${third}/to-mailto`, `${third}/choices`], null, options),
    );
    const byHref = new Map(results.map((r) => [r.href, r]));
    expect(byHref.get(`${third}/to-mailto`)).toMatchObject({
      status: 302,
      redirectTarget: "mailto:list@example.com",
    });
    expect(byHref.get(`${third}/choices`)).toMatchObject({ status: 300, redirectTarget: null });
    expect(requested.sort()).toEqual(["/choices", "/to-mailto"]);
  });

  test("a redirect loop is still an error", async () => {
    const { third } = serve();
    const [result] = await Effect.runPromise(checkExternalLinks([`${third}/loop`], null, options));
    expect(result!.status).toBeNull();
    expect(result!.error).toBe("too many redirects");
  });

  test("an action URL handed to it directly is not requested, by the bulk checker or locally", async () => {
    // A public name for the fixture: the bulk checker never gets a non-public
    // host (pub#775), so a loopback address would not reach it at all.
    const { port } = serve();
    const third = `http://third.example.com:${port}`;
    const bulkAsked: string[][] = [];
    const results = await Effect.runPromise(
      checkExternalLinks([`${third}${UNSUBSCRIBE}`, `${third}/partner`], null, {
        ...options,
        egress: { allowPrivateNetwork: true, resolve: async () => ["127.0.0.1"] },
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

describe("the cloud's dead-links service and not-requested links (repo#2759)", () => {
  test("a public site's action and token links, by URL or by link text, are never sent to it", async () => {
    const storage = new SQLiteStorage(":memory:");
    await Effect.runPromise(Effect.orDie(storage.init()));
    const crawlId = await Effect.runPromise(
      Effect.orDie(
        storage.createCrawl({
          baseUrl: "https://example.com",
          seedUrl: "https://example.com",
          originalUrl: "https://example.com",
          startedAt: Date.now(),
          status: "running",
          config: {},
          stats: {},
        } as never),
      ),
    );
    const third = "https://third.example.com";
    const occurrences: ExternalLinkOccurrences = new Map();
    for (const [path, text] of [
      ["/partner", "Our partner"],
      [UNSUBSCRIBE, "Unsubscribe"],
      [SIGNED, "Report"],
      ["/account", "Log out"],
    ] as const) {
      occurrences.set(`${third}${path}`, [
        { pageUrl: "https://example.com/", text, position: "content" as const, isNofollow: false },
      ]);
    }
    const bulkAsked: string[] = [];
    await Effect.runPromise(
      checkCollectedExternalLinks(
        storage,
        crawlId,
        occurrences,
        { enabled: true, concurrency: 1, timeout_ms: 2_000, cache_ttl_days: 1 } as never,
        undefined,
        null,
        // Answers everything it is asked, so nothing is checked locally.
        async (urls) => {
          bulkAsked.push(...urls);
          return new Map(
            urls.map((url) => [
              url,
              { href: url, status: 200, error: null, redirectTarget: null, fromCache: false },
            ]),
          );
        },
      ),
    );
    expect(bulkAsked).toEqual([`${third}/partner`]);
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
          // The cloud's dead-links service stands in here. These links are on
          // loopback, so it is never asked about any of them (pub#775); the
          // test above shows the not-requested ones stay out on a public name.
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
      [
        `${third}/unsubscribe?token=…`,
        `${third}/files/report.pdf?sig=…`,
        `${third}/account`,
      ].sort(),
    );
  });
});

for (const engine of ["v1", "v2"] as const) {
  describe(`a re-audit (repo#2759, ${engine})`, () => {
    test("an old verdict for a link now never requested is not reported, as broken or as working", async () => {
      // An incremental crawl copies a reused page's link rows from the earlier
      // crawl, verdicts included. Here an engine before #2759 had checked the
      // unsubscribe link and stored a 404; the next audit must not report it.
      const { port, third } = serve();
      const home = `http://localhost:${port}/`;
      const crawlerConfig = {
        maxPages: 1,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 5_000,
        userAgent: "squirrel-test",
        respectRobots: false,
        incremental: true,
        useCacheControl: false,
      };
      const config = {
        rule_options: {},
        rules: { enable: ["links/broken-external-links", "links/dead-links"] },
        crawler: { max_pages: 1, exclude: [] },
        external_links: { enabled: true, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
        internal_links: { enabled: false },
      } as unknown as Config;
      const first = await Effect.runPromise(createCrawler({ config: crawlerConfig }));
      const storage = first.storage;
      const audit = async (
        crawler: typeof first,
        afterPreRules?: (crawlId: string) => Promise<void>,
      ) => {
        const crawlId = await Effect.runPromise(crawler.start(home, home));
        const pre = await Effect.runPromise(
          runStreamingPreRules(storage, crawlId, config, {
            externalLinks: { config: config.external_links, linkCache: null },
          }),
        );
        await afterPreRules?.(crawlId);
        const ran = await Effect.runPromise(
          Effect.gen(function* () {
            if (engine === "v1") {
              const stored = yield* storage.getPages(crawlId);
              const siteContext = yield* buildSiteContext(stored);
              return yield* runRulesOnStorage(storage, crawlId, siteContext, config, pre.assets);
            }
            return yield* runStreamingRules(storage, crawlId, config, pre.assets);
          }) as Effect.Effect<{ siteRuleResults: Map<string, CheckResult[]> }, never, never>,
        );
        return { crawlId, ran };
      };

      const { crawlId: firstId } = await audit(first);
      // What an engine before #2759 left: both links checked, a 404 each,
      // with their appearances. One is left out now by its URL, one only by
      // its link text ("Log out"). The next crawl copies the reused page's
      // link rows; it does not copy their appearances.
      const pageUrl =
        (await Effect.runPromise(storage.getPages(firstId)))[0]?.normalizedUrl ?? home;
      const stale = `${third}${UNSUBSCRIBE}`;
      const staleByText = `${third}/account`;
      // pub#770: and a link the check refuses for its address, and one this
      // run never checks at all: neither may report the old verdict.
      const staleRefused = "http://169.254.169.254/latest/meta-data/";
      const staleUnchecked = `${third}/no-longer-linked`;
      for (const [href, anchorText] of [
        [stale, "Manage email"],
        [staleByText, "Log out"],
        [staleRefused, "Status"],
        [staleUnchecked, "Old partner"],
      ] as const) {
        await Effect.runPromise(
          storage.upsertLink(firstId, {
            href,
            isInternal: false,
            status: 404,
            checkedAt: Date.now() - 60_000,
          }),
        );
        await Effect.runPromise(
          storage.addLinkAppearancesBatch(firstId, [
            { href, pageUrl, anchorText, position: "content", isNofollow: false },
          ]),
        );
      }

      requested = [];
      const second = await Effect.runPromise(createCrawler({ config: crawlerConfig, storage }));
      const { ran } = await audit(second, (crawlId) =>
        // A row older than this run beside an appearance this run wrote: what
        // a link refused after its DNS lookup leaves (the check writes its
        // appearances, never its row). Simulated on a checked link.
        Effect.runPromise(
          storage.upsertLink(crawlId, {
            href: `${third}/partner`,
            isInternal: false,
            status: 404,
            checkedAt: 1,
          }),
        ),
      );
      expect(requested).not.toContain(UNSUBSCRIBE);
      expect(requested).not.toContain("/account");
      const checks = ran.siteRuleResults.get("links/broken-external-links") ?? [];
      expect(checks.find((c) => c.status === "warn")).toBeUndefined();
      for (const c of checks.filter((c) => c.name === "broken-external-links")) {
        expect(c.items?.map((i) => i.id) ?? []).not.toContain(stale);
        expect(c.items?.map((i) => i.id) ?? []).not.toContain(staleByText);
        expect(c.items?.map((i) => i.id) ?? []).not.toContain(staleRefused);
        expect(c.items?.map((i) => i.id) ?? []).not.toContain(staleUnchecked);
      }
      const dead = ran.siteRuleResults.get("links/dead-links") ?? [];
      expect(dead.map((c) => c.message)).toEqual(["Checked 2 external link(s); none are dead"]);
    });
  });
}
