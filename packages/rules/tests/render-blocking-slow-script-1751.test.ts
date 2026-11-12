// perf/render-blocking lists a synchronous head script and flags a slow one (#1751).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { renderBlockingRule } from "../src/performance/render-blocking";
import type { CheckResult, RuleContext, SiteData } from "../src/types";

const URL = "https://example.com/";

function run(
  head: string,
  timings: Record<string, number | undefined>,
  hostFirst: string[] = [],
): CheckResult[] {
  const html = `<!doctype html><html><head><title>scripts</title>${head}</head><body><h1>Test</h1></body></html>`;
  const parsed = parsePage(html, URL);
  const scripts = Object.entries(timings).map(([path, responseMs]) => ({
    url: `https://example.com${path}`,
    status: 200,
    error: null,
    contentType: "application/javascript",
    sizeBytes: 10,
    content: "x",
    sourcePages: [URL],
    ...(responseMs === undefined ? {} : { responseMs }),
    ...(hostFirst.includes(path) ? { hostFirst: true } : {}),
  }));
  const ctx: RuleContext = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
    site: { scripts } as unknown as SiteData,
  };
  return (renderBlockingRule.run(ctx) as { checks: CheckResult[] }).checks;
}

const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

describe("perf/render-blocking script reporting (#1751)", () => {
  test("a synchronous head script is listed with its URL next to the stylesheet", () => {
    const checks = run(
      `<link rel="stylesheet" href="/a.css"><script src="/_fault/slow.js"></script>`,
      {},
    );
    const c = named(checks, "render-blocking")!;
    expect(c.message).toBe("2 render-blocking resource(s)");
    expect(c.items?.map((i) => i.id)).toEqual(["/a.css", "/_fault/slow.js"]);
  });

  test("a blocking script over 1 s warns with the measured time", () => {
    const checks = run(`<script src="/_fault/slow.js"></script>`, { "/_fault/slow.js": 2512 });
    const c = named(checks, "slow-blocking-script")!;
    expect(c.status).toBe("warn");
    expect(c.message).toContain("2512 ms");
    expect(c.items).toEqual([
      {
        id: "https://example.com/_fault/slow.js",
        meta: { responseMs: 2512, thresholdMs: 1000 },
      },
    ]);
  });

  test("hysteresis: 1 to 2 s counts only from a warm host, over 2 s always counts (#1751)", () => {
    const head = `<script src="/cold.js"></script>`;
    // The first script of its host paid for DNS and TLS in that time: not reported at 1.5 s.
    expect(named(run(head, { "/cold.js": 1500 }, ["/cold.js"]), "slow-blocking-script")).toBeUndefined();
    // The same time from a warm host is a slow script.
    expect(named(run(head, { "/cold.js": 1500 }), "slow-blocking-script")?.status).toBe("warn");
    // Over 2 s is reported whatever the connection cost.
    expect(named(run(head, { "/cold.js": 2001 }, ["/cold.js"]), "slow-blocking-script")?.status).toBe("warn");
    // The boundaries are exclusive.
    expect(named(run(head, { "/cold.js": 1000 }), "slow-blocking-script")).toBeUndefined();
    expect(named(run(head, { "/cold.js": 2000 }, ["/cold.js"]), "slow-blocking-script")).toBeUndefined();
  });

  test("fast, unmeasured and non-blocking scripts raise nothing", () => {
    const head = `<script src="/fast.js"></script><script src="/unknown.js"></script><script defer src="/d.js"></script><script async src="/e.js"></script>`;
    const checks = run(head, {
      "/fast.js": 1000,
      "/unknown.js": undefined,
      "/d.js": 5000,
      "/e.js": 5000,
    });
    expect(named(checks, "slow-blocking-script")).toBeUndefined();
  });

  test("a slow script in the body is not a head blocker", () => {
    const html = `<!doctype html><html><head><title>t</title></head><body><script src="/b.js"></script></body></html>`;
    const parsed = parsePage(html, URL);
    const ctx = {
      page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
      parsed,
      options: {},
      site: {
        scripts: [{ url: "https://example.com/b.js", responseMs: 4000, sourcePages: [URL] }],
      },
    } as unknown as RuleContext;
    const checks = (renderBlockingRule.run(ctx) as { checks: CheckResult[] }).checks;
    expect(named(checks, "slow-blocking-script")).toBeUndefined();
  });
});
