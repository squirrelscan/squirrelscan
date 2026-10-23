// Offline mode (the default): a local HTML report opens with no network
// request. No remote image (favicon, technology icons), no stylesheet or
// script from anywhere else, no remote font or CSS url(). Links (<a href>) are
// fine: they load nothing until clicked. The cloud passes `offline: false` to
// show first-party tech icons and the stored favicon.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderHtml, spriteSymbol } from "../src/output/html";

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

describe("caller-supplied URLs", () => {
  test("a non-http white-label logo is refused; the org name shows instead", () => {
    for (const orgLogoUrl of ["javascript:alert(1)", "data:image/svg+xml,<svg/onload=alert(1)>"]) {
      const html = renderHtml(report(), {
        branding: { whiteLabel: true, orgName: "Acme Inc", orgLogoUrl },
      });
      expect(html).not.toContain("javascript:alert(1)");
      expect(html).not.toContain("data:image");
      expect(html).not.toContain("<img");
      expect(html).toContain('class="wl-wordmark ');
    }
  });

  test("an http(s) white-label logo renders", () => {
    const html = renderHtml(report(), {
      branding: { whiteLabel: true, orgName: "Acme Inc", orgLogoUrl: "https://example.com/l.png" },
    });
    expect(html).toMatch(/<img [^>]*src="https:\/\/example\.com\/l\.png"/);
  });
});

describe("icon sprite", () => {
  test("every row icon is a symbol with a viewBox and drawable markup", () => {
    const html = renderHtml(report());
    for (const id of ["caret", "out", "copy", "check"]) {
      expect(html).toMatch(new RegExp(`<symbol id="i-${id}" viewBox="[^"]+"><path `));
    }
  });

  test("changed icon markup fails loudly instead of shipping a blank icon", () => {
    expect(() => spriteSymbol("x", "<svg><path d='M0 0'/></svg>")).toThrow(/no viewBox/);
    expect(() => spriteSymbol("x", '<svg viewBox="0 0 1 1"></svg>')).toThrow(/no drawable/);
    expect(() => spriteSymbol("x", '<span viewBox="0 0 1 1"><path/></span>')).toThrow();
    expect(spriteSymbol("x", '<svg viewBox="0 0 2 2"><path d="M0 0"></path></svg>')).toBe(
      '<symbol id="i-x" viewBox="0 0 2 2"><path d="M0 0"></path></symbol>',
    );
  });
});

// Stored reports of any origin and age reach this renderer, so odd data must
// render (not throw) and never print NaN or a broken command.
describe("odd report data", () => {
  test("an invalid timestamp and non-finite counts render without NaN", () => {
    const html = renderHtml(
      report({
        timestamp: "not a date",
        totalPages: Number.NaN,
        coverage: { auditedPages: 1, knownPages: Number.POSITIVE_INFINITY, carriedFindings: 0 },
        scanScope: { origin: "cli", maxPages: Number.NaN, pagesCrawled: 1, capped: true },
      }),
    );
    // The page script's own isNaN() is code, not copy: look at the markup only.
    const markup = html.replace(/<script>[\s\S]*?<\/script>/g, "");
    expect(markup).toContain("not a date");
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Infinity");
  });

  test("malformed strategic issues are skipped, not fatal", () => {
    const r = report() as AuditReport & { strategicIssues: unknown };
    r.strategicIssues = [
      null,
      {
        slug: "x",
        title: "No rule list",
        description: "d",
        actions: "a",
        severity: "high",
        effort: "moderate",
      },
      {
        slug: "y",
        title: "Bad severity",
        description: "d",
        actions: "a",
        severity: "urgent",
        effort: "moderate",
        ruleIds: [],
      },
      {
        slug: "z",
        title: "Use a CDN cache rule",
        description: "d",
        actions: "1. Do it",
        severity: "high",
        effort: "moderate",
        ruleIds: ["perf/x"],
      },
    ];
    const html = renderHtml(r);
    expect(html).toContain("Use a CDN cache rule");
    expect(html).not.toContain("No rule list");
    expect(html).not.toContain("Bad severity");
  });

  test("a smart audit's un-rechecked pages read as carried, not missing", () => {
    const html = renderHtml(
      report({
        totalPages: 10,
        coverage: { auditedPages: 10, knownPages: 40, carriedFindings: 0 },
        scanScope: { origin: "cli", maxPages: 10, pagesCrawled: 10, capped: true },
      }),
    );
    expect(html).toContain("were not re-checked this run and their findings are carried");
    expect(html).not.toContain("are not in this report");
  });

  test("cache stats show even without a site profile or tech stack", () => {
    const html = renderHtml(
      report({
        technologies: undefined,
        cacheStats: {
          total: 10,
          hits: 5,
          hitRate: 0.5,
          bytesSaved: 2048,
          hitsByReason: {},
          pages: { total: 5, hits: 2, bytesSaved: 1024 },
        } as unknown as AuditReport["cacheStats"],
      }),
    );
    expect(html).toContain("Cache: 50% hit rate");
  });
});
