// Offline mode (the default): a local HTML report opens with no network
// request. No remote image (favicon, technology icons), no stylesheet or
// script from anywhere else, no remote font or CSS url(). Links (<a href>) are
// fine: they load nothing until clicked. The cloud passes `offline: false` to
// show first-party tech icons and the stored favicon.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderHtml } from "../src/output/html";

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 3,
    passed: 4,
    warnings: 1,
    failed: 1,
    homepage: { title: "Example", description: "An example site" },
    technologies: {
      items: [
        {
          id: "react",
          name: "React",
          category: "framework",
          version: null,
          confidence: "high",
          detectedBy: "script",
          icon: "react",
        },
      ],
      added: [],
      removed: [],
      firstScan: true,
    },
    editorSummary: {
      prose: "Summary paragraph.",
      bigTicket: [],
      verdict: "Fix the titles.",
      model: "test-model",
      generatedAt: "2026-06-16T14:30:00.000Z",
      priorities: [
        {
          title: "Fix the titles",
          why: "They are missing.",
          action: "Add a title to every page.",
          effort: "quick-win",
          ruleIds: ["core/meta-title"],
          technologies: ["react"],
        },
      ],
    },
    healthScore: {
      overall: 72,
      categories: [],
      groups: [
        { group: "seo", name: "SEO", score: 60, passed: 2, warnings: 1, failed: 1, total: 4 },
      ],
      errorCount: 1,
      warningCount: 1,
      passedCount: 2,
    },
    ruleResults: {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          description: "Checks the title.",
          solution: "Add a title.",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 5,
        },
        checks: [
          { name: "t", status: "fail", message: "Missing title", pages: ["https://example.com/a"] },
        ],
      },
    },
    ...overrides,
  };
}

/** Every attribute or CSS value that would make the browser fetch something on load. */
function remoteLoads(html: string): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(
    /<(img|script|iframe|source|video|audio|embed|object)\b[^>]*\b(src|data|srcset|poster)="([^"]*)"/g,
  ))
    found.push(`${m[1]} ${m[2]}=${m[3]}`);
  for (const m of html.matchAll(/<link\b[^>]*>/g)) found.push(m[0]);
  for (const m of html.matchAll(/url\(\s*['"]?(https?:|\/\/)[^)]*\)/g)) found.push(m[0]);
  for (const m of html.matchAll(/@import\s+(url\()?['"]?(https?:|\/\/)/g)) found.push(m[0]);
  return found;
}

describe("offline (default)", () => {
  test("a full report makes no remote request on load", () => {
    const html = renderHtml(report());
    expect(remoteLoads(html)).toEqual([]);
    expect(html).not.toContain("<img");
  });

  test("tech icons are never emitted, even with offline left implicit", () => {
    const html = renderHtml(report());
    expect(html).not.toContain("squirrelscan.com/tech-icons");
    // The technology itself still shows, as text.
    expect(html).toContain("React");
  });

  test("faviconUrl is ignored: the initial-letter tile renders instead", () => {
    const html = renderHtml(report(), {
      faviconUrl: "https://assets.squirrelscan.com/favicons/x.png",
    });
    expect(html).not.toContain("assets.squirrelscan.com/favicons");
    expect(html).toMatch(/<span class="site-favicon [^"]*" aria-hidden="true">E<\/span>/);
    expect(remoteLoads(html)).toEqual([]);
  });

  test("explicit offline: true matches the default byte for byte", () => {
    expect(renderHtml(report(), { offline: true })).toBe(renderHtml(report()));
  });

  test("keeps the inline scripts and the icon sprite, and remote links", () => {
    const html = renderHtml(report());
    expect(html).toContain('<symbol id="i-copy"');
    expect(html).toContain('<use href="#i-caret"');
    expect(html).toContain('id="fix-prompts"');
    expect(html).toMatch(/<script>[^<]*navigator\.clipboard/);
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('href="https://docs.squirrelscan.com/rules/core/meta-title"');
  });

  test("the stylesheet is inlined, with no remote font or image", () => {
    const html = renderHtml(report());
    const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("");
    expect(css.length).toBeGreaterThan(10_000);
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toContain("@font-face");
  });
});

describe("online (offline: false, the cloud)", () => {
  test("first-party tech icons and the favicon render", () => {
    const html = renderHtml(report(), {
      offline: false,
      faviconUrl: "https://assets.squirrelscan.com/favicons/x.png",
    });
    expect(html).toContain('src="https://squirrelscan.com/tech-icons/react.png"');
    expect(html).toMatch(
      /<img [^>]*src="https:\/\/assets\.squirrelscan\.com\/favicons\/x\.png"[^>]*data-favicon/,
    );
    // Each image hides itself (not a broken icon) if it fails to load.
    expect(html).toMatch(/<img [^>]*react\.png"[^>]*data-hide-broken/);
  });

  test("a non-http favicon is refused and falls back to the tile", () => {
    for (const faviconUrl of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "//evil.example/x.png",
    ]) {
      const html = renderHtml(report(), { offline: false, faviconUrl });
      expect(html).not.toContain(faviconUrl);
      expect(html).toContain('<span class="site-favicon ');
    }
  });

  test("a favicon URL with a quote cannot break out of the attribute", () => {
    const html = renderHtml(report(), {
      offline: false,
      faviconUrl: 'https://example.com/f.png" onload="alert(1)',
    });
    expect(html).not.toContain('f.png" onload=');
    expect(html).toContain("f.png&quot; onload=&quot;alert(1)");
  });
});
