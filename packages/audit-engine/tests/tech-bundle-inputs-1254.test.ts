// #1254: the bundles the crawl already fetched reach tech detection through one
// shared builder (local scan and cloud payload). Caps are per bundle, per page
// and per audit; a body is attached to one page only; nothing is refetched.

import { describe, expect, test } from "bun:test";

import { detectReportTechnologiesMulti } from "../src/technologies";
import { buildTechInputs, type TechBundleLimits } from "../src/technologies";

const LIMITS: TechBundleLimits = { bundleBytes: 100, pageBytes: 250, auditBytes: 400 };
const html = (src: string) => `<html><body><script src="${src}"></script></body></html>`;
const page = (url: string, src = "/a.js") => ({ url, headers: {}, html: html(src) });
const body = (n: number, ch = "x") => ch.repeat(n);

describe("buildTechInputs", () => {
  test("cuts each bundle to bundleBytes", () => {
    const [home] = buildTechInputs(
      [page("https://example.com/")],
      [{ url: "https://example.com/a.js", content: body(500) }],
      LIMITS,
    );
    expect(home?.scripts?.find((s) => s.url === "https://example.com/a.js")?.content).toHaveLength(100);
  });

  test("bundleBytes 0 attaches no bodies but keeps every script URL", () => {
    const [home] = buildTechInputs(
      [page("https://example.com/")],
      [{ url: "https://example.com/a.js", content: "abc" }],
      { ...LIMITS, bundleBytes: 0 },
    );
    expect(home?.scripts?.every((s) => s.content === undefined)).toBe(true);
    expect(home?.scripts?.map((s) => s.url)).toContain("https://example.com/a.js");
  });

  test("caps a page's bodies, then the audit's, dropping the body and keeping the URL", () => {
    const scripts = ["a", "b", "c"].map((n) => ({
      url: `https://example.com/${n}.js`,
      content: body(100, n),
      sourcePages: ["https://example.com/"],
    }));
    const [home] = buildTechInputs([page("https://example.com/")], scripts, LIMITS);
    const bodies = (home?.scripts ?? []).filter((s) => s.content);
    // pageBytes 250: two full bundles and half of a third
    expect(bodies.map((s) => s.content?.length)).toEqual([100, 100, 50]);
    expect(home?.scripts?.length).toBe(4); // the three bundles + the html src
  });

  test("a bundle shared by pages carries its body once, on the first page", () => {
    const shared = { url: "https://example.com/s.js", content: body(80), sourcePages: ["https://example.com/", "https://example.com/p2"] };
    const [home, second] = buildTechInputs(
      [page("https://example.com/"), page("https://example.com/p2", "/s.js")],
      [shared],
      LIMITS,
    );
    expect(home?.scripts?.find((s) => s.url === shared.url)?.content).toHaveLength(80);
    // nothing attached to page two: it keeps scanning its HTML for script URLs
    expect(second?.scripts).toBeUndefined();
  });

  test("a bundle belongs to the page that references it, matched by final or requested URL", () => {
    const own = { url: "https://example.com/own.js", content: "OWN", sourcePages: ["https://example.com/old"] };
    const [, second] = buildTechInputs(
      [page("https://example.com/"), { ...page("https://example.com/new"), requestedUrl: "https://example.com/old" }],
      [own],
      LIMITS,
    );
    expect(second?.scripts?.find((s) => s.url === own.url)?.content).toBe("OWN");
  });

  test("the audit cap bounds the total across pages", () => {
    const scripts = Array.from({ length: 6 }, (_, i) => ({
      url: `https://example.com/${i}.js`,
      content: body(100, String(i)),
      sourcePages: [i < 3 ? "https://example.com/" : "https://example.com/p2"],
    }));
    const inputs = buildTechInputs(
      [page("https://example.com/"), page("https://example.com/p2", "/3.js")],
      scripts,
      LIMITS,
    );
    const total = inputs
      .flatMap((p) => p.scripts ?? [])
      .reduce((sum, s) => sum + (s.content?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(LIMITS.auditBytes);
    expect(total).toBe(400);
  });

  test("counts UTF-8 bytes, not characters", () => {
    const [home] = buildTechInputs(
      [page("https://example.com/")],
      [{ url: "https://example.com/a.js", content: "あ".repeat(100) }],
      LIMITS,
    );
    const content = home?.scripts?.find((s) => s.url === "https://example.com/a.js")?.content ?? "";
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(100);
    expect(content).not.toContain("�");
  });
});

describe("floors, extras and top-up", () => {
  const big = { bundleBytes: 64 * 1024, pageBytes: 512 * 1024, auditBytes: 1024 * 1024 };

  test("30 scripts of 100 KB each all keep a body", () => {
    const scripts = Array.from({ length: 30 }, (_, i) => ({
      url: `https://example.com/s${i}.js`,
      content: body(100 * 1024, "abcdefghij"[i % 10]!),
      sourcePages: ["https://example.com/"],
    }));
    const [home] = buildTechInputs([page("https://example.com/")], scripts, big);
    const withBody = (home?.scripts ?? []).filter((s) => s.content);
    expect(withBody).toHaveLength(30);
    // the page cap (512 KB) bounds the total; every script got its 16 KB floor first
    const total = withBody.reduce((n, s) => n + (s.content?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(512 * 1024);
    expect(withBody.every((s) => (s.content?.length ?? 0) >= 16 * 1024)).toBe(true);
  });

  test("a vendor literal in the middle and the tail of a big bundle is sent", () => {
    const mid = `f("https://abcdefghijklmnopqrst.supabase.co","k")`;
    const tail = `{authDomain:"demo-app.firebaseapp.com"}`;
    const content = body(150_000) + mid + body(150_000) + tail;
    const [home] = buildTechInputs(
      [page("https://example.com/")],
      [{ url: "https://example.com/a.js", content, sourcePages: ["https://example.com/"] }],
      big,
    );
    const sent = home?.scripts?.find((s) => s.content)?.content ?? "";
    expect(sent.length).toBeLessThanOrEqual(64 * 1024);
    expect(sent).toContain(mid);
    expect(sent).toContain(tail);
  });

  test("a bundle cap above 64 KB is honoured", () => {
    const content = body(100_000, "a") + "MARK" + body(1000, "b");
    const [home] = buildTechInputs(
      [page("https://example.com/")],
      [{ url: "https://example.com/a.js", content, sourcePages: ["https://example.com/"] }],
      { bundleBytes: 262_144, pageBytes: 512 * 1024, auditBytes: 1024 * 1024 },
    );
    expect(home?.scripts?.find((s) => s.content)?.content).toContain("MARK");
  });
});

describe("end to end through the shared builder", () => {
  test("a Supabase client only in a bundle is reported", () => {
    const ref = "abcdefghijklmnopqrst";
    const inputs = buildTechInputs(
      [page("https://example.com/", "/assets/index-1.js")],
      [
        {
          url: "https://example.com/assets/index-1.js",
          content: `const sb=createClient("https://${ref}.supabase.co","k");`,
          sourcePages: ["https://example.com/"],
        },
      ],
    );
    const section = detectReportTechnologiesMulti(inputs);
    expect(section.items.map((t) => t.id)).toContain("supabase");
  });
});
