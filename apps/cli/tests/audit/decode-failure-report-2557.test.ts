// repo#2557: a crawl with one mislabelled response names the undecodable URL
// and its content-encoding in the report's partial reason and JSON, and in the
// text output next to it.

import { renderJson, renderText } from "@squirrelscan/report";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runAudit } from "../../src/controllers/audit";
import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("decode-failure-report-2557");

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
          '<!doctype html><html lang="en"><head><title>Fixture home page</title></head><body><h1>Fixture</h1><a href="/bad">Bad</a></body></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }
      if (pathname === "/bad") {
        return new Response("<!doctype html><title>plain</title>", {
          headers: { "content-type": "text/html", "content-encoding": "br" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = server.url.origin;
});

afterAll(() => {
  server.stop(true);
});

describe("a crawl with one mislabelled response", () => {
  test("lists the URL and encoding in the JSON and text reports", async () => {
    const result = await runAudit({
      url: origin,
      projectName: "decode-failure-report-2557",
      maxPages: 5,
      coverageMode: "surface",
      offline: true,
      refresh: true,
      smartAudits: true,
      disableDiscoveryProbes: true,
      ruleInclude: ["core/meta-title"],
    });
    if (!result.ok) throw new Error(`audit failed: ${result.error.message}`);
    const report = result.data;
    const badUrl = `${origin}/bad`;

    expect(report.status).toBe("partial");
    expect(report.undecodableFetches).toEqual([
      { url: badUrl, contentEncoding: "br" },
    ]);

    const json = JSON.parse(renderJson(report));
    expect(json.undecodableFetches).toEqual([
      { url: badUrl, contentEncoding: "br" },
    ]);

    const text = renderText(report);
    expect(text).toContain(`${badUrl} (content-encoding: br)`);
  }, 60_000);
});
