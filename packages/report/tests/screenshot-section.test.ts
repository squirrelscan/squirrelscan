// ScreenshotSection HTML output (#241, #254): the published report embeds a
// best-effort website screenshot. The <img> is a plain JSX element (React
// escapes src/alt), and a SINGLE static inline <script> — emitted once per page
// — hides any `.screenshot-section` whose image fails to load. That one static
// script is CSP-whitelistable by hash (no per-element inline onerror, no
// script-src 'unsafe-inline'). These tests pin: presence gating, the static
// hide-script, absence (no markup AND no script), non-http rejection
// (sanitizeUrl), and attribute-breakout escaping.

import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderHtml, SCREENSHOT_HIDE_SCRIPT } from "../src/output/html";

// The CSP hash documented in html.tsx (script-src 'sha256-…'). If the hide
// script changes without updating this, a real CSP silently blocks it in prod.
const DOCUMENTED_CSP_HASH = "Fu8mj2B5SuCv4ph95rAxY9dudvmYaovfauNXB3wX6X0=";

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

describe("ScreenshotSection", () => {
  test("(a) present screenshotUrl renders the img + section frame + static hide-script", () => {
    const html = renderHtml(
      baseReport({ screenshotUrl: "https://assets.squirrelscan.com/shots/abc.png" }),
    );
    expect(html).toContain('class="screenshot-section"');
    expect(html).toContain('class="screenshot-frame"');
    expect(html).toContain("https://assets.squirrelscan.com/shots/abc.png");
    // No per-element inline onerror handler (CSP-unsafe) on the img.
    expect(html).not.toContain("onerror=");
    // The single static hide-on-error script must be present verbatim and once.
    expect(html).toContain('document.querySelectorAll(".screenshot-section img")');
    expect(html).toContain('this.closest(".screenshot-section")');
    expect(html).toContain('s.style.display="none"');
    expect(html.match(/document\.querySelectorAll/g)?.length).toBe(1);
  });

  test("(b) absent screenshotUrl renders no screenshot markup and no script", () => {
    const html = renderHtml(baseReport());
    // `.screenshot-section` / `.screenshot-frame` appear unconditionally in the
    // <style> block — assert on the rendered MARKUP (class="…" + heading) only.
    expect(html).not.toContain('class="screenshot-section"');
    expect(html).not.toContain('class="screenshot-frame"');
    expect(html).not.toContain(">Screenshot</h2>");
    // Reports without a screenshot stay fully script-free.
    expect(html).not.toContain("<script");
  });

  test("(c) non-http (javascript:) URL is rejected, no markup and no script", () => {
    const html = renderHtml(
      baseReport({ screenshotUrl: "javascript:alert(1)" }),
    );
    expect(html).not.toContain('class="screenshot-frame"');
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain(">Screenshot</h2>");
    expect(html).not.toContain("<script");
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
    expect(html).toContain("&quot;");
  });

  test("(e) sha256(SCREENSHOT_HIDE_SCRIPT) matches the documented CSP hash", () => {
    const hash = createHash("sha256")
      .update(SCREENSHOT_HIDE_SCRIPT)
      .digest("base64");
    expect(hash).toBe(DOCUMENTED_CSP_HASH);
  });
});
