// #3922: runStreamingRules threads the runner scope's `tlsProbe` to
// security/tls-certificate, and without one the rule reports "not checked".
// The private cloud entry point passes `tlsProbe` in the same scope object, so
// this pins the public half of that contract. The probe is a stub: no DNS and
// no socket.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import type { TlsProbeFn, TlsTarget } from "@squirrelscan/utils/tls-certificate";

import { runStreamingRules } from "../src/adapter";

const RULE = "security/tls-certificate";
const HOST = "tls-fixture.com";
const DAY_MS = 86_400_000;

const run = <A>(e: Effect.Effect<A, never, never>) => Effect.runPromise(e);
const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-tls-threading-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const CONFIG = {
  rule_options: {},
  rules: { enable: [RULE] },
  crawler: { max_pages: 5, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

async function auditChecks(tlsProbe?: TlsProbeFn): Promise<CheckResult[]> {
  const model = generateSiteModel({ seed: "tls-threading-3922", pageCount: 3, templateCount: 1 });
  const dbPath = join(tmpDir, `${tlsProbe ? "with" : "without"}-probe.sqlite`);
  const { storage: writer } = await writeCrawlToStorage(model, dbPath, {
    baseUrl: `https://${HOST}`,
  });
  const crawlId = (await run(writer.listCrawls(1)))[0]!.id;
  await run(writer.close());

  const storage = new SQLiteStorage(dbPath);
  await run(storage.init());
  try {
    const result = await run(
      runStreamingRules(
        storage,
        crawlId,
        CONFIG,
        {} as never,
        tlsProbe ? { tlsProbe } : undefined,
        { batchSize: 10 },
      ),
    );
    return (result.ruleResultsMap.get(RULE)?.checks ?? []) as CheckResult[];
  } finally {
    await run(storage.close()).catch(() => {});
  }
}

describe("runStreamingRules threads tlsProbe to security/tls-certificate (#3922)", () => {
  test("a supplied probe is used, once per host, and its certificate is judged", async () => {
    const targets: TlsTarget[] = [];
    const probe: TlsProbeFn = async (target) => {
      targets.push(target);
      return {
        kind: "certificate",
        certificate: {
          names: [HOST],
          issuer: "squirrel test intermediate",
          validFrom: new Date(Date.now() - 30 * DAY_MS),
          validTo: new Date(Date.now() + 60 * DAY_MS),
          rsaBits: 2048,
        },
        trusted: true,
      };
    };
    const checks = await auditChecks(probe);
    expect(targets.map((t) => t.hostname)).toContain(HOST);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.some((c) => c.status === "pass")).toBe(true);
    expect(checks.some((c) => c.skipReason === "tls-not-checked")).toBe(false);
  }, 30_000);

  test("without a probe the rule reports not checked", async () => {
    const checks = await auditChecks();
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.message).toContain("does not open TLS connections");
  }, 30_000);
});
