// The editor's summary can carry ranked priorities (repo#3063). Every format
// shows them as their own "Priorities" section in place of the big-ticket list,
// the request digest carries the detected stack and every failing rule, and a
// summary without priorities (older servers, stored reports) renders as before.

import { describe, expect, test } from "bun:test";

import type { AuditReport, EditorSummary } from "../src/types";
import { buildEditorSummaryRequest, editorSummaryView, toEditorSummary } from "../src/editor-summary";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";

function report(extra: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://acme.example",
    timestamp: "2026-10-23T00:00:00.000Z",
    totalPages: 3,
    passed: 1,
    warnings: 1,
    failed: 1,
    ruleResults: {},
    generatorVersion: "1.2.3",
    ...extra,
  } as AuditReport;
}

const WITH_PRIORITIES: EditorSummary = {
  prose: "The site is solid.\n\nTwo things matter.",
  bigTicket: ["Cache pages: slow first byte"],
  verdict: "Good, with two fixes.",
  model: "openai/gpt-6-luna",
  generatedAt: "2026-10-23T00:00:00.000Z",
  priorities: [
    {
      title: "Cache pages with WP Rocket",
      why: "Every page waits on the origin.",
      action: "Install WP Rocket and turn on page caching.",
      effort: "quick-win",
      ruleIds: ["perf/ttfb"],
      technologies: ["wordpress"],
    },
    {
      title: "Put Cloudflare in front",
      why: "The origin is exposed.",
      action: "Proxy the site through Cloudflare.",
      effort: "moderate",
      ruleIds: [],
      technologies: [],
    },
  ],
};

describe("buildEditorSummaryRequest", () => {
  test("sends the detected stack and every failing rule", () => {
    const req = buildEditorSummaryRequest(
      report({
        technologies: {
          items: [
            { id: "wordpress", name: "WordPress", category: "cms", version: "6.7", confidence: "high", detectedBy: "html:wp-content" },
          ],
          added: [],
          removed: [],
          firstScan: true,
        },
        ruleResults: {
          "perf/ttfb": { meta: { name: "TTFB", category: "perf", weight: 5 }, checks: [{ status: "fail" }] },
          "core/h1": { meta: { name: "H1", category: "core", weight: 3 }, checks: [{ status: "warn" }] },
          "core/title": { meta: { name: "Title", category: "core", weight: 3 }, checks: [{ status: "pass" }] },
        } as unknown as AuditReport["ruleResults"],
      }),
    );
    expect(req.technologies).toEqual([
      { id: "wordpress", name: "WordPress", category: "cms", version: "6.7", detectedBy: "html:wp-content" },
    ]);
    expect(req.failingRuleIds?.sort()).toEqual(["core/h1", "perf/ttfb"]);
  });

  test("omits both when there is nothing to send", () => {
    const req = buildEditorSummaryRequest(report());
    expect(req.technologies).toBeUndefined();
    expect(req.failingRuleIds).toBeUndefined();
  });
});

describe("toEditorSummary priorities", () => {
  test("keeps well-formed priorities", () => {
    expect(toEditorSummary(WITH_PRIORITIES)?.priorities).toEqual(WITH_PRIORITIES.priorities);
  });

  test("drops malformed entries, defaults effort, clamps and caps", () => {
    const out = toEditorSummary({
      ...WITH_PRIORITIES,
      priorities: [
        { title: "No action" },
        "not an object",
        { title: "  Spaced\n title ", action: "Do it", effort: "huge", ruleIds: [1, "a/b"], technologies: "x" },
        ...Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, action: "A" })),
      ],
    });
    const priorities = out!.priorities!;
    expect(priorities[0]).toEqual({
      title: "Spaced title",
      why: "",
      action: "Do it",
      effort: "moderate",
      ruleIds: ["a/b"],
      technologies: [],
    });
    expect(priorities).toHaveLength(8);
  });

  test("a summary without priorities has none, and the view says so", () => {
    const plain = { ...WITH_PRIORITIES, priorities: undefined };
    expect(toEditorSummary(plain)).not.toHaveProperty("priorities");
    expect(editorSummaryView(plain)?.priorities).toEqual([]);
  });
});

describe("renderers with priorities", () => {
  const r = report({ editorSummary: WITH_PRIORITIES });

  test("markdown shows a Priorities section and drops the big-ticket list", () => {
    const out = renderMarkdown(r);
    expect(out).toContain("## Priorities");
    expect(out).toContain("1. **Cache pages with WP Rocket** (Quick win)");
    expect(out).not.toContain("Big-ticket items");
  });

  test("markdown escapes model text and keeps each priority one list item", () => {
    const out = renderMarkdown(
      report({
        editorSummary: {
          ...WITH_PRIORITIES,
          priorities: [
            {
              title: "Fix [the](javascript:x) *titles*",
              why: "Line one\n\nline two",
              action: "Edit <b>theme</b>",
              effort: "moderate",
              ruleIds: [],
              technologies: [],
            },
          ],
        },
      }),
    );
    expect(out).toContain("1. **Fix \\[the\\]\\(javascript:x\\) \\*titles\\*** (Moderate)");
    expect(out).toContain("   Line one line two  \n   Edit \\<b\\>theme\\</b\\>");
  });

  test("text shows a PRIORITIES section", () => {
    const out = renderText(r);
    expect(out).toContain("PRIORITIES");
    expect(out).toContain("1. Cache pages with WP Rocket [Quick win]");
    expect(out).not.toContain("Big-ticket items");
  });

  test("llm and xml emit ranked priority elements", () => {
    const llm = renderLlm(r);
    expect(llm).toContain('<priority rank="1" effort="quick-win" rules="perf/ttfb" tech="wordpress">');
    expect(llm).not.toContain("<big-ticket>");
    const xml = renderXml(r);
    expect(xml).toContain('<priority rank="2" effort="moderate">');
    expect(xml).not.toContain("<big-ticket>");
  });

  test("html renders a priorities section", () => {
    const out = renderHtml(r);
    expect(out).toContain('class="priorities-section"');
    expect(out).toContain("Cache pages with WP Rocket");
    expect(out).not.toContain('class="editor-summary-bigticket"');
  });

  test("json carries the priorities in the summary", () => {
    const parsed = JSON.parse(renderJson(r)) as { editorSummary: EditorSummary };
    expect(parsed.editorSummary.priorities).toEqual(WITH_PRIORITIES.priorities);
  });
});

describe("renderers without priorities keep the big-ticket list", () => {
  const r = report({ editorSummary: { ...WITH_PRIORITIES, priorities: undefined } });

  test("every format falls back", () => {
    expect(renderMarkdown(r)).toContain("Big-ticket items");
    expect(renderMarkdown(r)).not.toContain("## Priorities");
    expect(renderText(r)).not.toContain("PRIORITIES");
    expect(renderLlm(r)).toContain("<big-ticket>");
    expect(renderXml(r)).toContain("<big-ticket>");
    expect(renderHtml(r)).toContain('class="editor-summary-bigticket"');
    expect(renderHtml(r)).not.toContain('class="priorities-section"');
  });
});
