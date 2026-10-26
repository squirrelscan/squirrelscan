// pub#871: technology detection in a local audit saw only the crawler's
// curated header subset, so header-only fingerprints such as `X-CDN: Imperva`
// never matched. The crawler now stores the headers detection reads, and the
// header map passes them on. A Set-Cookie reaches detection as cookie names
// only, so a session value is never sent to the cloud service.

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type { TechDetectPagePayload } from "@squirrelscan/core-contracts";

import { createCrawler } from "@squirrelscan/crawler";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { buildSiteContext } from "../../src/audit/adapter";
import {
  detectLocalTechnologies,
  runCloudTechDetect,
} from "../../src/audit/cloud";
import { getDefaultConfig } from "../../src/config";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Crawls a one-page fixture that answers with `headers`, and returns its site context. */
async function crawlFixture(headers: Record<string, string>) {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        "<!doctype html><html><head><title>Fixture</title></head><body>x</body></html>",
        { headers: { "content-type": "text/html; charset=utf-8", ...headers } }
      ),
  });
  servers.push(server);
  const baseUrl = `http://localhost:${server.port}/`;
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
    })
  );
  const crawlId = await Effect.runPromise(crawler.start(baseUrl, baseUrl));
  const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
  return { baseUrl, siteContext: Effect.runSync(buildSiteContext(pages)) };
}

describe("local technology detection reads stored headers (pub#871)", () => {
  test("a fixture that answers X-CDN: Imperva lists Imperva", async () => {
    const { baseUrl, siteContext } = await crawlFixture({ "X-CDN": "Imperva" });
    const ids = (
      detectLocalTechnologies({ baseUrl, siteContext, scripts: [] })?.items ??
      []
    ).map((t) => t.id);
    expect(ids).toContain("imperva-incapsula");
  });

  test("X-Sucuri-ID is read too", async () => {
    const { baseUrl, siteContext } = await crawlFixture({
      "X-Sucuri-ID": "18015",
    });
    const ids = (
      detectLocalTechnologies({ baseUrl, siteContext, scripts: [] })?.items ??
      []
    ).map((t) => t.id);
    expect(ids).toContain("sucuri-firewall");
  });

  test("the cloud payload carries the headers, and cookie names without values", async () => {
    const { baseUrl, siteContext } = await crawlFixture({
      "X-CDN": "Imperva",
      "X-Kpsdk-Ct": "kasada-client-token",
      "Set-Cookie": "PHPSESSID=secret-session-value; Path=/; HttpOnly",
    });
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.technologies = true;
    const captured: TechDetectPagePayload[] = [];
    const client = {
      detectTechnologies: async (req: { pages: TechDetectPagePayload[] }) => {
        captured.push(...req.pages);
        return { technologies: [], added: [], removed: [], firstScan: true };
      },
    } as unknown as CloudServicesClient;

    await runCloudTechDetect({
      client,
      config,
      auditId: "audit-1",
      baseUrl,
      siteContext,
      scripts: [],
    });

    const headers = captured[0]?.headers ?? {};
    expect(headers["x-cdn"]).toBe("Imperva");
    expect(headers["set-cookie"]).toBe("PHPSESSID=");
    expect(headers["x-kpsdk-ct"]).toBe("1");
    expect(JSON.stringify(captured)).not.toContain("secret-session-value");
    expect(JSON.stringify(captured)).not.toContain("kasada-client-token");
  });
});
