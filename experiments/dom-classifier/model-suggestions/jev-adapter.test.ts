import { describe, expect, test } from "bun:test";
import {
  JEV_MODEL,
  PROMPT_REVISION,
  buildEvaluation,
  buildRequest,
  createHttpTransport,
  evaluatePage,
  type JevAnswer,
  type JevResponse,
  toModelSuggestionRows,
  validateResponse,
} from "./jev-adapter.ts";
import type { CapturedPage } from "../labeler/types.ts";
import { PAGE_TYPES, COMPONENT_TYPES } from "../labeler/types.ts";

const page: CapturedPage = {
  id: "page_1234567890abcdef12345678",
  url: "https://example.com/docs?token=secret#private",
  title: "Example docs user@example.com",
  capturedAt: "2026-09-18T00:00:00.000Z",
  contentHash: `sha256:${"a".repeat(64)}`,
  captureHash: `sha256:${"b".repeat(64)}`,
  width: 1440,
  height: 2400,
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  nodes: [
    {
      id: "node_1234567890abcdef12345678",
      parentId: null,
      tag: "header",
      role: "banner",
      text: "Docs",
      selector: "",
      rect: { x: 0, y: 0, width: 1440, height: 70 },
      depth: 2,
      suggestion: { role: "site_header", provenance: "weak", reason: "test" },
    },
    {
      id: "node_2234567890abcdef12345678",
      parentId: null,
      tag: "main",
      role: "main",
      text: "Documentation",
      selector: "",
      rect: { x: 0, y: 90, width: 1440, height: 1100 },
      depth: 2,
      suggestion: null,
    },
    {
      id: "node_3234567890abcdef12345678",
      parentId: null,
      tag: "button",
      role: null,
      text: "Submit",
      selector: "",
      rect: { x: 20, y: 100, width: 100, height: 40 },
      depth: 4,
      suggestion: null,
    },
  ],
  screenshotUrl: "",
  split: "training-review",
};

function responseFor(request: ReturnType<typeof buildRequest>): JevResponse {
  const answers: Record<string, JevAnswer> = {};
  for (const [key, question] of Object.entries(request.questions)) {
    answers[key] =
      question.type === "noul"
        ? { type: "noul", noul: key.includes("footer") ? 0.1 : 0.8 }
        : {
            type: "choice",
            choice: "unknown",
            probabilities: Object.fromEntries(
              Object.keys(question.criteria ?? {}).map((label) => [
                label,
                label === "unknown" ? 1 : 0,
              ]),
            ),
            confidence: 1,
          };
  }
  return { model: JEV_MODEL, answers, usage: { input_tokens: 1, output_tokens: 2 } };
}

describe("Jev adapter", () => {
  test("builds sanitized page and node state without weak labels or selectors", () => {
    const request = buildRequest(page, 2);
    expect(request.state.page.url).toBe("https://example.com/docs");
    expect(request.state.page.title).toBe("Example docs [EMAIL]");
    expect(request.state.candidates).toHaveLength(2);
    expect(request.state.candidates[0]).not.toHaveProperty("selector");
    expect(JSON.stringify(request.state)).not.toContain("site_header");
    expect(JSON.stringify(request.state)).not.toContain("suggestion");
    expect(Object.keys(request.questions)).toContain("page_type_homepage");
    expect(Object.keys(request.questions)).toContain(
      "node_node_1234567890abcdef12345678_component_type",
    );
    expect(PROMPT_REVISION).toBe("dom-suggestions-v3");
    expect(
      request.questions["node_node_1234567890abcdef12345678_region_top_banner"]?.criteria?.true,
    ).toContain("near the top");
    expect(
      request.questions["node_node_1234567890abcdef12345678_purpose_authentication"]?.criteria
        ?.true,
    ).toContain("sign in");
    expect(
      request.questions["node_node_1234567890abcdef12345678_component_type"]?.criteria?.popover,
    ).toContain("floating panel");
    expect(
      request.questions["node_node_1234567890abcdef12345678_component_type"]?.criteria?.dialog,
    ).toContain("focused content");
  });

  test("replaces malformed Unicode before bounded text truncation", () => {
    const malformed = {
      ...page,
      nodes: [
        { ...page.nodes[0]!, text: `${"x".repeat(319)}\uD83D\uDE00` },
        ...page.nodes.slice(1),
      ],
    } as CapturedPage;
    const request = buildRequest(malformed, 1);
    expect(request.state.candidates[0]?.text).toBe(`${"x".repeat(319)}�`);
  });

  test("keeps independent page and node axes in one typed request", () => {
    const request = buildRequest(page, 1);
    expect(
      Object.values(request.questions).filter((question) => question.type === "noul").length,
    ).toBeGreaterThan(70);
    expect(
      Object.values(request.questions).filter((question) => question.type === "choice"),
    ).toHaveLength(1);
  });

  test("validates every requested answer and preserves raw response", () => {
    const request = buildRequest(page, 1);
    const raw = responseFor(request);
    const evaluation = buildEvaluation(page, request, raw, "2026-09-18T00:00:00.000Z");
    expect(evaluation.response).toEqual(raw);
    expect(evaluation.captureHash).toBe(page.captureHash);
  });

  test("rejects missing answers and malformed probabilities", () => {
    const request = buildRequest(page, 1);
    expect(() => validateResponse({ model: JEV_MODEL, answers: {} }, request)).toThrow(
      "missing answer",
    );
    const raw = responseFor(request) as {
      model: string;
      answers: Record<string, Record<string, unknown>>;
    };
    raw.answers["page_type_homepage"] = { type: "noul", noul: 2 };
    expect(() => validateResponse(raw, request)).toThrow("probability");
    const valid = responseFor(request) as {
      model: string;
      answers: Record<string, Record<string, unknown>>;
    };
    const choiceKey = Object.keys(request.questions).find(
      (key) => request.questions[key]?.type === "choice",
    )!;
    valid.answers[choiceKey]!.probabilities = {
      ...(valid.answers[choiceKey]!.probabilities ?? {}),
      invented: 0,
    };
    expect(() => validateResponse(valid, request)).toThrow("unexpected");
  });

  test("requires a key before making HTTP requests", () => {
    expect(() => createHttpTransport({ apiKey: "" })).toThrow("TYPESAFE_API_KEY");
  });

  test("bounds live requests and does not echo provider error bodies", async () => {
    const timeoutTransport = createHttpTransport({
      apiKey: "test-key",
      timeoutMs: 5,
      fetchImpl: async (_input, init) =>
        await new Promise<never>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    });
    await expect(timeoutTransport(buildRequest(page, 1))).rejects.toThrow("timed out");

    const errorTransport = createHttpTransport({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: { message: "secret state payload" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(errorTransport(buildRequest(page, 1))).rejects.toThrow("TypeSafe HTTP 400");
    await expect(errorTransport(buildRequest(page, 1))).rejects.not.toThrow("secret state payload");
  });

  test("supports a mock transport for offline integration tests", async () => {
    const evaluation = await evaluatePage(page, async (request) => responseFor(request), 1);
    expect(evaluation.provider).toBe("typesafe");
    expect(evaluation.response.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
  });

  test("projects provisional flat rows while retaining every axis probability", async () => {
    const evaluation = await evaluatePage(page, async (request) => responseFor(request), 1);
    const rows = toModelSuggestionRows(
      page,
      evaluation,
      { noul: 0.75, choice: 0.75 },
      () => "00000000-0000-0000-0000-000000000001",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      nodeId: null,
      provisional: true,
      id: "msug_00000000-0000-0000-0000-000000000001",
    });
    expect(rows[1]?.nodeId).toBeString();
    expect(rows[0]?.rawAnswers["page_type_homepage"]?.type).toBe("noul");
    expect(rows[0]?.axisProbabilities.pageTypes).toHaveLength(PAGE_TYPES.length);
    expect(rows[1]?.componentTypeChoice?.distribution.length).toBe(COMPONENT_TYPES.length);
    expect(rows[0]?.mappedLabels.pageTypes).not.toContain("unknown");
    expect(rows[1]?.mappedLabels.regions).not.toContain("unknown");
    expect(rows[0]?.snapshotHash).toBe(rows[1]?.snapshotHash);
    expect(() =>
      toModelSuggestionRows(page, { ...evaluation, pageId: "page_000000000000000000000000" }),
    ).toThrow("pageId");
    expect(() =>
      toModelSuggestionRows(page, { ...evaluation, promptRevision: "old-prompt" }),
    ).toThrow("prompt revision");
  });
});
