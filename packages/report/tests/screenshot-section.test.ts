// Screenshot in the report header (#241, #254): the published report embeds a
// best-effort website screenshot. The <img> is a plain JSX element (React
// escapes src/alt). The screenshot is captured after the audit, so its URL may
// 404 for a while: the page's one static script hides the frame
// ([data-hide-scope]) of any [data-hide-broken] image that fails to load, with
// no per-element inline onerror. These tests pin: presence gating, the hide
// hook, absence, non-http rejection (sanitizeUrl), attribute-breakout escaping,
// and that the inline scripts are the same bytes for every report.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderHtml } from "../src/output/html";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

/** Executable inline scripts (not the application/json data blocks). */
const inlineScripts = (html: string): string[] =>
  [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)]
    .filter((m) => !/type="application\/json"/i.test(m[1]!))
    .map((m) => m[2]!);

describe("Screenshot", () => {
  test("(a) present screenshotUrl renders the framed img with the hide-on-error hooks", () => {
    const html = renderHtml(
      baseReport({ screenshotUrl: "https://assets.squirrelscan.com/shots/abc.png" }),
    );
    expect(html).toMatch(/<a[^>]*class="screenshot-section[^"]*"[^>]*data-hide-scope="true"/);
    expect(html).toContain('src="https://assets.squirrelscan.com/shots/abc.png"');
    expect(html).toMatch(/<img[^>]*abc\.png"[^>]*data-hide-broken="true"/);
    // No per-element inline onerror handler (CSP-unsafe) on the img.
    expect(html).not.toContain("onerror=");
    // The static page script hides the image's frame when it fails to load.
    expect(inlineScripts(html).join("")).toContain('closest("[data-hide-scope]")');
  });

  test("(b) absent screenshotUrl renders no screenshot markup and no image", () => {
    const html = renderHtml(baseReport());
    expect(html).not.toContain("screenshot-section");
    expect(html).not.toContain(">Screenshot</h2>");
    expect(html).not.toContain("<img");
  });

  test("(c) non-http (javascript:) URL is rejected", () => {
    const html = renderHtml(baseReport({ screenshotUrl: "javascript:alert(1)" }));
    expect(html).not.toContain("screenshot-section");
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("<img");
  });

  test("(d) a URL containing a quote is escaped (no raw attribute breakout)", () => {
    const html = renderHtml(
      baseReport({
        screenshotUrl: 'https://evil.example.com/x.png"onerror="alert(1)',
      }),
    );
    // The raw double-quote breakout must never appear unescaped.
    expect(html).not.toContain('x.png"onerror="alert(1)');
    // React HTML-escapes the attribute value instead.
    expect(html).toContain("x.png&quot;onerror=&quot;alert(1)");
  });

  test("(e) inline scripts carry no report data: the same bytes for every report", () => {
    // Report data reaches the page only as escaped application/json blocks, so
    // the executable scripts stay hashable (CSP script-src 'sha256-...').
    const a = inlineScripts(renderHtml(baseReport()));
    const b = inlineScripts(
      renderHtml(
        baseReport({
          baseUrl: "https://other.example/",
          screenshotUrl: "https://assets.squirrelscan.com/shots/abc.png",
          homepage: { title: "</script><script>alert(1)</script>", description: null },
        }),
      ),
    );
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});
