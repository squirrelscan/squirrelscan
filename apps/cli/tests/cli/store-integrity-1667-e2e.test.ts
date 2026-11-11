// A command that reads a stored audit says when its page bodies have been evicted (#1667), end to end
// with the real CLI in a subprocess: audit a local site, check `report`, `pages` and `entities` say
// nothing and carry no `storeIntegrity`, delete the content store (the extreme of eviction), and check
// all three print the notice on stderr and carry `storeIntegrity` in their JSON.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-1667-"));
const home = join(scratch, "home");
const contentStore = join(scratch, "content-store.db");

const PAGE = (path: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Store integrity fixture ${path}</title><meta name="description" content="A fixture page for the store integrity end to end test."><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","@id":"https://example.com/#org","name":"Example Org"}</script></head><body><main><h1>Fixture ${path}</h1><p>${"Plain words about nothing in particular. ".repeat(30)}</p><a href="/a">a</a> <a href="/b">b</a></main></body></html>`;

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/robots.txt")
      return new Response("User-agent: *\nAllow: /\n");
    if (pathname === "/" || pathname === "/a" || pathname === "/b") {
      return new Response(PAGE(pathname), {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("nf", { status: 404 });
  },
});
afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

async function squirrel(...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
    env: {
      ...env,
      HOME: home,
      SQUIRREL_NO_UPDATE: "1",
      SQUIRREL_CONTENT_STORE_PATH: contentStore,
      NO_TELEMETRY: "1",
      NO_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

const NOTICE =
  /Content store: (\d+) of (\d+) pages? stored for this audit are no longer in the local content store/;

describe("evicted page bodies", () => {
  test("a fresh audit: report, pages and entities say nothing and carry no storeIntegrity", async () => {
    const audit = await squirrel(
      "audit",
      `http://127.0.0.1:${site.port}/`,
      "--offline",
      "--http",
      "-m",
      "3",
      "-f",
      "json",
      "-o",
      join(scratch, "audit.json")
    );
    expect(audit.code).toBe(0);

    const report = await squirrel("report", "-f", "json");
    expect(report.err).not.toMatch(NOTICE);
    expect(JSON.parse(report.out).meta.storeIntegrity).toBeUndefined();

    const pages = await squirrel("pages", "-f", "json");
    expect(pages.err).not.toMatch(NOTICE);
    expect(JSON.parse(pages.out).storeIntegrity).toBeUndefined();

    const entities = await squirrel("entities", "-f", "json");
    expect(entities.err).not.toMatch(NOTICE);
    expect(JSON.parse(entities.out).storeIntegrity).toBeUndefined();
  }, 120_000);

  test("after the bodies are evicted, each says how many, on stderr and in its JSON", async () => {
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(`${contentStore}${suffix}`, { force: true });
    expect(existsSync(contentStore)).toBe(false);

    const report = await squirrel("report", "-f", "json");
    expect(report.err).toMatch(NOTICE);
    const reportJson = JSON.parse(report.out);
    expect(reportJson.meta.storeIntegrity).toMatchObject({ status: "evicted" });
    expect(reportJson.meta.storeIntegrity.evicted).toBeGreaterThan(0);

    const pages = await squirrel("pages", "-f", "json");
    expect(pages.err).toMatch(NOTICE);
    const pagesJson = JSON.parse(pages.out);
    expect(pagesJson.storeIntegrity).toMatchObject({ status: "evicted" });
    // The rows themselves are unaffected: they come from the stored page data.
    expect(pagesJson.pages.length).toBeGreaterThan(0);

    const entities = await squirrel("entities", "-f", "json");
    expect(entities.err).toMatch(NOTICE);
    const entitiesJson = JSON.parse(entities.out);
    expect(entitiesJson.storeIntegrity).toMatchObject({ status: "evicted" });
    expect(entitiesJson.nodes.length).toBeGreaterThan(0);

    // The same count everywhere: one census.
    const counts = [
      reportJson.meta.storeIntegrity,
      pagesJson.storeIntegrity,
      entitiesJson.storeIntegrity,
    ].map((i) => [i.evicted, i.stored]);
    expect(new Set(counts.map((c) => c.join("/"))).size).toBe(1);
  }, 120_000);

  test("the count in the notice is the count in the JSON", async () => {
    const pages = await squirrel("pages", "-f", "json");
    const match = NOTICE.exec(pages.err);
    const json = JSON.parse(pages.out).storeIntegrity;
    expect([Number(match?.[1]), Number(match?.[2])]).toEqual([
      json.evicted,
      json.stored,
    ]);
  }, 60_000);
});
