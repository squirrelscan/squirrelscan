// A real TLS failure on the crawl's root fetch ends with a reason that names the
// cause (#712). The crawl runs against a loopback HTTPS server whose certificate
// is generated at test time; the failure is the runtime's own handshake error.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { auditFailureReasonText } from "@squirrelscan/core-contracts/failure-reason";

import {
  createTlsFixtures,
  serveCertificate,
  type LocalTlsServer,
  type ServedCertificate,
  type TlsFixtures,
} from "../../utils/tests/helpers/tls-fixtures";
import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { SQLiteStorage } from "../src/storage/sqlite";

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

async function crawlRootOf(served: ServedCertificate) {
  const server = await serveCertificate(served);
  servers.push(server);
  const origin = `https://127.0.0.1:${server.port}`;
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({ config: CONFIG, storage });
      const crawlId = yield* crawler.start(`${origin}/`, `${origin}/`);
      return yield* storage.getStats(crawlId);
    }),
  );
}

describe("crawl root failure on a TLS error", () => {
  test("an expired certificate ends the crawl with a reason that names the expiry date", async () => {
    const stats = await crawlRootOf(fixtures.expired);
    const failure = stats?.rootFailure;
    expect(failure?.code).toBe("tls");
    const reason = auditFailureReasonText(failure!);
    expect(reason).toMatch(
      /^TLS handshake with 127\.0\.0\.1 failed: certificate has expired on \d{4}-\d{2}-\d{2}$/,
    );
  });

  test("a certificate for another name ends the crawl naming the hostname it does not cover", async () => {
    const stats = await crawlRootOf(fixtures.wrongName);
    const failure = stats?.rootFailure;
    expect(failure?.code).toBe("tls");
    expect(auditFailureReasonText(failure!)).toBe(
      "TLS handshake with 127.0.0.1 failed: hostname/IP does not match: the certificate does not cover 127.0.0.1",
    );
  });
});
