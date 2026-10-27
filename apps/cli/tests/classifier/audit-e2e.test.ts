// #2307, end to end: a real local audit of a fixture site, with the page classifier on and off.
// The classifier-on run stores a classification per page; the off run is markup-only. Both say
// where a broken link sits when the markup does (footer, page content), because markup wins.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { runAudit } from "../../src/controllers/audit";
import { createStorage } from "../../src/crawler/storage";
import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("squirrel-classifier-e2e");

const FILLER =
  "A fixture paragraph about crawling queues and redirects. ".repeat(12);

const PAGES: Record<string, string> = {
  "/": `<!doctype html><html lang="en"><head><title>Fixture home</title></head><body>
<header><nav><a href="/post">Post</a></nav></header>
<main><h1>Fixture home</h1><p>${FILLER}</p>
<p><a href="/gone-body">Removed in body</a></p></main>
<footer><a href="/gone-footer">Removed in footer</a></footer></body></html>`,
  "/post": `<!doctype html><html lang="en"><head><title>A fixture post</title></head><body>
<header><nav><a href="/">Home</a></nav></header>
<main><article><h1>A fixture post</h1><p>${FILLER}</p></article></main>
<footer><a href="/gone-footer">Removed in footer</a></footer></body></html>`,
};

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const html = PAGES[new URL(req.url).pathname];
      return html
        ? new Response(html, { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

async function audit(projectName: string, classifierEnabled: boolean) {
  const result = await runAudit({
    url: base,
    projectName,
    maxPages: 5,
    offline: true,
    refresh: true,
    ...(classifierEnabled ? {} : { classifierEnabled: false }),
  });
  if (!result.ok) throw new Error(`audit failed: ${result.error.message}`);
  const report = result.data;
  const storage = await Effect.runPromise(createStorage({ projectName }));
  const pages = await Effect.runPromise(storage.getPages(report.crawlId!));
  const parsed = pages
    .filter((page) => page.parsedData)
    .map((page) => JSON.parse(page.parsedData!) as Record<string, unknown>);
  const broken = report.siteChecks
    .filter((check) => check.name === "broken-links")
    .flatMap((check) => check.items ?? []);
  return { parsed, broken };
}

describe("squirrel audit with the page classifier", () => {
  test("on: each page stores a classification, markup still names the link sections", async () => {
    const { parsed, broken } = await audit("classifier-e2e-on", true);
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    for (const page of parsed) {
      const classification = page.classification as {
        pageType: { label: string; source: string };
        degraded: string;
      };
      expect(typeof classification.pageType.label).toBe("string");
      expect(["model", "rules"]).toContain(classification.pageType.source);
      expect(classification.degraded).toBe("");
    }
    const labels = broken.map((item) => item.label ?? "");
    expect(
      labels.some(
        (l) => l.includes("/gone-footer") && l.includes("linked in the footer")
      )
    ).toBe(true);
    expect(
      labels.some(
        (l) => l.includes("/gone-body") && l.includes("the page content")
      )
    ).toBe(true);
  }, 60_000);

  test("off: no classification stored, same markup sections, no model provenance", async () => {
    const { parsed, broken } = await audit("classifier-e2e-off", false);
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    for (const page of parsed) {
      expect("classification" in page).toBe(false);
      for (const link of page.links as Record<string, unknown>[]) {
        expect("sectionSource" in link).toBe(false);
      }
    }
    const labels = broken.map((item) => item.label ?? "");
    expect(
      labels.some(
        (l) => l.includes("/gone-footer") && l.includes("linked in the footer")
      )
    ).toBe(true);
    expect(
      labels.some(
        (l) => l.includes("/gone-body") && l.includes("the page content")
      )
    ).toBe(true);
  }, 60_000);
});
