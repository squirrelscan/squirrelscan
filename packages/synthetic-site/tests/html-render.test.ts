import { describe, expect, test } from "bun:test";

import { buildRobotsTxt, buildSitemapXml, renderPageHtml } from "../src/html-render";
import { generateSiteModel } from "../src/page-model";

describe("renderPageHtml", () => {
  test("includes title, description, h1, and canonical for the given origin", () => {
    const model = generateSiteModel({ seed: "render-basics", pageCount: 10 });
    const page = model.pages[3]!;
    const html = renderPageHtml(page, "http://example.test");

    expect(html).toContain(`<title>${page.title}</title>`);
    expect(html).toContain(`content="${page.description}"`);
    expect(html).toContain(`<h1>${page.h1}</h1>`);
    expect(html).toContain(`<link rel="canonical" href="http://example.test${page.path}">`);
  });

  test("emits a noindex meta tag only when the page model says noindex", () => {
    const model = generateSiteModel({
      seed: "render-noindex",
      pageCount: 200,
      issues: { noindexInSitemap: { count: 5 } },
    });
    const noindexPage = model.pages.find((p) => p.noindex)!;
    const cleanPage = model.pages.find((p) => !p.noindex && p.templateId !== "redirect-hop")!;

    expect(renderPageHtml(noindexPage, "http://example.test")).toContain(
      '<meta name="robots" content="noindex">',
    );
    expect(renderPageHtml(cleanPage, "http://example.test")).not.toContain('name="robots"');
  });

  test("escapes HTML-significant characters in title/description", () => {
    const model = generateSiteModel({ seed: "render-escape", pageCount: 5 });
    const page = { ...model.pages[0]!, title: `<script>alert("x")</script>` };
    const html = renderPageHtml(page, "http://example.test");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders body content approaching the page's targetSizeBytes", () => {
    const model = generateSiteModel({
      seed: "render-size",
      pageCount: 5,
      minPageSizeBytes: 40_000,
      maxPageSizeBytes: 40_000,
    });
    const page = model.pages[1]!;
    const html = renderPageHtml(page, "http://example.test");
    // Within a reasonable band of the target — not exact (paragraph granularity).
    expect(html.length).toBeGreaterThan(page.targetSizeBytes * 0.8);
  });

  test("different templates render structurally distinct markup", () => {
    const model = generateSiteModel({ seed: "render-templates", pageCount: 50, templateCount: 4 });
    const byTemplate = new Map<string, string>();
    for (const page of model.pages) {
      if (!byTemplate.has(page.templateId)) {
        byTemplate.set(page.templateId, renderPageHtml(page, "http://example.test"));
      }
    }
    const bodies = [...byTemplate.entries()];
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        expect(bodies[i]![1]).not.toBe(bodies[j]![1]);
        // Each template stamps its own body class.
        expect(bodies[i]![1]).toContain(`tpl-${bodies[i]![0]}`);
      }
    }
  });
});

describe("buildRobotsTxt / buildSitemapXml", () => {
  test("robots.txt points at the sitemap for the given origin", () => {
    const body = buildRobotsTxt("http://example.test");
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Sitemap: http://example.test/sitemap.xml");
  });

  test("sitemap.xml lists every provided path as an absolute <loc>", () => {
    const xml = buildSitemapXml(["/", "/a", "/b/c"], "http://example.test");
    expect(xml).toContain("<loc>http://example.test/</loc>");
    expect(xml).toContain("<loc>http://example.test/a</loc>");
    expect(xml).toContain("<loc>http://example.test/b/c</loc>");
    expect((xml.match(/<url>/g) ?? []).length).toBe(3);
  });
});
