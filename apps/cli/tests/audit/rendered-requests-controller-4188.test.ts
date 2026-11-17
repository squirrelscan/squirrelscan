// repo#4188 controller regression: the XHR and fetch requests a rendered page
// issued reach the rules pass as `render` endpoint candidates. The controller
// once cleared its rendered-request sink with the crawl-time DOMs, before the
// rules pass read it, so the CLI never produced a single `render` candidate.
//
// Runs the real CLI path end to end (crawl, streamed rules, site rules) over a
// local server. The only stand-in is the crawl fetch seam, which decorates each
// real HTML response with the requests a browser render would have reported.

import type { RenderedRequest } from "@squirrelscan/core-contracts";
import type { EndpointSurface } from "@squirrelscan/rules/endpoint-surface";

import { fetchPageWithRetry } from "@squirrelscan/crawler/fetcher";
import { RuleRunner } from "@squirrelscan/rules/runner";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("rendered-requests-controller-4188");

const RENDERED_PATH = "/api/rendered-only";

const crawlerCore = await import("@/crawler/core");
const createRealCrawler = crawlerCore.createCrawler;

let server: ReturnType<typeof Bun.serve>;

const createCrawlerSpy = spyOn(crawlerCore, "createCrawler").mockImplementation(
  (options = {}) =>
    createRealCrawler({
      ...options,
      fetcher: (url, fetchOptions) =>
        fetchPageWithRetry(url, fetchOptions).pipe(
          Effect.map((result) =>
            result.contentType?.includes("text/html")
              ? {
                  ...result,
                  renderedRequests: [
                    {
                      url: new URL(RENDERED_PATH, server.url).href,
                      method: "POST",
                      resourceType: "fetch",
                    } satisfies RenderedRequest,
                  ],
                }
              : result
          )
        ),
    })
);

const surfaces: EndpointSurface[] = [];
const realRunSiteRules = RuleRunner.prototype.runSiteRules;
const runSiteRulesSpy = spyOn(
  RuleRunner.prototype,
  "runSiteRules"
).mockImplementation(function (
  this: RuleRunner,
  ...args: Parameters<RuleRunner["runSiteRules"]>
) {
  if (args[3]) surfaces.push(args[3]);
  return realRunSiteRules.apply(this, args);
});

const { runAudit } = await import("@/controllers/audit");

const scratch = mkdtempSync(join(tmpdir(), "squirrel-rendered-requests-"));
const configPath = join(scratch, "squirrel.toml");

beforeAll(() => {
  writeFileSync(configPath, "");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      // No script or markup names the endpoint: only the render can find it.
      return new Response(
        '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><h1>Fixture</h1></body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
  createCrawlerSpy.mockRestore();
  runSiteRulesSpy.mockRestore();
});

describe("rendered requests on the CLI audit path (repo#4188)", () => {
  test("a request the render issued is a `render` endpoint candidate", async () => {
    const result = await runAudit({
      url: server.url.origin,
      projectName: "rendered-requests-controller-4188",
      configPath,
      maxPages: 1,
      coverageMode: "surface",
      offline: true,
      refresh: true,
      disableDiscoveryProbes: true,
      ruleInclude: ["security/cookie-flags"],
    });

    if (!result.ok) throw new Error(`audit failed: ${result.error.message}`);
    expect(createCrawlerSpy).toHaveBeenCalled();
    expect(surfaces.length).toBeGreaterThan(0);
    const rendered = surfaces
      .flatMap((surface) => surface.candidates)
      .filter((candidate) => candidate.source === "render");
    expect(
      rendered.map((candidate) => new URL(candidate.url).pathname)
    ).toEqual([RENDERED_PATH]);
  }, 30_000);
});
