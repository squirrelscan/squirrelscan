// repo#2144: rules start without waiting on external links; the link rules read
// late-bound verdicts up to a deadline.
//
// Each test crawls a local fixture site (one home page linking out to a
// public-looking host the stub dead-links service answers for) and audits it in
// the blocking mode (verdicts persisted before any rule) and the late-binding
// mode (`externalLinks.lateBinding` + `runStreamingRules({ linkVerdicts })`).
// Ordering is asserted on events, never on absolute milliseconds.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { createCrawler, type SQLiteStorage } from "@squirrelscan/crawler";
import { getAllRuleIds, LINK_VERDICT_RULE_IDS } from "@squirrelscan/rules";

import { runStreamingRules, type StreamingRulePhase } from "../src/adapter";
import { BULK_CHECK_CHUNK_SIZE, type ExternalCheckResult } from "../src/external-checker";
import { LINK_RULES_RESERVE_MS, linkVerdictDeadlineAt } from "../src/late-link-verdicts";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const T = 60_000;

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Paths of the link targets the local server was asked for (the local checker's requests). */
let localRequests: string[] = [];

/** The public-looking host the home page links to; the test resolver points it at the fixture server. */
const LINK_HOST = "links.example.com";

/**
 * A fixture site on localhost. `/` links to `count` targets on LINK_HOST; every
 * tenth is `/gone-<i>` (404 when checked locally), the rest `/ok-<i>` (200).
 */
function serveSite(count: number): { home: string; links: string[] } {
  localRequests = [];
  let port = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const html = (body: string) =>
        new Response(
          `<!doctype html><html lang="en"><head><title>Fixture home page</title></head><body><h1>Fixture</h1>${body}</body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      if (url.pathname === "/") {
        return html(links.map((href, i) => `<p><a href="${href}">Target ${i}</a></p>`).join(""));
      }
      if (url.pathname.startsWith("/gone-")) {
        localRequests.push(url.pathname);
        return new Response("gone", { status: 404 });
      }
      if (url.pathname.startsWith("/ok-")) {
        localRequests.push(url.pathname);
        return html("A target");
      }
      // The crawl's own probes (robots.txt, sitemaps, well-known files).
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  port = server.port as number;
  const links = Array.from({ length: count }, (_, i) =>
    i % 10 === 0 ? `http://${LINK_HOST}:${port}/gone-${i}` : `http://${LINK_HOST}:${port}/ok-${i}`,
  );
  return { home: `http://localhost:${port}/`, links };
}

const resolveHost = async (hostname: string): Promise<string[]> =>
  hostname === LINK_HOST || hostname === "localhost" ? ["127.0.0.1"] : [];

/** The service's verdict for a link: its true status, as the local checker would find it. */
function verdict(url: string): ExternalCheckResult {
  const gone = url.includes("/gone-");
  return {
    href: url,
    status: gone ? 404 : 200,
    error: null,
    redirectTarget: null,
    fromCache: false,
  };
}

/** A gate a test opens when it chooses. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const CONFIG = {
  rule_options: {},
  rules: {
    enable: [
      "links/dead-links",
      "links/broken-external-links",
      "links/external-links",
      "reliability/broken-forms",
      "integrity/known-malicious-url",
      "core/meta-title",
      "core/h1",
      "crawl/sitemap-exists",
    ],
  },
  crawler: { max_pages: 1, exclude: [] },
  external_links: {
    enabled: true,
    concurrency: 5,
    timeout_ms: 5_000,
    cache_ttl_days: 1,
    max_links: 1_000,
  },
  internal_links: { enabled: false },
} as unknown as Config;

async function crawl(home: string): Promise<{ storage: SQLiteStorage; crawlId: string }> {
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
  return { storage: crawler.storage as SQLiteStorage, crawlId };
}

type Ran = {
  ruleResultsMap: Map<string, { checks: CheckResult[] }>;
  siteRuleResults: Map<string, CheckResult[]>;
};

interface AuditOptions {
  bulkChecker: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>;
  late: boolean;
  budgetMs?: number;
  events?: string[];
  onLinkVerdictsStart?: () => void;
  /** Rules enabled on top of CONFIG's. */
  alsoEnable?: string[];
}

async function audit(home: string, o: AuditOptions) {
  const { storage, crawlId } = await crawl(home);
  const events = o.events ?? [];
  const config = o.alsoEnable
    ? ({ ...CONFIG, rules: { enable: [...CONFIG.rules!.enable!, ...o.alsoEnable] } } as Config)
    : CONFIG;
  const preRules = await Effect.runPromise(
    runStreamingPreRules(storage, crawlId, config, {
      resourceOverrides: { resolveHost },
      externalLinks: {
        config: CONFIG.external_links,
        linkCache: null,
        bulkChecker: o.bulkChecker,
        ...(o.budgetMs !== undefined ? { limits: { budgetMs: o.budgetMs } } : {}),
        ...(o.late ? { lateBinding: {} } : {}),
      },
    }),
  );
  events.push("pre-rules:end");
  const ran = (await Effect.runPromise(
    runStreamingRules(storage, crawlId, config, preRules.assets, undefined, {
      onPhase: (phase: StreamingRulePhase, boundary) => events.push(`${phase}:${boundary}`),
      ...(preRules.linkVerdicts ? { linkVerdicts: preRules.linkVerdicts } : {}),
      onLinkVerdicts: (boundary) => {
        events.push(`link-verdicts:${boundary}`);
        if (boundary === "start") o.onLinkVerdictsStart?.();
      },
    }),
  )) as unknown as Ran;
  return { storage, crawlId, preRules, ran, events };
}

/** Every rule's checks, keyed and ordered by rule id: the order the site pass ran them in is not a finding. */
function normalised(ran: Ran) {
  return [...ran.ruleResultsMap.entries()]
    .map(([id, rr]) => [id, rr.checks] as const)
    .sort(([a], [b]) => a.localeCompare(b));
}

const checksOf = (ran: Ran, id: string) => ran.siteRuleResults.get(id) ?? [];

async function externalRows(storage: SQLiteStorage, crawlId: string) {
  const links = await Effect.runPromise(storage.getLinks(crawlId));
  return links.filter((l) => !l.isInternal).map((l) => ({ href: l.href, status: l.status }));
}

describe("linkVerdictDeadlineAt", () => {
  test("is the earliest of the link budget and the run deadline less the reserve", () => {
    expect(linkVerdictDeadlineAt({ checkStartedAt: 1_000, linkBudgetMs: 60_000 })).toBe(61_000);
    expect(linkVerdictDeadlineAt({ checkStartedAt: 1_000, runDeadlineAt: 100_000 })).toBe(
      100_000 - LINK_RULES_RESERVE_MS,
    );
    expect(
      linkVerdictDeadlineAt({ checkStartedAt: 1_000, linkBudgetMs: 60_000, runDeadlineAt: 80_000 }),
    ).toBe(80_000 - LINK_RULES_RESERVE_MS);
  });

  test("no bound, or a zero, negative or non-numeric one, is no deadline", () => {
    expect(linkVerdictDeadlineAt({ checkStartedAt: 1_000 })).toBeUndefined();
    for (const linkBudgetMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(linkVerdictDeadlineAt({ checkStartedAt: 1_000, linkBudgetMs })).toBeUndefined();
    }
    expect(
      linkVerdictDeadlineAt({ checkStartedAt: 1_000, runDeadlineAt: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
  });
});

describe("late-bound link verdicts (repo#2144)", () => {
  test(
    "the non-link rules run before a slow link service answers; the link rules run last",
    async () => {
      const { home } = serveSite(30);
      const answer = gate();
      const events: string[] = [];
      const slowService = async (urls: string[]) => {
        await answer.opened;
        events.push("service:answered");
        return new Map(urls.map((u) => [u, verdict(u)] as const));
      };

      const late = await audit(home, {
        bulkChecker: slowService,
        late: true,
        events,
        // The service answers only once the link rules are waiting on it, so
        // every rule before that point ran without its verdicts.
        onLinkVerdictsStart: () => answer.open(),
      });

      const at = (event: string) => {
        const index = events.indexOf(event);
        expect(index).toBeGreaterThanOrEqual(0);
        return index;
      };
      expect(at("pre-rules:end")).toBeLessThan(at("service:answered"));
      expect(at("page-rules:start")).toBeLessThan(at("service:answered"));
      expect(at("page-rules:end")).toBeLessThan(at("service:answered"));
      expect(at("site-rules:start")).toBeLessThan(at("service:answered"));
      expect(at("link-verdicts:start")).toBeLessThan(at("service:answered"));
      expect(at("service:answered")).toBeLessThan(at("link-verdicts:end"));
      expect(at("link-verdicts:end")).toBeLessThan(at("site-rules:end"));

      // And the link rules read the verdicts that arrived.
      expect(checksOf(late.ran, "links/dead-links").map((c) => c.message)).toEqual([
        "Checked 30 external link(s); 3 dead",
      ]);
    },
    T,
  );

  test(
    "security/supabase-rls runs after the link check binds site.externalLinks, not before it",
    async () => {
      // The rule reads `site.externalLinks === undefined` as "this audit may not
      // request other hosts" (pub#1883), so it must never read the field before
      // the link check fills it: on an aggressive online run, read early, it
      // could skip as external-requests-off. Proven on site-rule order: the late
      // pass sets its results after every rule of the first pass, and
      // security/security-txt (a site rule that reads no verdicts) comes right
      // after security/supabase-rls in the registry, so it is first-pass and
      // the rule lands after it only when it runs late.
      const ids = await getAllRuleIds();
      expect(ids.indexOf("security/security-txt")).toBeGreaterThan(
        ids.indexOf("security/supabase-rls"),
      );
      expect(LINK_VERDICT_RULE_IDS.has("security/security-txt")).toBe(false);

      const { home } = serveSite(3);
      const service = async (urls: string[]) => new Map(urls.map((u) => [u, verdict(u)] as const));
      const late = await audit(home, {
        bulkChecker: service,
        late: true,
        alsoEnable: ["security/supabase-rls", "security/security-txt"],
      });

      const order = [...late.ran.siteRuleResults.keys()];
      expect(order).toContain("security/supabase-rls");
      expect(order).toContain("security/security-txt");
      expect(order.indexOf("security/supabase-rls")).toBeGreaterThan(
        order.indexOf("security/security-txt"),
      );
      for (const check of checksOf(late.ran, "security/supabase-rls")) {
        expect(check.skipReason).not.toBe("external-requests-off");
      }
    },
    T,
  );

  test(
    "verdicts in time: every rule's findings equal the blocking mode's",
    async () => {
      const { home } = serveSite(30);
      const service = async (urls: string[]) => new Map(urls.map((u) => [u, verdict(u)] as const));

      const blocking = await audit(home, { bulkChecker: service, late: false });
      const late = await audit(home, { bulkChecker: service, late: true });

      expect(late.preRules.linkVerdicts).toBeDefined();
      expect(blocking.preRules.linkVerdicts).toBeUndefined();
      // The link rules ran and found the broken links...
      const broken = checksOf(late.ran, "links/broken-external-links");
      expect(broken.map((c) => c.status)).toContain("fail");
      // ...and every rule, link rules included, says exactly what the blocking run says.
      expect(normalised(late.ran)).toEqual(normalised(blocking.ran));
      for (const id of LINK_VERDICT_RULE_IDS) {
        expect(late.ran.ruleResultsMap.has(id)).toBe(blocking.ran.ruleResultsMap.has(id));
      }
      // The same rows and coverage stat were stored.
      expect(await externalRows(late.storage, late.crawlId)).toEqual(
        await externalRows(blocking.storage, blocking.crawlId),
      );
      const statsOf = async (r: typeof late) =>
        (await Effect.runPromise(r.storage.getStats(r.crawlId)))?.externalLinkCheck;
      expect(await statsOf(late)).toEqual(await statsOf(blocking));
      // Nothing went to the local checker: the service answered every link.
      expect(localRequests).toEqual([]);
    },
    T,
  );

  test(
    "deadline expiry: links with no verdict are unverifiable, get no row, and a late verdict changes nothing",
    async () => {
      // Two chunks: the first is answered at once, the second only after the deadline.
      const count = BULK_CHECK_CHUNK_SIZE + 10;
      const { home, links } = serveSite(count);
      const lateAnswer = gate();
      let lateAnswered = false;
      const service = async (urls: string[]) => {
        if (urls.includes(links[0]!)) return new Map(urls.map((u) => [u, verdict(u)] as const));
        await lateAnswer.opened;
        lateAnswered = true;
        return new Map(urls.map((u) => [u, verdict(u)] as const));
      };

      const late = await audit(home, { bulkChecker: service, late: true, budgetMs: 400 });
      const handle = late.preRules.linkVerdicts!;
      const settlement = await handle.settle();

      expect(handle.sealed).toBe(true);
      expect(settlement.expired).toBe(true);
      expect(settlement.results).toHaveLength(BULK_CHECK_CHUNK_SIZE);
      expect(settlement.unverifiable).toBe(10);

      // Unverifiable, never broken: counted as out of time, with no row.
      const stats = (await Effect.runPromise(late.storage.getStats(late.crawlId)))
        ?.externalLinkCheck;
      expect(stats).toMatchObject({ found: count, checked: count, outOfTime: 10 });
      const rows = await externalRows(late.storage, late.crawlId);
      expect(rows).toHaveLength(BULK_CHECK_CHUNK_SIZE);
      const unanswered = links.slice(BULK_CHECK_CHUNK_SIZE);
      for (const href of unanswered) expect(rows.some((r) => r.href === href)).toBe(false);
      const dead = checksOf(late.ran, "links/dead-links");
      expect(dead.map((c) => c.message).join("\n")).toContain(
        `${BULK_CHECK_CHUNK_SIZE} external link(s)`,
      );
      const broken = checksOf(late.ran, "links/broken-external-links");
      const brokenIds = broken.flatMap((c) => c.items?.map((i) => i.id) ?? []);
      for (const href of unanswered) expect(brokenIds).not.toContain(href);
      // Reported as not checked (skipped, so never scored), as a link the blocking check's budget ran out on.
      expect(broken.filter((c) => c.status === "skipped").map((c) => c.message)).toEqual([
        `10 of ${count} external link(s) were not checked: the link check ran out of time before reaching them`,
      ]);
      // Nothing was checked locally after the deadline either.
      expect(localRequests).toEqual([]);

      // The late verdict arrives: nothing this run reads or stored changes.
      const before = { rows, stats, findings: normalised(late.ran) };
      lateAnswer.open();
      await handle.checkDone;
      await Bun.sleep(10);
      expect(await externalRows(late.storage, late.crawlId)).toEqual(before.rows);
      expect(
        (await Effect.runPromise(late.storage.getStats(late.crawlId)))?.externalLinkCheck,
      ).toEqual(before.stats);
      expect(await handle.settle()).toBe(settlement);
      expect(normalised(late.ran)).toEqual(before.findings);
      // (The check had already abandoned the call at the deadline, so the
      // answer may or may not have been read; either way it bound nothing.)
      void lateAnswered;
    },
    T,
  );

  test(
    "a link service that fails mid-check: the local checker finishes, and the report is complete",
    async () => {
      const count = BULK_CHECK_CHUNK_SIZE + 10;
      const { home, links } = serveSite(count);
      // Answers the first chunk, then goes down.
      const failingService = () => {
        let calls = 0;
        return async (urls: string[]) => {
          calls += 1;
          if (calls > 1) throw new Error("service_unavailable");
          return new Map(urls.map((u) => [u, verdict(u)] as const));
        };
      };

      const late = await audit(home, { bulkChecker: failingService(), late: true });
      const lateLocal = [...localRequests];
      const blocking = await audit(home, { bulkChecker: failingService(), late: false });

      // The second chunk's links went to the local checker.
      const fellBack = links.slice(BULK_CHECK_CHUNK_SIZE).map((href) => new URL(href).pathname);
      expect(new Set(lateLocal)).toEqual(new Set(fellBack));

      const settlement = await late.preRules.linkVerdicts!.settle();
      expect(settlement.expired).toBe(false);
      expect(settlement.unverifiable).toBe(0);
      expect(settlement.results).toHaveLength(count);

      // Complete: one verdict per link, and every broken link found, local ones included.
      expect(await externalRows(late.storage, late.crawlId)).toHaveLength(count);
      expect(checksOf(late.ran, "links/dead-links").map((c) => c.message)).toEqual([
        `Checked ${count} external link(s); ${count / 10} dead`,
      ]);
      const brokenIds = checksOf(late.ran, "links/broken-external-links").flatMap(
        (c) => c.items?.map((i) => i.id) ?? [],
      );
      for (const href of links.filter((l) => l.includes("/gone-")))
        expect(brokenIds).toContain(href);
      // And the same report the blocking mode builds from the same failure.
      expect(normalised(late.ran)).toEqual(normalised(blocking.ran));
    },
    T,
  );
});
