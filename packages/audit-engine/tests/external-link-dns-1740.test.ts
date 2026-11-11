// #1740: a link to a host that does not resolve is CONFIRMED broken (a definitive "no such host" that holds
// on a second lookup), never reported as "not requested". A resolver that fails to answer is "could not
// verify", never broken. A private address is still refused and never requested.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import {
  EXTERNAL_LINK_HOST_UNRESOLVED_ERROR,
  EXTERNAL_LINK_INVALID_SUFFIX_ERROR,
  type CheckResult,
} from "@squirrelscan/core-contracts";
import { createCrawler } from "@squirrelscan/crawler";
import type { EgressPolicy, ResolveHost } from "@squirrelscan/utils/public-egress";

import { runStreamingRules } from "../src/adapter";
import { checkExternalLinks, type ExternalCheckResult } from "../src/external-checker";
import { runStreamingPreRules } from "../src/streaming-pre-rules";

const dnsError = (code: string, hostname: string) =>
  Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), { code, hostname, syscall: "getaddrinfo" });

/** A resolver that answers from a script, one entry per lookup of the host, in order. */
function scripted(answers: Array<"nxdomain" | "empty" | "temporary" | string[]>): { resolve: ResolveHost; asked: string[] } {
  const asked: string[] = [];
  const queue = [...answers];
  const resolve: ResolveHost = async (hostname) => {
    asked.push(hostname);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next === "nxdomain") throw dnsError("ENOTFOUND", hostname);
    if (next === "temporary") throw dnsError("EAI_AGAIN", hostname);
    if (next === "empty") return [];
    return next;
  };
  return { resolve, asked };
}

const policy = (resolve: ResolveHost): EgressPolicy => ({ allowPrivateNetwork: false, resolve });

async function check(href: string, resolve: ResolveHost) {
  const [result] = await Effect.runPromise(
    checkExternalLinks([href], null, { egress: policy(resolve), timeoutMs: 2000, concurrency: 1 }),
  );
  return result!;
}

describe("a host that does not resolve is confirmed broken (#1740)", () => {
  test("NXDOMAIN, confirmed on a second lookup: the verdict is the unresolved error, no status", async () => {
    const dns = scripted(["nxdomain"]);
    const r = await check("https://nut-supplier.example-gone.net/", dns.resolve);
    expect(r.error).toBe(EXTERNAL_LINK_HOST_UNRESOLVED_ERROR);
    expect(r.status).toBeNull();
    expect(r.refused).toBeUndefined();
    expect(r.wafBlocked).toBeUndefined();
    // Asked more than once: the verdict was confirmed, not taken from one answer.
    expect(dns.asked.length).toBeGreaterThanOrEqual(2);
  });

  test("a name with no address records (an empty answer) is the same verdict, not a refusal", async () => {
    const r = await check("https://no-records.example-gone.net/", scripted(["empty"]).resolve);
    expect(r.error).toBe(EXTERNAL_LINK_HOST_UNRESOLVED_ERROR);
    expect(r.refused).toBeUndefined();
  });

  test.each(["https://nut-supplier.invalid/", "https://gone.test/", "https://gone.example/"])(
    "a reserved suffix (%s) is a dead link answered without a lookup: no such domain suffix, never a refusal",
    async (href) => {
      const dns = scripted([["93.184.216.34"]]);
      const r = await check(href, dns.resolve);
      expect(r.error).toBe(EXTERNAL_LINK_INVALID_SUFFIX_ERROR);
      expect(r.status).toBeNull();
      expect(r.refused).toBeUndefined();
      expect(dns.asked).toEqual([]);
    },
  );

  test("a suffix that is not a TLD at all is an ordinary dead domain: NXDOMAIN, confirmed", async () => {
    const r = await check("https://supplier.notatld/", scripted(["nxdomain"]).resolve);
    expect(r.error).toBe(EXTERNAL_LINK_HOST_UNRESOLVED_ERROR);
  });

  test("a private-network audit looks a reserved name up like any other (its own DNS may map it)", async () => {
    const dns = scripted([["10.0.0.9"]]);
    const [r] = await Effect.runPromise(
      checkExternalLinks(["http://app.test:9/"], null, {
        egress: { allowPrivateNetwork: true, resolve: dns.resolve },
        timeoutMs: 500,
        concurrency: 1,
      }),
    );
    expect(r!.error).not.toBe(EXTERNAL_LINK_INVALID_SUFFIX_ERROR);
    expect(dns.asked.length).toBeGreaterThan(0);
  });
});

describe("a resolver that did not answer is never a broken link (#1740)", () => {
  test("a resolver timeout (EAI_AGAIN) is unverifiable, and is asked about once", async () => {
    const dns = scripted(["temporary"]);
    const r = await check("https://slow-resolver.example-live.net/", dns.resolve);
    expect(r.error).toBeNull();
    expect(r.wafBlocked).toBe(true);
    expect(r.unverifiedReason).toBe("unreachable");
  });

  test("NXDOMAIN once and an answer on the second lookup: one hiccup does not mark a live host dead", async () => {
    const r = await check("https://flaky.example-live.net/", scripted(["nxdomain", ["93.184.216.34"]]).resolve);
    expect(r.error).toBeNull();
    expect(r.wafBlocked).toBe(true);
    expect(r.unverifiedReason).toBe("unreachable");
  });

  test("NXDOMAIN once and a resolver failure on the second: unverifiable, not broken", async () => {
    const r = await check("https://flaky2.example-live.net/", scripted(["nxdomain", "temporary"]).resolve);
    expect(r.error).toBeNull();
    expect(r.wafBlocked).toBe(true);
  });
});

describe("addresses the policy refuses are still never requested (#1740)", () => {
  test.each(["http://10.0.0.5/admin", "http://192.168.1.1/", "http://169.254.169.254/latest/", "http://localhost:8080/"])(
    "%s is refused, not broken and not requested",
    async (href) => {
      const dns = scripted([["10.0.0.5"]]);
      const r = await check(href, dns.resolve);
      expect(r.refused).toBe(true);
      expect(r.error).toBeNull();
      expect(dns.asked).toEqual([]);
    },
  );

  test("a public name that resolves to a private address is refused, not broken", async () => {
    const r = await check("https://rebind.example-live.net/", scripted([["10.1.2.3"]]).resolve);
    expect(r.refused).toBe(true);
    expect(r.error).toBeNull();
  });
});

// The engine path (no DOM): the crawl stores the verdict a remote link checker gives for a dead host, and the
// streaming site rule reads it as a confirmed-broken link. The cloud link checker reports a dead domain with the
// error "domain does not exist"; the engine stores it like any other answer.
describe("engine: a dead host reaches links/broken-external-links as a failure (#1740)", () => {
  const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  test("a remote 'domain does not exist' verdict is a failing link beside the working one", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><html><head><title>Fixture</title></head><body><a href="https://nut-supplier.example-gone.net/">Supplier</a> <a href="https://partner.example-live.net/">Partner</a></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });
    servers.push(server);
    const home = `http://localhost:${server.port}/`;
    const asked: string[][] = [];
    const bulkChecker = async (urls: string[]): Promise<Map<string, ExternalCheckResult>> => {
      asked.push(urls);
      return new Map(
        urls.map((href) => [
          href,
          href.includes("example-gone")
            ? { href, status: null, error: EXTERNAL_LINK_HOST_UNRESOLVED_ERROR, redirectTarget: null, fromCache: false }
            : { href, status: 200, error: null, redirectTarget: null, fromCache: false },
        ]),
      );
    };
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
    const config = {
      rule_options: {},
      rules: { enable: ["links/broken-external-links"] },
      crawler: { max_pages: 1, exclude: [] },
      external_links: { enabled: true, concurrency: 1, timeout_ms: 5_000, cache_ttl_days: 1 },
      internal_links: { enabled: false },
    } as unknown as Config;

    const preRules = await Effect.runPromise(
      runStreamingPreRules(crawler.storage, crawlId, config, {
        externalLinks: { config: config.external_links, linkCache: null, bulkChecker },
      }),
    );
    expect(asked.flat().sort()).toEqual([
      "https://nut-supplier.example-gone.net/",
      "https://partner.example-live.net/",
    ]);
    const ran = await Effect.runPromise(
      runStreamingRules(crawler.storage, crawlId, config, preRules.assets) as Effect.Effect<
        { siteRuleResults: Map<string, CheckResult[]> },
        never,
        never
      >,
    );
    const checks = ran.siteRuleResults.get("links/broken-external-links") ?? [];
    const failing = checks.find((c) => c.name === "broken-external-links")!;
    expect(failing.status).toBe("fail");
    expect(failing.message).toBe("1 broken external link(s): 1 domain does not exist");
    expect(failing.items?.map((i) => i.id)).toEqual(["https://nut-supplier.example-gone.net/"]);
    // Nothing is filed under "not requested" for it.
    expect(checks.some((c) => c.name === "refused-external-links")).toBe(false);
  });
});
