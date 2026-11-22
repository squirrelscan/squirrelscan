// pub#425 controller path: the CSP violations a rendered page raised reach security/csp-violations.
//
// Runs the real CLI path end to end (crawl, streamed page rules) over a local server. The only stand-in
// is the crawl fetch seam, which marks each real HTML response as a cloud render and attaches the
// runtime a browser render would have recorded. Without the crawler's runtime sink, the engine's
// `renderRuntime` option and the controller wiring between them, the rule reads "not recorded".

import type { RenderRuntimeDiagnostics } from "@squirrelscan/core-contracts";
import type { CheckResult } from "@squirrelscan/core-contracts";

import { fetchPageWithRetry } from "@squirrelscan/crawler/fetcher";
import { RuleRunner } from "@squirrelscan/rules/runner";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("csp-violations-controller-425");

const RULE = "security/csp-violations";
const RUNTIME: RenderRuntimeDiagnostics = {
  cspViolations: [
    {
      effectiveDirective: "script-src-elem",
      violatedDirective: "script-src",
      blockedURI: "https://widget.bookingvendor.example.com/embed.js",
      disposition: "enforce",
    },
  ],
};

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
              ? { ...result, fetcherId: "cloud-render", renderRuntime: RUNTIME }
              : result
          )
        ),
    })
);

const ruleChecks: CheckResult[] = [];
const realRunPageRules = RuleRunner.prototype.runPageRules;
const runPageRulesSpy = spyOn(
  RuleRunner.prototype,
  "runPageRules"
).mockImplementation(async function (
  this: RuleRunner,
  ...args: Parameters<RuleRunner["runPageRules"]>
) {
  const result = await realRunPageRules.apply(this, args);
  const ran = result.ruleResults.get(RULE);
  if (ran) ruleChecks.push(...ran.checks);
  return result;
});

const { runAudit } = await import("@/controllers/audit");

const scratch = mkdtempSync(join(tmpdir(), "squirrel-csp-violations-"));
const configPath = join(scratch, "squirrel.toml");

beforeAll(() => {
  writeFileSync(configPath, "");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
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
  runPageRulesSpy.mockRestore();
});

describe("CSP violations on the CLI audit path (pub#425)", () => {
  test("a violation the render recorded is reported by security/csp-violations", async () => {
    const result = await runAudit({
      url: server.url.origin,
      projectName: "csp-violations-controller-425",
      configPath,
      maxPages: 1,
      coverageMode: "surface",
      offline: true,
      refresh: true,
      disableDiscoveryProbes: true,
      ruleInclude: [RULE],
    });

    if (!result.ok) throw new Error(`audit failed: ${result.error.message}`);
    expect(createCrawlerSpy).toHaveBeenCalled();
    expect(ruleChecks.length).toBeGreaterThan(0);
    const check = ruleChecks[0]!;
    expect(check.status).toBe("warn");
    expect(check.items?.[0]?.meta?.host).toBe(
      "widget.bookingvendor.example.com"
    );
    expect(check.items?.[0]?.meta?.directive).toBe("script-src-elem");
  }, 30_000);
});
