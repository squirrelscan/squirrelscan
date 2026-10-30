// #1327: the probes before the page rules stop at their deadline. Nothing is dispatched after it, a
// request in flight is aborted, and a probe is only "skipped" when it had work to do.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { withinDeadline } from "../src/adapter";
import { runCloakingProbe, selectCloakingPaths, type SelectedProbe } from "../src/cloaking-probe";
import {
  confirmSoft404Candidates,
  hasSoft404FetchWork,
  markUnresolvedSoft404,
  type Soft404ConfirmPage,
} from "../src/soft404-confirm";

const SHELL_HTML = `<!doctype html><html id="__next_error__"><head><meta name="robots" content="noindex"/><title>Page Not Found | Example</title></head><body><main><h1>Page Not Found</h1><p>The page does not exist.</p></main></body></html>`;
const shell = (path: string, rendered = false): Soft404ConfirmPage => {
  const url = `https://example.com${path}`;
  return { url, statusCode: 200, parsed: parsePage(SHELL_HTML, url), rendered };
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("withinDeadline", () => {
  test("no deadline runs the work and returns its value", async () => {
    expect(await withinDeadline(async () => 7, undefined)).toEqual({ timedOut: false, value: 7 });
  });
  test("a deadline already passed does not call the work", async () => {
    let called = 0;
    const r = await withinDeadline(async () => ++called, Date.now() - 1);
    expect(r).toEqual({ timedOut: true, started: false });
    expect(called).toBe(0);
  });
  test("work that outlives the deadline is cut and told to cancel", async () => {
    let cancelled = false;
    const r = await withinDeadline(
      (cancel) =>
        new Promise<number>((resolve) => {
          cancel.addEventListener("abort", () => (cancelled = true));
          setTimeout(() => resolve(1), 500);
        }),
      Date.now() + 30,
    );
    expect(r).toEqual({ timedOut: true, started: true });
    expect(cancelled).toBe(true);
  });
  test("work that finishes in time returns its value, and a late rejection is not unhandled", async () => {
    expect(await withinDeadline(async () => "ok", Date.now() + 1000)).toEqual({ timedOut: false, value: "ok" });
    const r = await withinDeadline(() => sleep(60).then(() => Promise.reject(new Error("late"))), Date.now() + 10);
    expect(r).toEqual({ timedOut: true, started: true });
    await sleep(100);
  });
});

describe("soft-404 confirmation after the deadline", () => {
  test("a hung first re-fetch, then the deadline: no request is sent after it", async () => {
    const pages = Array.from({ length: 6 }, (_, i) => shell(`/missing-${i}`));
    let sentAfterDeadline = 0;
    let sent = 0;
    let deadlinePassed = false;
    const result = await withinDeadline(
      (cancel) =>
        confirmSoft404Candidates(
          pages,
          { userAgent: "t", signal: cancel, concurrency: 1 },
          async () => {
            sent++;
            if (deadlinePassed) sentAfterDeadline++;
            // The first re-fetch hangs until the pass is cancelled, then ends like an aborted fetch.
            await new Promise<void>((resolve) => cancel.addEventListener("abort", () => resolve()));
            return { status: 0, body: "", error: "aborted" };
          },
        ),
      Date.now() + 40,
    );
    deadlinePassed = true;
    expect(result.timedOut).toBe(true);
    await sleep(60);
    expect(sent).toBe(1);
    expect(sentAfterDeadline).toBe(0);
    // Every candidate has a verdict, none was dropped.
    markUnresolvedSoft404(pages);
    expect(pages.every((p) => p.parsed.soft404Confirmation === "unconfirmed")).toBe(true);
  });

  test("a deadline that falls inside the per-host delay stops the next re-fetch", async () => {
    const pages = [shell("/a"), shell("/b"), shell("/c")];
    const controller = new AbortController();
    let sent = 0;
    await confirmSoft404Candidates(
      pages,
      {
        userAgent: "t",
        signal: controller.signal,
        concurrency: 1,
        perHostDelayMs: 1000,
        // The deadline passes while the pass waits out the politeness delay.
        sleep: async () => controller.abort(),
      },
      async () => {
        sent++;
        return { status: 404, body: "" };
      },
    );
    expect(sent).toBe(1);
    expect(pages.map((p) => p.parsed.soft404Confirmation)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
  });

  test("markUnresolvedSoft404 keeps a verdict already written and ignores non-candidates", () => {
    const done = shell("/a");
    done.parsed.soft404Confirmation = "confirmed";
    const open = shell("/b");
    const real = { url: "https://example.com/ok", statusCode: 200, parsed: parsePage("<html><head><title>Hello</title></head><body><p>" + "text ".repeat(300) + "</p></body></html>", "https://example.com/ok") };
    markUnresolvedSoft404([done, open, real]);
    expect(done.parsed.soft404Confirmation).toBe("confirmed");
    expect(open.parsed.soft404Confirmation).toBe("unconfirmed");
    expect(real.parsed.soft404Confirmation).toBeUndefined();
  });

  test("hasSoft404FetchWork is false with no candidate, a rendered one only, or the pass off", () => {
    expect(hasSoft404FetchWork([], undefined)).toBe(false);
    expect(hasSoft404FetchWork([shell("/a", true)], undefined)).toBe(false);
    expect(hasSoft404FetchWork([shell("/a")], false)).toBe(false);
    expect(hasSoft404FetchWork([shell("/a")], undefined)).toBe(true);
  });
});

describe("cloaking probe after the deadline", () => {
  const selected = (n: number): SelectedProbe[] =>
    Array.from({ length: n }, (_, i) => ({ url: `https://example.com/p${i}`, normalizedUrl: `https://example.com/p${i}`, reason: "recent" }) as unknown as SelectedProbe);
  const OPTS = { maxPages: 10, queryVariation: true, googlebotUserAgent: "gb", defaultUserAgent: "ua", concurrency: 1 };

  test("a cancelled probe dispatches nothing further", async () => {
    const controller = new AbortController();
    let sent = 0;
    const out = await runCloakingProbe(selected(5), { ...OPTS, signal: controller.signal }, async () => {
      sent++;
      controller.abort();
      return { status: 200, body: "x" };
    });
    expect(sent).toBe(1);
    expect(out).toEqual([]);
  });

  test("an uncancelled probe runs every path", async () => {
    let sent = 0;
    const out = await runCloakingProbe(selected(2), { ...OPTS, signal: new AbortController().signal }, async () => {
      sent++;
      return { status: 200, body: "same" };
    });
    expect(out).toHaveLength(2);
    expect(sent).toBe(6);
  });
});

describe("selectCloakingPaths", () => {
  const page = (path: string, links: string[] = []) => ({
    url: `https://example.com${path}`,
    statusCode: 200,
    parsed: { links: links.map((l) => ({ url: `https://example.com${l}`, isInternal: true })) },
  });
  test("a site with only its home page has nothing to probe", () => {
    expect(selectCloakingPaths({ baseUrl: "https://example.com/", pages: [page("/")], sitemapUrls: [] }, { maxPages: 5, recentDays: 30 })).toEqual([]);
  });
  test("a zero cap selects nothing", () => {
    const site = { baseUrl: "https://example.com/", pages: [page("/", ["/orphan"]), page("/orphan")], sitemapUrls: [{ loc: "https://example.com/orphan", lastmod: new Date().toISOString() }] };
    expect(selectCloakingPaths(site, { maxPages: 0, recentDays: 30 })).toEqual([]);
  });
});
