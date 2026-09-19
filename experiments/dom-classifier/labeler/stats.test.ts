import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "./server.ts";
import { LabelStore } from "./store.ts";
import type { CapturedPage } from "./types.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "labeler-stats-"));
  temporaryDirectories.push(dataDir);
  const store = new LabelStore(dataDir);
  const captureHash = `sha256:${"b".repeat(64)}`;
  const page: CapturedPage = {
    id: "page_1234567890abcdef12345678",
    url: "https://example.com/",
    title: "Example",
    capturedAt: "2026-09-18T00:00:00.000Z",
    contentHash: `sha256:${"a".repeat(64)}`,
    captureHash,
    width: 1440,
    height: 900,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    screenshotUrl: "/captures/page_1234567890abcdef12345678.png",
    split: "training-review",
    nodes: [
      {
        id: "node_1234567890abcdef12345678",
        parentId: null,
        tag: "main",
        role: "main",
        text: "Main",
        selector: "main",
        rect: { x: 0, y: 0, width: 100, height: 100 },
        depth: 2,
        suggestion: null,
      },
      {
        id: "node_abcdef1234567890abcdef12",
        parentId: null,
        tag: "button",
        role: null,
        text: "Subscribe",
        selector: "button",
        rect: { x: 0, y: 100, width: 100, height: 40 },
        depth: 2,
        suggestion: null,
      },
    ],
  };
  store.writeCapture(page, new Uint8Array([137, 80, 78, 71]));
  return { store, page, captureHash };
}

function suggestion(
  id: string,
  page: CapturedPage,
  nodeId: string | null,
  captureHash = page.captureHash,
) {
  return {
    schemaVersion: 1,
    id,
    pageId: page.id,
    nodeId,
    captureHash,
    provider: "typesafe",
    modelId: "jev",
    modelRevision: "1.13.0",
    promptRevision: "stats-v1",
    snapshotHash: `sha256:${"d".repeat(64)}`,
    rawAnswers: {},
    provisional: true,
    mappedLabels: {},
    createdAt: "2026-09-18T00:00:00.000Z",
  };
}

function annotation(
  id: string,
  page: CapturedPage,
  nodeId: string,
  timestamp: string,
  modelSuggestionId?: string,
  modelReview?: "accept" | "correct" | "reject",
) {
  return {
    id,
    pageId: page.id,
    nodeId,
    decision: "label",
    role: null,
    context: null,
    regions: ["main_content"],
    functions: [],
    labelSchemaVersion: 2,
    componentType: null,
    componentSubtype: null,
    observedState: [],
    purposes: [],
    componentSchemaVersion: 0,
    componentProjection: null,
    purposeProjection: null,
    comment: null,
    boundary: "correct",
    clientRequestId: `request_${id}`,
    captureHash: page.captureHash,
    supersedes: null,
    modelSuggestionId: modelSuggestionId ?? null,
    modelReview: modelReview ?? null,
    source: "human",
    gold: false,
    timestamp,
  };
}

describe("read-only labeler stats", () => {
  test("counts current distinct suggestions and latest exact reviews without revision double-counting", async () => {
    const { store, page } = fixture();
    const [first, second] = page.nodes;
    const rows = [
      suggestion("msug_00000000-0000-0000-0000-000000000001", page, first!.id),
      suggestion("msug_00000000-0000-0000-0000-000000000002", page, second!.id),
      suggestion("msug_00000000-0000-0000-0000-000000000003", page, first!.id),
      suggestion("msug_00000000-0000-0000-0000-000000000004", page, second!.id),
      suggestion("msug_00000000-0000-0000-0000-000000000005", page, null),
      suggestion(
        "msug_00000000-0000-0000-0000-000000000006",
        page,
        first!.id,
        `sha256:${"e".repeat(64)}`,
      ),
    ];
    appendFileSync(
      store.modelSuggestionsPath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    appendFileSync(
      store.annotationsPath,
      [
        annotation(
          "ann_00000000-0000-0000-0000-000000000001",
          page,
          first!.id,
          "2026-09-18T00:00:01.000Z",
          rows[0]!.id,
          "accept",
        ),
        annotation(
          "ann_00000000-0000-0000-0000-000000000002",
          page,
          first!.id,
          "2026-09-18T00:00:02.000Z",
        ),
        annotation(
          "ann_00000000-0000-0000-0000-000000000003",
          page,
          second!.id,
          "2026-09-18T00:00:06.000Z",
          rows[1]!.id,
          "correct",
        ),
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    appendFileSync(
      store.pageAnnotationsPath,
      `${JSON.stringify({
        id: "pann_00000000-0000-0000-0000-000000000001",
        pageId: page.id,
        decision: "label",
        pageTypes: ["homepage"],
        contentKinds: [],
        comment: null,
        clientRequestId: "page_request_stats",
        captureHash: page.captureHash,
        supersedes: null,
        modelSuggestionId: rows[4]!.id,
        modelReview: "accept",
        source: "human",
        gold: false,
        timestamp: "2026-09-18T00:00:04.000Z",
      })}\n`,
    );
    appendFileSync(
      store.modelReviewsPath,
      [
        {
          id: "mrev_00000000-0000-0000-0000-000000000001",
          pageId: page.id,
          nodeId: second!.id,
          modelSuggestionId: rows[1]!.id,
          review: "reject",
          comment: null,
          clientRequestId: "review_second_reject",
          captureHash: page.captureHash,
          source: "human",
          timestamp: "2026-09-18T00:00:05.000Z",
        },
        {
          id: "mrev_00000000-0000-0000-0000-000000000002",
          pageId: page.id,
          nodeId: first!.id,
          modelSuggestionId: rows[2]!.id,
          review: "reject",
          comment: null,
          clientRequestId: "review_first_reject",
          captureHash: page.captureHash,
          source: "human",
          timestamp: "2026-09-18T00:00:07.000Z",
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    const response = await handleRequest(
      new Request("http://127.0.0.1:4317/api/stats", { headers: { host: "127.0.0.1:4317" } }),
      store,
    );
    expect(response.status).toBe(200);
    const stats = await response.json();
    expect(stats).toMatchObject({
      pages: { total: 1, labelled: 1, currentPageLabels: 1 },
      elements: { total: 2, currentHumanLabels: 2, latestManualLabels: 1 },
      suggestions: {
        total: 3,
        page: 1,
        element: 2,
        pending: 0,
        reviewed: { accepted: 1, corrected: 0, rejected: 1 },
      },
    });
    const exported = await handleRequest(
      new Request("http://127.0.0.1:4317/api/export/reviews", {
        headers: { host: "127.0.0.1:4317" },
      }),
      store,
    );
    expect(exported.status).toBe(200);
    const history = await exported.json();
    expect(history.stats.suggestions).toEqual(stats.suggestions);
    expect(history.nodeAnnotationHistory).toHaveLength(3);
    expect(history.pageAnnotationHistory).toHaveLength(1);
    expect(history.modelReviewHistory).toHaveLength(2);
  });
});
