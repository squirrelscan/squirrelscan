// #1314: a successful HTML response with a zero-byte body is still a crawled
// page. It enters the scored page universe instead of disappearing before the
// rules run.

import { parsePageRecord as parseEnginePageRecord } from "@squirrelscan/audit-engine";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { PageRecord } from "../../src/crawler/storage/types";

import { parsePageRecord as parseCliPageRecord } from "../../src/audit/adapter";
import { runAudit } from "../../src/controllers/audit";
import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("empty-body-page-1314");

const HTML = { "content-type": "text/html; charset=utf-8" };

let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/") {
        return new Response(
          '<!doctype html><html lang="en"><head><title>Fixture home page</title></head><body><h1>Fixture</h1><a href="/empty">Empty</a></body></html>',
          { headers: HTML }
        );
      }
      if (pathname === "/empty") {
        return new Response(null, { status: 200, headers: HTML });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = server.url.origin;
});

afterAll(() => {
  server.stop(true);
});

describe("an empty successful HTML response", () => {
  test("both page-record adapters parse an empty body", () => {
    const url = "https://example.com/empty";
    const page = {
      url,
      normalizedUrl: url,
      finalUrl: url,
      depth: 0,
      status: 200,
      contentType: "text/html",
      sizeBytes: 0,
      loadTimeMs: 1,
      fetchedAt: 1,
      etag: null,
      lastModified: null,
      contentHash: "empty",
      html: "",
      parsedData: null,
      headers: { contentType: "text/html" },
      securityHeaders: {},
    } as unknown as PageRecord;

    expect(parseEnginePageRecord(page)?.meta.title).toBeNull();
    expect(parseEnginePageRecord(page)?.h1.count).toBe(0);
    expect(parseCliPageRecord(page)?.meta.title).toBeNull();
    expect(parseCliPageRecord(page)?.h1.count).toBe(0);
  });

  test("is counted, reported and evaluated by page rules", async () => {
    const result = await runAudit({
      url: origin,
      projectName: "empty-body-page-1314",
      maxPages: 3,
      coverageMode: "surface",
      offline: true,
      refresh: true,
      smartAudits: true,
      disableDiscoveryProbes: true,
      ruleInclude: ["core/meta-title", "core/h1"],
    });
    if (!result.ok) throw new Error(`audit failed: ${result.error.message}`);

    const report = result.data;
    const emptyUrl = `${origin}/empty`;
    expect(report.totalPages).toBe(2);
    expect(report.coverage?.auditedPages).toBe(2);
    expect(report.pages.map((page) => page.url)).toContain(emptyUrl);
    expect(report.ruleResults["core/meta-title"]?.checks).toContainEqual(
      expect.objectContaining({
        pageUrl: emptyUrl,
        status: "fail",
        message: "Missing page title",
      })
    );
    expect(report.ruleResults["core/h1"]?.checks).toContainEqual(
      expect.objectContaining({
        pageUrl: emptyUrl,
        status: "fail",
        message: "No H1 tag found",
      })
    );
  }, 60_000);
});
