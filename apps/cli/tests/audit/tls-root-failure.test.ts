// A real TLS failure on the crawl's root fetch ends with a reason that names the
// cause (#712), through the CLI's injected probe. The crawl runs against a
// loopback HTTPS server whose certificate is generated at test time; the failure
// is the runtime's own handshake error. Without a probe (the cloud, an
// embedder) the fetch's own failure text stands.

import type { TlsProbeFn } from "@squirrelscan/utils/tls-certificate";

import { auditFailureReasonText } from "@squirrelscan/core-contracts/failure-reason";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlerConfig } from "@/crawler/core/types";

import { createTlsProbe } from "@/audit/tls-probe";
import { createCrawler } from "@/crawler/core";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

import {
  createTlsFixtures,
  serveCertificate,
  type LocalTlsServer,
  type ServedCertificate,
  type TlsFixtures,
} from "../helpers/tls-fixtures";

let fixtures: TlsFixtures;
const servers: LocalTlsServer[] = [];

beforeAll(() => {
  fixtures = createTlsFixtures();
}, 60_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 1,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 3000,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  coverageMode: "full",
};

async function crawlRootOf(
  served: ServedCertificate,
  // null: no probe injected (an explicit undefined would take the default).
  tlsProbe: TlsProbeFn | null = createTlsProbe({ allowPrivateNetwork: true })
) {
  const server = await serveCertificate(served);
  servers.push(server);
  const origin = `https://127.0.0.1:${server.port}`;
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({
        config: { ...CONFIG, ...(tlsProbe ? { tlsProbe } : {}) },
        storage,
      });
      const crawlId = yield* crawler.start(`${origin}/`, `${origin}/`);
      return yield* storage.getStats(crawlId);
    })
  );
}

describe("crawl root failure on a TLS error", () => {
  test("an expired certificate ends the crawl with a reason that names the expiry date", async () => {
    const stats = await crawlRootOf(fixtures.expired);
    const failure = stats?.rootFailure;
    expect(failure?.code).toBe("tls");
    const reason = auditFailureReasonText(failure!);
    expect(reason).toMatch(
      /^TLS handshake with 127\.0\.0\.1 failed: certificate has expired on \d{4}-\d{2}-\d{2}$/
    );
  });

  test("a certificate for another name ends the crawl naming the hostname it does not cover", async () => {
    const stats = await crawlRootOf(fixtures.wrongName);
    const failure = stats?.rootFailure;
    expect(failure?.code).toBe("tls");
    expect(auditFailureReasonText(failure!)).toBe(
      "TLS handshake with 127.0.0.1 failed: hostname/IP does not match: the certificate does not cover 127.0.0.1"
    );
  });

  test("without an injected probe the fetch's own failure text stands", async () => {
    const stats = await crawlRootOf(fixtures.expired, null);
    const failure = stats?.rootFailure;
    expect(failure?.code).toBe("tls");
    expect(auditFailureReasonText(failure!)).not.toContain(
      "certificate has expired on"
    );
  });

  test("a cause handshake the guard refuses leaves the fetch's text and connects nowhere", async () => {
    let asked = 0;
    const refusing = createTlsProbe({
      allowPrivateNetwork: true,
      resolve: async () => {
        asked += 1;
        return ["169.254.169.254"];
      },
    });
    // The root is an IP literal, so the resolver is never consulted: refuse it
    // by wrapping the probe in a name that answers a metadata address.
    const viaName: TlsProbeFn = (target) =>
      refusing({ ...target, hostname: "rebound.example.com" });
    const stats = await crawlRootOf(fixtures.expired, viaName);
    expect(stats?.rootFailure?.code).toBe("tls");
    expect(auditFailureReasonText(stats!.rootFailure!)).not.toContain(
      "certificate has expired on"
    );
    expect(asked).toBe(1);
  });
});
