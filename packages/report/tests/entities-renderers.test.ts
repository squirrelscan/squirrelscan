// #2091: the entity map is part of EVERY report format, so a reader of the
// console, the markdown export, the llm export, the HTML page, the JSON or the
// XML sees the same graph. One test per format asserting the section is present
// and carries the findings, plus the escaping the untrusted names demand.

import { describe, expect, test } from "bun:test";

import type { AuditReport, EntityMap, EntityMapNode } from "../src/types";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";

function node(overrides: Partial<EntityMapNode> = {}): EntityMapNode {
  return {
    key: "id:https://example.com/#org",
    id: "https://example.com/#org",
    types: ["Organization"],
    name: "Acme Widgets",
    properties: { name: "Acme Widgets" },
    occurrences: 12,
    pages: ["https://example.com/a", "https://example.com/b"],
    morePages: 0,
    conflicts: [],
    danglingRefs: 0,
    pageLocal: false,
    ...overrides,
  };
}

const MAP: EntityMap = {
  format: "squirrelscan/entity-map",
  version: 1,
  site: "https://example.com/",
  generatedAt: "2026-01-01T00:00:00.000Z",
  summary: {
    nodeCount: 3,
    edgeCount: 2,
    danglingCount: 1,
    pagesTotal: 10,
    pagesWithoutEntities: 2,
    nodesWithStableId: 1,
    stableIdShare: 1 / 3,
    pageLocalCount: 1,
    nodesWithoutIdCount: 1,
    conflictCount: 1,
    countsByType: { Organization: 12, Person: 4, WebPage: 10 },
  },
  nodes: [
    node(),
    node({
      key: "syn:Person|name:ada lovelace",
      id: null,
      types: ["Person"],
      name: "Ada Lovelace",
      occurrences: 4,
      conflicts: [
        {
          property: "url",
          values: [
            { value: "https://example.com/ada", pages: ["https://example.com/a"], morePages: 0 },
            { value: "https://example.com/lovelace", pages: ["https://example.com/b"], morePages: 0 },
          ],
        },
      ],
      danglingRefs: 1,
    }),
    node({
      key: "syn:WebPage|name:home",
      id: null,
      types: ["WebPage"],
      name: "Home",
      occurrences: 10,
      pages: ["https://example.com/"],
      pageLocal: true,
    }),
  ],
  edges: [
    {
      source: "id:https://example.com/#org",
      predicate: "author",
      target: "syn:Person|name:ada lovelace",
      dangling: false,
      occurrences: 4,
      pages: ["https://example.com/a"],
      morePages: 0,
    },
    {
      source: "syn:Person|name:ada lovelace",
      predicate: "worksFor",
      target: "id:https://example.com/#missing",
      dangling: true,
      occurrences: 3,
      pages: ["https://example.com/a"],
      morePages: 0,
    },
  ],
  pages: [],
};

const EMPTY_MAP: EntityMap = {
  ...MAP,
  summary: {
    nodeCount: 0,
    edgeCount: 0,
    danglingCount: 0,
    pagesTotal: 4,
    pagesWithoutEntities: 4,
    nodesWithStableId: 0,
    stableIdShare: 0,
    pageLocalCount: 0,
    nodesWithoutIdCount: 0,
    conflictCount: 0,
    countsByType: {},
  },
  nodes: [],
  edges: [],
};

// No default value: `report(undefined)` would otherwise fall back to it,
// which is the JS default-parameter rule and silently defeats the
// no-map tests.
function report(map?: EntityMap): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-01-01T00:00:00.000Z",
    totalPages: 10,
    passed: 5,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...(map ? { entityMap: map } : {}),
  } as AuditReport;
}

/** A report with one real finding, so the issues section actually renders. */
function reportWithIssues(): AuditReport {
  return {
    ...report(MAP),
    failed: 1,
    ruleResults: {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta Title",
          category: "core",
          categoryName: "Core",
          group: "seo",
          severity: "error",
          description: "d",
          solution: "s",
        },
        checks: [
          {
            name: "title",
            status: "fail",
            message: "Missing title",
            pageUrl: "https://example.com/x",
          },
        ],
      },
    },
  } as AuditReport;
}

describe("section placement", () => {
  // The entity map is informational and unscored, so it belongs BELOW the
  // findings in every format — not between the score cards and the first issue,
  // where it pushed the things a reader opened the report for off the screen.
  test.each([
    ["text", (r: AuditReport) => renderText(r), "ENTITIES", "ISSUES"],
    ["markdown", (r: AuditReport) => renderMarkdown(r), "## Entities", "## Issues"],
    ["llm", (r: AuditReport) => renderLlm(r), "<entities", "<issues"],
    ["xml", (r: AuditReport) => renderXml(r), "<entities", "<issues"],
    ["html", (r: AuditReport) => renderHtml(r), 'id="em-data"', "issue"],
  ])("%s puts the entities section after the findings", (_name, render, entities, issues) => {
    const out = render(reportWithIssues());
    const entitiesAt = out.indexOf(entities);
    const issuesAt = out.indexOf(issues);
    expect(entitiesAt).toBeGreaterThan(-1);
    expect(issuesAt).toBeGreaterThan(-1);
    expect(entitiesAt).toBeGreaterThan(issuesAt);
  });

  test("xml keeps the entities element inside the root", () => {
    const out = renderXml(reportWithIssues());
    expect(out.indexOf("<entities")).toBeLessThan(out.indexOf("</squirrelscan-audit>"));
  });

  test("llm keeps the entities block inside the audit element", () => {
    const out = renderLlm(reportWithIssues());
    expect(out.indexOf("<entities")).toBeLessThan(out.indexOf("</audit>"));
  });
});

describe("text report", () => {
  test("carries an Entities block with the summary and the top entities", () => {
    const out = renderText(report(MAP));
    expect(out).toContain("ENTITIES");
    expect(out).toContain("3 entities");
    expect(out).toContain("33% with a stable @id");
    expect(out).toContain("1 conflicting");
    expect(out).toContain("1 dangling");
    expect(out).toContain("Acme Widgets");
    // Page-local entities are furniture, so the block leads with real subjects.
    expect(out).not.toContain("(unnamed");
    expect(out).toContain("carry no @id");
  });

  test("says so in one line when the site declares nothing", () => {
    const out = renderText(report(EMPTY_MAP));
    expect(out).toContain("ENTITIES");
    expect(out).toContain("declares no JSON-LD entities");
  });

  test("omits the block entirely when there is no map", () => {
    expect(renderText(report(undefined))).not.toContain("ENTITIES");
  });
});

describe("markdown report", () => {
  test("carries the summary table, entities, conflicts, dangling and no-id", () => {
    const out = renderMarkdown(report(MAP));
    expect(out).toContain("## Entities");
    expect(out).toContain("| Entities | 3 |");
    expect(out).toContain("### Largest entities");
    expect(out).toContain("Acme Widgets");
    expect(out).toContain("### Conflicting properties (1)");
    expect(out).toContain("`url` has 2 values");
    expect(out).toContain("### Dangling references (1)");
    expect(out).toContain("https://example.com/#missing");
    expect(out).toContain("### Entities without an @id (1)");
    expect(out).toContain("Ada Lovelace");
  });

  test("a clipped map reports the summary's findings, not the rows it kept", () => {
    // The publish projection drops low-occurrence nodes, so a hosted map can
    // carry a summary with conflicts and none of the entities that have them.
    // Saying "no entity disagrees with itself" there would be a lie.
    const clipped: EntityMap = { ...MAP, nodes: [node()], edges: [] };
    const out = renderMarkdown(report(clipped));

    expect(out).toContain("### Conflicting properties (1)");
    expect(out).toContain("1 entity affected, not included in this copy of the map.");
    expect(out).toContain("### Dangling references (1)");
    expect(out).toContain("1 reference affected, not included in this copy of the map.");
    expect(out).not.toContain("No entity disagrees with itself across pages.");
  });
});

describe("llm report", () => {
  test("carries an <entities> block with the findings as elements", () => {
    const out = renderLlm(report(MAP));
    expect(out).toContain('<entities count="3"');
    expect(out).toContain('dangling="1"');
    expect(out).toContain('conflicts="1"');
    expect(out).toContain('without-id="1"');
    expect(out).toContain('<entity type="Organization" name="Acme Widgets"');
    expect(out).toContain('<conflict entity="Ada Lovelace" property="url"');
    expect(out).toContain('<dangling predicate="worksFor"');
    expect(out).toContain('<without-id type="Person" name="Ada Lovelace"');
    expect(out).toContain("</entities>");
  });
});

describe("json report", () => {
  test("carries the map document verbatim under `entities`", () => {
    const parsed = JSON.parse(renderJson(report(MAP))) as { entities?: EntityMap };
    expect(parsed.entities).toBeDefined();
    expect(parsed.entities!.format).toBe("squirrelscan/entity-map");
    expect(parsed.entities!.version).toBe(1);
    expect(parsed.entities!.nodes).toHaveLength(3);
    expect(parsed.entities!.edges).toHaveLength(2);
    expect(parsed.entities!.summary.conflictCount).toBe(1);
  });

  test("omits the key when there is no map", () => {
    const parsed = JSON.parse(renderJson(report(undefined))) as { entities?: EntityMap };
    expect(parsed.entities).toBeUndefined();
  });
});

describe("xml report", () => {
  test("carries an <entities> element with every node and reference", () => {
    const out = renderXml(report(MAP));
    expect(out).toContain('<entities format="squirrelscan/entity-map" version="1"');
    expect(out).toContain('count="3"');
    expect(out).toContain('<entity key="id:https://example.com/#org"');
    expect(out).toContain('name="Acme Widgets"');
    expect(out).toContain('page-local="true"');
    expect(out).toContain('<conflict property="url">');
    expect(out).toContain('<reference source="id:https://example.com/#org"');
    expect(out).toContain('dangling="true"');
    expect(out).toContain("</entities>");
  });
});

describe("html report", () => {
  test("embeds the interactive viewer with the map inlined and no network loads", () => {
    const out = renderHtml(report(MAP));
    expect(out).toContain(">Entities<");
    expect(out).toContain('id="em-data"');
    expect(out).toContain('id="em-graph"');
    expect(out).toContain('id="em-fit"');
    expect(out).toContain('id="em-show-page-local"');
    expect(out).toContain('id="em-legend"');
    expect(out).toContain('id="em-panel"');
    expect(out).toContain('id="em-tbody"');
    // Inline only: no CDN, no external stylesheet, no runtime loads.
    expect(out).not.toContain("https://cdn");
    expect(out).not.toMatch(/<link[^>]+stylesheet/);
    expect(out).not.toMatch(/<script[^>]+src=/);
  });

  test("page-local entities are hidden by default", () => {
    const out = renderHtml(report(MAP));
    // The toggle SHOWS them, and ships unchecked, so the opening view is the
    // site's subject matter rather than one WebPage per page crawled.
    const checkbox = out.match(/<input[^>]*id="em-show-page-local"[^>]*>/)?.[0];
    expect(checkbox).toBeDefined();
    expect(checkbox).not.toContain("checked");
    expect(out).toContain("Show page-local entities");
  });

  test("the embedded table is capped with a show-all toggle", () => {
    const out = renderHtml(report(MAP));
    // A report is a document, not a database browser: `squirrel entities` is
    // the full table (#2092).
    expect(out).toContain('id="em-show-all"');
    expect(out).toContain("TABLE_LIMIT = 25");
    expect(out).toContain("tableExpanded ? rows : rows.slice(0, TABLE_LIMIT)");
  });

  test("the table filters with the graph, not independently", () => {
    const out = renderHtml(report(MAP));
    // One page-local control for the whole section. A table that kept listing
    // every unnamed image while the graph hid them would read as a bug.
    expect(out).toContain("if (!showPageLocal && node.pageLocal) return false;");
  });

  test("the label budget is anchored to the fit scale, not to scale 1", () => {
    // A budget measured against absolute scale is wrong on both ends: fit is
    // well above 1 for a small graph and below it for a large one, so the
    // opening view would show far more or far fewer than the intended count.
    const out = renderHtml(report(MAP));
    expect(out).toContain("LABEL_BUDGET_AT_FIT");
    expect(out).toContain("var zoom = view.scale / fitScale;");
  });

  test("a script tag in an entity name cannot escape the data block", () => {
    const hostile = {
      ...MAP,
      nodes: [node({ name: "</script><script>window.pwned=1</script>" })],
    };
    const out = renderHtml(report(hostile));

    expect(out).toContain("\\u003c/script\\u003e");
    expect(out).not.toContain("window.pwned=1</script>");

    // The inlined JSON still parses back to the original name.
    const start = out.indexOf('id="em-data">') + 'id="em-data">'.length;
    const end = out.indexOf("</script>", start);
    const parsed = JSON.parse(out.slice(start, end)) as { nodes: { name: string }[] };
    expect(parsed.nodes[0]?.name).toBe("</script><script>window.pwned=1</script>");
  });

  test("omits the section when there is no map", () => {
    expect(renderHtml(report(undefined))).not.toContain('id="em-data"');
  });
});
