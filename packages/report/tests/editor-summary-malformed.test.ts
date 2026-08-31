// A stored editor's summary whose `prose` is not a usable string must render as
// "no editor-summary section" in EVERY output format, never as a throw.
//
// The cloud client casts its JSON to the response type without validating it, so
// a 2xx body missing `prose` reaches the report typed as `string` while being
// `undefined` at runtime. Reports are also persisted and re-rendered later, so a
// report written before the fetch-side guard existed can still carry one. The
// old renderers called `es.prose.split(...)` unguarded and died with
// "undefined is not an object", discarding an audit that had already finished.

import { describe, expect, test } from "bun:test";

import type { AuditReport, EditorSummary } from "../src/types";
import { editorSummaryView, toEditorSummary } from "../src/editor-summary";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";

function baseReport(editorSummary: unknown): AuditReport {
  return {
    baseUrl: "https://acme.example",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    generatorVersion: "1.2.3",
    editorSummary: editorSummary as EditorSummary,
  } as AuditReport;
}

const GOOD: EditorSummary = {
  prose: "First paragraph.\n\nSecond paragraph.",
  bigTicket: ["Fix the titles"],
  verdict: "Ship it",
  model: "test-model",
  generatedAt: "2026-06-16T14:30:00.000Z",
};

/** Every malformed body a 2xx can plausibly hand us (issue repro: `{"ok":true}`). */
const MALFORMED: Array<[string, unknown]> = [
  ["missing prose", { bigTicket: [], verdict: "v", model: "m", generatedAt: "t" }],
  ["the whole body replaced by an envelope", { ok: true }],
  ["prose is not a string", { prose: 42, bigTicket: [], verdict: "", model: "", generatedAt: "" }],
  ["prose is blank", { prose: "   \n\n  ", bigTicket: [], verdict: "", model: "", generatedAt: "" }],
  ["prose is null", { prose: null, bigTicket: [], verdict: "", model: "", generatedAt: "" }],
];

describe("toEditorSummary", () => {
  test("accepts a well-formed body unchanged", () => {
    expect(toEditorSummary(GOOD)).toEqual(GOOD);
  });

  test.each(MALFORMED)("rejects a 2xx body with %s", (_label, body) => {
    expect(toEditorSummary(body)).toBeNull();
  });

  test("rejects non-objects", () => {
    expect(toEditorSummary(undefined)).toBeNull();
    expect(toEditorSummary(null)).toBeNull();
    expect(toEditorSummary("prose")).toBeNull();
  });

  test("defaults the decorative fields rather than rejecting the body", () => {
    // Only `prose` is the section; a missing verdict/model must still render.
    expect(toEditorSummary({ prose: "Body." })).toEqual({
      prose: "Body.",
      bigTicket: [],
      verdict: "",
      model: "",
      generatedAt: "",
    });
  });

  test("drops non-string big-ticket entries instead of rendering them", () => {
    const summary = toEditorSummary({ prose: "Body.", bigTicket: ["keep", 7, null, "also"] });
    expect(summary?.bigTicket).toEqual(["keep", "also"]);
  });
});

describe("editorSummaryView", () => {
  test("splits prose on blank lines and trims", () => {
    expect(editorSummaryView(GOOD)?.paragraphs).toEqual(["First paragraph.", "Second paragraph."]);
  });

  test("returns null for an absent or malformed summary", () => {
    expect(editorSummaryView(undefined)).toBeNull();
    expect(editorSummaryView({ prose: undefined } as unknown as EditorSummary)).toBeNull();
  });
});

describe.each(MALFORMED)("renderers with %s", (_label, body) => {
  const report = baseReport(body);

  test("markdown renders without the section and without throwing", () => {
    const out = renderMarkdown(report);
    expect(out).not.toContain("Editor's Summary");
  });

  test("text renders without the section and without throwing", () => {
    const out = renderText(report);
    expect(out).not.toContain("EDITOR'S SUMMARY");
  });

  test("llm renders without the section and without throwing", () => {
    const out = renderLlm(report);
    expect(out).not.toContain("<editor-summary");
  });

  test("xml renders without the section and without throwing", () => {
    const out = renderXml(report);
    expect(out).not.toContain("<editor-summary");
  });

  test("html renders without the section and without throwing", () => {
    // Match the attribute, not the class name: the stylesheet always ships the rule.
    const out = renderHtml(report);
    expect(out).not.toContain('class="editor-summary-section"');
  });

  test("json omits the section rather than emitting a half-built one", () => {
    const parsed = JSON.parse(renderJson(report)) as Record<string, unknown>;
    expect(parsed.editorSummary).toBeUndefined();
  });
});

describe("renderers with a well-formed summary still render it", () => {
  const report = baseReport(GOOD);

  test("every format keeps the section", () => {
    expect(renderMarkdown(report)).toContain("First paragraph.");
    expect(renderText(report)).toContain("First paragraph.");
    expect(renderLlm(report)).toContain("<para>First paragraph.</para>");
    expect(renderXml(report)).toContain("<para>First paragraph.</para>");
    expect(renderHtml(report)).toContain('class="editor-summary-section"');
  });

  test("json emits the section byte-for-byte unchanged", () => {
    // --format json is a user-facing shape, and routing it through the guard
    // must not perturb a single byte of a well-formed summary: not the field
    // set, not the key ORDER, not the two-space indentation, not the prose
    // (which the guard splits into paragraphs for the other formats but must
    // persist verbatim, blank lines and all). A field-by-field toEqual would
    // pass on reordered keys or re-joined prose; this pins the actual output.
    const JSON_FIXTURE = [
      '  "editorSummary": {',
      '    "prose": "First paragraph.\\n\\nSecond paragraph.",',
      '    "bigTicket": [',
      '      "Fix the titles"',
      "    ],",
      '    "verdict": "Ship it",',
      '    "model": "test-model",',
      '    "generatedAt": "2026-06-16T14:30:00.000Z"',
      "  },",
    ].join("\n");
    expect(renderJson(report)).toContain(JSON_FIXTURE);

    const parsed = JSON.parse(renderJson(report)) as { editorSummary?: EditorSummary };
    expect(parsed.editorSummary).toEqual(GOOD);
    // `paragraphs` is a rendering aid on the view; it must never reach the shape.
    expect(Object.keys(parsed.editorSummary as object)).toEqual([
      "prose",
      "bigTicket",
      "verdict",
      "model",
      "generatedAt",
    ]);
  });

  test("a summary missing only bigTicket renders the prose and no bullet list", () => {
    // `bigTicket.length` was the second unguarded dereference in every format.
    const partial = baseReport({ prose: "Body text." });
    expect(renderMarkdown(partial)).toContain("Body text.");
    expect(renderText(partial)).toContain("Body text.");
    expect(renderLlm(partial)).toContain("<para>Body text.</para>");
    expect(renderXml(partial)).toContain("<para>Body text.</para>");
    expect(renderHtml(partial)).toContain('class="editor-summary-section"');
  });
});
