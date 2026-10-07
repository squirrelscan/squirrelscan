// security/mixed-content - resource contexts (synthetic fixtures only).

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { isLoopbackHost, mixedContentRule } from "../../src/security/mixed-content";
import type { RuleContext } from "../../src/types";

const URL = "https://example.com/";

function run(head: string, body = "", url = URL) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>${head}</head><body>${body}</body></html>`;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, scripts: [] },
  } as unknown as RuleContext;
  const checks = mixedContentRule.run(ctx).checks;
  return {
    mixed: checks.find((c) => c.name === "mixed-content"),
    local: checks.find((c) => c.name === "local-development-url"),
  };
}

describe("security/mixed-content contexts (#2300)", () => {
  test("http canonical and alternate links are not fetched resources", () => {
    const { mixed, local } = run(
      `<link rel="canonical" href="http://example.com/"><link rel="alternate" hreflang="fr" href="http://example.com/fr"><link rel="alternate" type="application/rss+xml" href="http://example.com/feed">`,
    );
    expect(mixed?.status).toBe("pass");
    expect(local).toBeUndefined();
  });

  test("stylesheet links keep tag, rel and attribute and are potentially blocked", () => {
    const { mixed } = run(`<link rel="stylesheet" href="http://cdn.example.net/a.css">`);
    expect(mixed?.status).toBe("fail");
    expect(mixed?.items?.[0]).toMatchObject({
      id: "http://cdn.example.net/a.css",
      label: `<link rel="stylesheet" href>`,
      meta: { tag: "link", attribute: "href", rel: "stylesheet", kind: "potentially-blocked", evidence: "static-markup" },
    });
  });

  test("scripts, iframes and objects are potentially blocked with their attribute", () => {
    const { mixed } = run(
      `<script src="http://cdn.example.net/a.js"></script>`,
      `<iframe src="http://cdn.example.net/f"></iframe><object data="http://cdn.example.net/o"></object>`,
    );
    const metas = mixed?.items?.map((i) => i.meta);
    expect(metas).toEqual([
      expect.objectContaining({ tag: "script", attribute: "src", kind: "potentially-blocked" }),
      expect.objectContaining({ tag: "iframe", attribute: "src", kind: "potentially-blocked" }),
      expect.objectContaining({ tag: "object", attribute: "data", kind: "potentially-blocked" }),
    ]);
    expect(mixed?.message).toContain("3 potentially blocked");
  });

  test("images, media and icons are potentially upgraded, not blocked", () => {
    const { mixed } = run(
      `<link rel="icon" href="http://cdn.example.net/i.png">`,
      `<img src="http://cdn.example.net/p.jpg" alt=""><video src="http://cdn.example.net/v.mp4"></video>`,
    );
    expect(mixed?.items).toHaveLength(3);
    expect(mixed?.items?.every((i) => i.meta?.kind === "potentially-upgraded")).toBe(true);
    expect(mixed?.message).toContain("3 potentially upgraded");
    expect(mixed?.message).not.toContain("potentially blocked");
  });

  test("an image on an IP-literal host is blocked rather than upgraded", () => {
    const { mixed } = run("", `<img src="http://203.0.113.7/p.jpg" alt="">`);
    expect(mixed?.items?.[0]?.meta?.kind).toBe("potentially-blocked");
  });

  test("preload follows its `as` destination", () => {
    const { mixed } = run(
      `<link rel="preload" as="script" href="http://cdn.example.net/a.js"><link rel="preload" as="image" href="http://cdn.example.net/a.png">`,
    );
    expect(mixed?.items?.map((i) => i.meta?.kind)).toEqual(["potentially-blocked", "potentially-upgraded"]);
  });

  test("loopback URLs are not mixed content but get a separate local-development warning", () => {
    const { mixed, local } = run(
      `<script src="http://localhost:3000/a.js"></script>`,
      `<img src="http://127.0.0.1/p.jpg" alt=""><img src="http://app.localhost/p.jpg" alt=""><img src="http://[::1]/p.jpg" alt="">`,
    );
    expect(mixed?.status).toBe("pass");
    expect(local?.status).toBe("warn");
    expect(local?.items).toHaveLength(4);
    expect(local?.items?.find((i) => i.meta?.tag === "script")?.meta).toMatchObject({ tag: "script", attribute: "src", kind: "local-development" });
  });

  test("loopback matching does not cover lookalike hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.9.9.9")).toBe(true);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
  });

  test("a non-HTTPS page is not applicable", () => {
    const { mixed } = run(`<script src="http://cdn.example.net/a.js"></script>`, "", "http://example.com/");
    expect(mixed?.status).toBe("info");
  });
});
