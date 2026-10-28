// Page structure block (#2307): where the audited pages' links sit, and the page types the
// classifier gave them.
//
// Pinned here: the per-page extractor, the builder's numbers over a hand-counted fixture, the
// rule that a report with no section data carries no block at all (a crawl stored before the
// classifier existed), and the block's wording in every output format.

import { describe, expect, test } from "bun:test";

import type { PageStructureScalars } from "@squirrelscan/core-contracts";

import type { AuditReport } from "../src/types";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import {
  createStructureBuilder,
  extractPageStructure,
  pageTypePhrase,
  structurePageTypesLine,
  structureRowDetail,
} from "../src/structure";

type Source = "model" | "rules";

function scalars(over: {
  sections: PageStructureScalars["sections"];
  chrome: number;
  content: number;
  type?: { label: string; confidence: number; source: Source } | null;
  degraded?: boolean;
}): PageStructureScalars {
  return {
    sections: over.sections,
    chromeInternal: over.chrome,
    contentInternal: over.content,
    pageType: over.type ?? null,
    degraded: over.degraded ?? false,
  };
}

// Seven pages with data, hand-counted below, and one with none.
const FIXTURE: Array<PageStructureScalars | undefined> = [
  // homepage, by the model
  scalars({
    sections: { header: 2, navigation: 4, footer: 6, content: 3, unknown: 1 },
    chrome: 10,
    content: 3,
    type: { label: "homepage", confidence: 0.97, source: "model" },
  }),
  // product page, by the model, with part of the answer degraded
  scalars({
    sections: { header: 2, navigation: 4, footer: 6, sidebar: 2, content: 5, related_content: 2 },
    chrome: 12,
    content: 5,
    type: { label: "product_detail", confidence: 0.9, source: "model" },
    degraded: true,
  }),
  // product page, by the markup rules at 0.85: counts
  scalars({
    sections: { header: 2, footer: 6, content: 7, comments: 1, unknown: 2 },
    chrome: 7,
    content: 6,
    type: { label: "product_detail", confidence: 0.85, source: "rules" },
  }),
  // contact page, by the markup rules at 0.95: counts
  scalars({
    sections: { footer: 6, content: 1 },
    chrome: 6,
    content: 1,
    type: { label: "contact", confidence: 0.95, source: "rules" },
  }),
  // sections but no classification
  scalars({ sections: { footer: 6 }, chrome: 6, content: 0 }),
  // a weak rules answer: not a label the report stands behind
  scalars({
    sections: { content: 2 },
    chrome: 0,
    content: 2,
    type: { label: "article", confidence: 0.6, source: "rules" },
  }),
  // the model said "unknown": no answer
  scalars({
    sections: { header: 1 },
    chrome: 1,
    content: 0,
    type: { label: "unknown", confidence: 0.3, source: "model" },
  }),
  // a page with no section or classification data at all
  undefined,
];

function build(pages: Array<PageStructureScalars | undefined> = FIXTURE) {
  const builder = createStructureBuilder();
  for (const page of pages) builder.add(page);
  return builder.build();
}

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-16T00:00:00.000Z",
    totalPages: 8,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

const STRUCTURE = build()!;

describe("extractPageStructure", () => {
  test("counts links per section and keeps the internal chrome and content counts", () => {
    const out = extractPageStructure({
      links: [
        { isInternal: true, section: "header" },
        { isInternal: true, section: "navigation" },
        { isInternal: false, section: "footer" }, // external: counted, not in the internal counts
        { isInternal: true, section: "footer" },
        { isInternal: true, section: "content" },
        { isInternal: true, section: "content" },
        { isInternal: true, section: "unknown" },
        { isInternal: true, section: "pagination" }, // neither chrome nor content
        { isInternal: true }, // an old parse: no section, counted nowhere
      ],
      classification: {
        pageType: { label: "blog_post", confidence: 0.91, source: "model" },
        degraded: "model-unavailable",
      },
    });

    expect(out).toEqual({
      sections: { header: 1, navigation: 1, footer: 2, content: 2, unknown: 1, pagination: 1 },
      chromeInternal: 3,
      contentInternal: 2,
      pageType: { label: "blog_post", confidence: 0.91, source: "model" },
      degraded: true,
    });
  });

  test("a page with neither a section nor a classification contributes nothing", () => {
    expect(extractPageStructure({})).toBeUndefined();
    expect(extractPageStructure({ links: [] })).toBeUndefined();
    expect(extractPageStructure({ links: [{ isInternal: true }] })).toBeUndefined();
  });

  test("a classification alone is enough, and so is a section alone", () => {
    expect(
      extractPageStructure({
        classification: {
          pageType: { label: "about", confidence: 0.8, source: "rules" },
          degraded: "",
        },
      })
    ).toEqual({
      sections: {},
      chromeInternal: 0,
      contentInternal: 0,
      pageType: { label: "about", confidence: 0.8, source: "rules" },
      degraded: false,
    });
    expect(extractPageStructure({ links: [{ isInternal: true, section: "content" }] })?.pageType).toBeNull();
  });
});

describe("page structure builder", () => {
  test("sums sections, chrome share and page types over the audited pages", () => {
    expect(STRUCTURE).toEqual({
      pages: 7,
      sections: [
        { section: "footer", pages: 5, links: 30 },
        { section: "content", pages: 5, links: 18 },
        { section: "navigation", pages: 2, links: 8 },
        { section: "header", pages: 4, links: 7 },
        { section: "sidebar", pages: 1, links: 2 },
        { section: "related_content", pages: 1, links: 2 },
        { section: "comments", pages: 1, links: 1 },
      ],
      unknownLinks: 3,
      totalLinks: 71,
      // 42 internal links in the chrome, 17 in the content: 42 / 59.
      chrome: { links: 42, contentLinks: 17, share: 0.712 },
      pageTypes: {
        counts: [
          { label: "product_detail", pages: 2 },
          { label: "contact", pages: 1 },
          { label: "homepage", pages: 1 },
        ],
        // the page with sections only, the weak rules answer, the model's "unknown"
        notClassified: 3,
        byModel: 2,
        degraded: 1,
      },
    });
  });

  test("a rules answer counts from 0.8 and not below it; a model answer always counts", () => {
    const at = (confidence: number, source: Source) =>
      build([scalars({ sections: { content: 1 }, chrome: 0, content: 1, type: { label: "legal", confidence, source } })])!
        .pageTypes;

    expect(at(0.8, "rules").counts).toEqual([{ label: "legal", pages: 1 }]);
    expect(at(0.79, "rules")).toMatchObject({ counts: [], notClassified: 1 });
    expect(at(0.1, "model")).toMatchObject({ counts: [{ label: "legal", pages: 1 }], byModel: 1 });
  });

  test("builds nothing when no page carries any data", () => {
    expect(build([])).toBeUndefined();
    expect(build([undefined, undefined])).toBeUndefined();
  });

  test("the share is null when no internal link sits in the chrome or the content", () => {
    const structure = build([scalars({ sections: { pagination: 3 }, chrome: 0, content: 0 })])!;
    expect(structure.chrome).toEqual({ links: 0, contentLinks: 0, share: null });
  });

  test("ignores a section or label it does not know instead of printing it", () => {
    const structure = build([
      {
        // what a hand-edited report file could carry
        sections: { header: 2, "<script>alert(1)</script>": 5 } as PageStructureScalars["sections"],
        chromeInternal: 2,
        contentInternal: 0,
        pageType: { label: "<img src=x>", confidence: 1, source: "model" },
        degraded: false,
      },
    ])!;

    expect(structure.sections).toEqual([{ section: "header", pages: 1, links: 2 }]);
    expect(structure.totalLinks).toBe(2);
    expect(structure.pageTypes.counts).toEqual([]);
    expect(structure.pageTypes.notClassified).toBe(1);
  });
});

describe("page structure wording", () => {
  test("one line of page types, most pages first", () => {
    expect(structurePageTypesLine(STRUCTURE)).toBe(
      "Page types: 2 product pages, 1 contact page, 1 homepage; 3 not classified."
    );
  });

  test("no page types line when the classifier labelled nothing", () => {
    const sectionsOnly = build([scalars({ sections: { footer: 4 }, chrome: 4, content: 0 })])!;
    expect(structurePageTypesLine(sectionsOnly)).toBeNull();
  });

  test("a table row reads as a phrase with the right plurals", () => {
    expect(structureRowDetail({ pages: 88, links: 3784 })).toBe("3,784 links on 88 pages");
    expect(structureRowDetail({ pages: 1, links: 1 })).toBe("1 link on 1 page");
  });

  test("labels this version has no wording for read as their own words", () => {
    expect(pageTypePhrase("case_study", 3)).toBe("3 case study pages");
    expect(pageTypePhrase("blog_post", 1)).toBe("1 blog post");
    expect(pageTypePhrase("Not Plain!", 1)).toBeUndefined();
  });
});

describe("page structure in the output formats", () => {
  const withStructure = report({ structure: STRUCTURE });

  test("markdown: a section with the page types, the table and the chrome share", () => {
    const md = renderMarkdown(withStructure);

    expect(md).toContain("### Page structure");
    expect(md).toContain("Page types: 2 product pages, 1 contact page, 1 homepage; 3 not classified.");
    expect(md).toContain("| Section | Pages | Links |");
    expect(md).toContain("| Footer | 5 | 30 |");
    expect(md).toContain("| Content | 5 | 18 |");
    expect(md).toContain("| Comments | 1 | 1 |");
    expect(md).toContain("71 links counted; 3 could not be placed in a section.");
    expect(md).toContain(
      "71% of internal links sit in the header, footer, navigation and sidebar; 29% in the page content."
    );
    expect(md).toContain("1 page fell back to the markup rules for part of the classification.");
    // Rows come out most links first.
    expect(md.indexOf("| Footer |")).toBeLessThan(md.indexOf("| Content |"));
    expect(md.indexOf("| Content |")).toBeLessThan(md.indexOf("| Navigation |"));
  });

  test("markdown: inside Report detail, the last section, after every issue", () => {
    const md = renderMarkdown(
      report({
        structure: STRUCTURE,
        technologies: {
          items: [{ id: "nextjs", name: "Next.js", category: "framework", version: null, confidence: "high" }],
          added: [],
          removed: [],
          firstScan: true,
        },
      }),
    );

    expect(md.indexOf("## Summary")).toBeLessThan(md.indexOf("## Report detail"));
    expect(md.indexOf("## Technologies")).toBeLessThan(md.indexOf("## Report detail"));
    expect(md.indexOf("## Report detail")).toBeLessThan(md.indexOf("### Page structure"));
    // Nothing of it above the score.
    expect(md.slice(0, md.indexOf("## Summary"))).not.toContain("Page structure");
  });

  test("no em-dash anywhere in the block, in any text format", () => {
    const block = (text: string, start: string, end: string) =>
      text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
    const md = renderMarkdown(withStructure);
    const txt = renderText(withStructure);
    const llm = renderLlm(withStructure);

    expect(block(md, "### Page structure", "\n---\n")).not.toContain("—");
    expect(block(txt, "Page structure", "==========")).not.toContain("—");
    expect(block(llm, "<page-structure", "</page-structure>")).not.toContain("—");
    expect(block(md, "### Page structure", "\n---\n").length).toBeGreaterThan(200);
  });

  test("text: the same three pieces", () => {
    const text = renderText(withStructure);

    expect(text).toContain("REPORT DETAIL");
    expect(text).toContain("Page structure\n");
    expect(text).toContain("Page types: 2 product pages, 1 contact page, 1 homepage; 3 not classified.");
    expect(text).toMatch(/Footer\s+5\s+30/);
    expect(text).toContain(
      "71% of internal links sit in the header, footer, navigation and sidebar; 29% in the page content."
    );
  });

  test("llm: attributes first, then the sentences and one row per section", () => {
    const llm = renderLlm(withStructure);

    expect(llm).toContain('<page-structure pages="7" links="71" chrome-share="0.712">');
    expect(llm).toContain("Page types: 2 product pages, 1 contact page, 1 homepage; 3 not classified.");
    // The section id the JSON report uses, one row per section.
    expect(llm).toContain('<section name="footer" pages="5" links="30"/>');
    expect(llm).toContain('<section name="related_content" pages="1" links="2"/>');
    expect(llm).toContain("</page-structure>");
  });

  test("xml: the block as attributes, with the ids the JSON report uses", () => {
    const xml = renderXml(withStructure);

    expect(xml).toContain(
      '<page-structure pages="7" links="71" unknown-links="3" chrome-links="42" content-links="17" chrome-share="0.712">'
    );
    expect(xml).toContain('<section name="footer" pages="5" links="30"/>');
    expect(xml).toContain('<page-types not-classified="3" by-model="2" degraded="1">');
    expect(xml).toContain('<page-type label="product_detail" pages="2"/>');
    expect(xml).not.toContain("—");
  });

  test("llm and xml: a count that is not a number cannot carry markup into an attribute", () => {
    const hostile = {
      ...STRUCTURE,
      pages: '1"><x/>' as unknown as number,
      sections: [{ section: "footer", pages: "<y>" as unknown as number, links: 3 }],
    } as typeof STRUCTURE;

    for (const out of [renderLlm(report({ structure: hostile })), renderXml(report({ structure: hostile }))]) {
      expect(out).not.toContain("<x/>");
      expect(out).not.toContain("<y>");
      expect(out).toContain('pages="0"');
    }
  });

  test("a malformed or table-colliding page type label never throws and never prints", () => {
    const odd = {
      ...STRUCTURE,
      pageTypes: {
        ...STRUCTURE.pageTypes,
        counts: [
          { label: null as unknown as string, pages: 1 },
          { label: true as unknown as string, pages: 1 },
          { label: "constructor", pages: 2 },
          { label: "contact", pages: 1 },
        ],
      },
    };
    const r = report({ structure: odd });

    // The HTML page's own script says `undefined` (a date format locale); only its markup is read.
    // indexOf scans, not a regex: removes each <script>...</script> and <style>...</style> block.
    const markup = (html: string) => {
      let out = html;
      for (const tag of ["script", "style"]) {
        for (let at = out.indexOf(`<${tag}`); at !== -1; at = out.indexOf(`<${tag}`)) {
          const close = out.indexOf(`</${tag}>`, at);
          if (close === -1) break;
          out = out.slice(0, at) + out.slice(close + tag.length + 3);
        }
      }
      return out;
    };
    for (const out of [renderMarkdown(r), renderText(r), renderLlm(r), renderXml(r), markup(renderHtml(r))]) {
      expect(out).not.toContain("undefined");
      expect(out).not.toContain("null page");
    }
    expect(renderMarkdown(r)).toContain("Page types: 2 constructor pages, 1 contact page; 3 not classified.");
  });

  test("links that are all unknown still get their totals line, with no table", () => {
    const unknownOnly = build([scalars({ sections: { unknown: 4 }, chrome: 0, content: 0 })])!;
    const r = report({ structure: unknownOnly });

    for (const out of [renderMarkdown(r), renderText(r)]) {
      expect(out).toContain("4 links counted; 4 could not be placed in a section.");
    }
    expect(renderMarkdown(r)).not.toContain("| Section |");
  });

  test("json: the block as data, under structure", () => {
    const parsed = JSON.parse(renderJson(withStructure)) as { structure?: unknown };
    expect(parsed.structure).toEqual(STRUCTURE);
  });

  test("html: a section with the sentences and one badge per section", () => {
    const html = renderHtml(withStructure);

    expect(html).toContain('<section id="structure">');
    expect(html).toContain("Page structure");
    expect(html).toContain("Page types: 2 product pages, 1 contact page, 1 homepage; 3 not classified.");
    expect(html).toContain("30 links on 5 pages");
    expect(html).toContain("2 links on 1 page<");
  });

  test("a report with no structure renders none of it, in any format", () => {
    const plain = report();

    expect(renderMarkdown(plain)).not.toContain("Page structure");
    expect(renderText(plain)).not.toContain("Page structure");
    expect(renderLlm(plain)).not.toContain("page-structure");
    expect(renderXml(plain)).not.toContain("page-structure");
    expect(renderHtml(plain)).not.toContain("Page structure");
    expect("structure" in (JSON.parse(renderJson(plain)) as object)).toBe(false);
  });

  test("empty rows are hidden: no page types, no table and no chrome line when there is nothing to say", () => {
    const sparse = build([scalars({ sections: { pagination: 2 }, chrome: 0, content: 0 })])!;
    const md = renderMarkdown(report({ structure: sparse }));

    expect(md).toContain("### Page structure");
    expect(md).toContain("| Pagination | 1 | 2 |");
    expect(md).not.toContain("Page types:");
    expect(md).not.toContain("of internal links sit");
    expect(md).not.toContain("fell back");
  });
});
