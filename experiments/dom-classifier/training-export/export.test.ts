import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LabelStore } from "../labeler/store.ts";
import type { CapturedPage } from "../labeler/types.ts";
import { exportReviewedLabels } from "./export.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporary(name: string) {
  const directory = mkdtempSync(join(tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture() {
  const inputDir = temporary("training-export-input-");
  const store = new LabelStore(inputDir);
  const captureHash = `sha256:${"b".repeat(64)}`;
  const page: CapturedPage = {
    id: "page_1234567890abcdef12345678",
    url: "https://www.example.co.uk/pricing",
    title: "Pricing",
    capturedAt: "2026-09-19T00:00:00.000Z",
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
        tag: "button",
        role: null,
        text: "Subscribe",
        selector: "button",
        rect: { x: 0, y: 0, width: 100, height: 30 },
        depth: 2,
        suggestion: null,
      },
      {
        id: "node_abcdef1234567890abcdef12",
        parentId: null,
        tag: "div",
        role: null,
        text: "Mixed",
        selector: "div",
        rect: { x: 0, y: 30, width: 100, height: 30 },
        depth: 2,
        suggestion: null,
      },
    ],
  };
  store.writeCapture(page, new Uint8Array([137, 80, 78, 71]));
  return { inputDir, store, page };
}

describe("reviewed-label training export", () => {
  test("restores the predecessor when the terminal action is undone", async () => {
    const { inputDir, store, page } = fixture();
    const earlier = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["footer"],
      boundary: "correct",
      clientRequestId: "undo-earlier",
      captureHash: page.captureHash,
    });
    const current = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["main_content"],
      boundary: "correct",
      clientRequestId: "undo-current",
      captureHash: page.captureHash,
      supersedes: earlier.id,
    });
    appendFileSync(
      store.reviewUndosPath,
      `${JSON.stringify({
        id: "undo_00000000-0000-0000-0000-000000000001",
        actionKind: "annotation",
        actionId: current.id,
        pageId: page.id,
        nodeId: page.nodes[0]!.id,
        captureHash: page.captureHash,
        timestamp: "2026-09-19T00:01:00.000Z",
      })}\n`,
    );
    const outputRoot = temporary("training-export-undo-output-");
    const outputDir = join(outputRoot, "snapshot");
    const groupsPath = join(outputRoot, "groups.json");
    await Bun.write(groupsPath, JSON.stringify([{ pageId: page.id, groupId: "example.co.uk" }]));

    const manifest = await exportReviewedLabels({ inputDir, outputDir, groupingInput: groupsPath });

    const rows = readFileSync(join(outputDir, "node-examples.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].labels).toEqual({ regions: ["footer"] });
    expect(readFileSync(join(outputDir, "audit", "review-undos.jsonl"), "utf8")).toContain(
      current.id,
    );
  });

  test("exports only the latest explicit, current human positives and preserves audit provenance", async () => {
    const { inputDir, store, page } = fixture();
    const suggestionId = "msug_00000000-0000-0000-0000-000000000001";
    appendFileSync(
      store.modelSuggestionsPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: suggestionId,
        pageId: page.id,
        nodeId: page.nodes[0]!.id,
        captureHash: page.captureHash,
        provider: "typesafe",
        modelId: "jev",
        modelRevision: "1",
        promptRevision: "v1",
        snapshotHash: `sha256:${"c".repeat(64)}`,
        rawAnswers: {},
        provisional: true,
        mappedLabels: { regions: ["footer"] },
        createdAt: "2026-09-19T00:00:00.000Z",
      })}\n`,
    );
    const earlier = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["footer"],
      boundary: "correct",
      clientRequestId: "export-earlier",
      captureHash: page.captureHash,
    });
    store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["footer"],
      componentType: "button",
      componentSubtype: "primary",
      observedState: ["disabled"],
      purposes: ["subscription"],
      boundary: "correct",
      clientRequestId: "export-current",
      captureHash: page.captureHash,
      supersedes: earlier.id,
      modelSuggestionId: suggestionId,
      modelReview: "correct",
    });
    store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[1]!.id,
      decision: "label",
      regions: ["main_content"],
      boundary: "too_broad",
      clientRequestId: "export-bad-boundary",
      captureHash: page.captureHash,
    });
    const outputRoot = temporary("training-export-output-root-");
    const outputDir = join(outputRoot, "snapshot");
    const groupsPath = join(outputRoot, "groups.json");
    await Bun.write(groupsPath, JSON.stringify([{ pageId: page.id, groupId: "example.co.uk" }]));

    const manifest = await exportReviewedLabels({ inputDir, outputDir, groupingInput: groupsPath });

    const rows = readFileSync(join(outputDir, "node-examples.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "human",
      gold: false,
      splitGroup: { groupId: "example.co.uk", source: "documented_input" },
      labels: {
        regions: ["footer"],
        componentType: "button",
        componentSubtype: "primary",
        observedState: ["disabled"],
        purposes: ["subscription"],
      },
      teacher: { modelSuggestionId: suggestionId, modelId: "jev" },
    });
    expect(rows[0].labels.functions).toBeUndefined();
    expect(manifest.counts.exclusions).toEqual({ boundary_too_broad: 1 });
    expect(existsSync(join(outputDir, "audit", "annotations.jsonl"))).toBe(true);
    expect(existsSync(join(outputDir, "audit", "captures", `${page.id}.json`))).toBe(true);
    expect(readFileSync(store.annotationsPath, "utf8")).toContain(earlier.id);
  });

  test("rejects outputs that could alter or enter the source store or checkout", async () => {
    const { inputDir, store, page } = fixture();
    store.savePageAnnotation({
      pageId: page.id,
      decision: "label",
      pageTypes: ["pricing"],
      clientRequestId: "export-page",
      captureHash: page.captureHash,
    });
    const groupsRoot = temporary("training-export-groups-");
    const groupsPath = join(groupsRoot, "groups.json");
    await Bun.write(groupsPath, JSON.stringify([{ pageId: page.id, groupId: "example.co.uk" }]));
    await expect(
      exportReviewedLabels({
        inputDir,
        outputDir: join(inputDir, "snapshot"),
        groupingInput: groupsPath,
      }),
    ).rejects.toThrow("separate from the active label store");
    await expect(
      exportReviewedLabels({
        inputDir,
        outputDir: join(process.cwd(), "training-export-output"),
        groupingInput: groupsPath,
      }),
    ).rejects.toThrow("outside the repository");
    const conflictingGroups = join(groupsRoot, "conflicting-groups.json");
    await Bun.write(
      conflictingGroups,
      JSON.stringify([
        { pageId: page.id, groupId: "example.co.uk" },
        { url: page.url, groupId: "other.example" },
      ]),
    );
    await expect(
      exportReviewedLabels({
        inputDir,
        outputDir: join(groupsRoot, "conflicting-snapshot"),
        groupingInput: conflictingGroups,
      }),
    ).rejects.toThrow("Conflicting documented split groups");
  });

  test("fails closed for a malformed supersession chain", async () => {
    const { inputDir, store, page } = fixture();
    const saved = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["footer"],
      boundary: "correct",
      clientRequestId: "export-chain-first",
      captureHash: page.captureHash,
    });
    appendFileSync(
      store.annotationsPath,
      `${JSON.stringify({ ...saved, clientRequestId: "export-chain-bad", modelSuggestionId: "msug_00000000-0000-0000-0000-000000000099", modelReview: "accept", supersedes: null })}\n`,
    );
    appendFileSync(
      store.modelSuggestionsPath,
      `${JSON.stringify({ schemaVersion: 1, id: "msug_00000000-0000-0000-0000-000000000099", pageId: page.id, nodeId: null, captureHash: page.captureHash, provider: "typesafe", modelId: "jev", modelRevision: "1", promptRevision: "v1", snapshotHash: `sha256:${"d".repeat(64)}`, rawAnswers: {}, provisional: true, mappedLabels: {}, createdAt: "2026-09-19T00:00:00.000Z" })}\n`,
    );
    const outputRoot = temporary("training-export-malformed-");
    const groupsPath = join(outputRoot, "groups.json");
    await Bun.write(groupsPath, JSON.stringify([{ pageId: page.id, groupId: "example.co.uk" }]));
    const manifest = await exportReviewedLabels({
      inputDir,
      outputDir: join(outputRoot, "snapshot"),
      groupingInput: groupsPath,
    });
    expect(manifest.counts.nodeExamples).toBe(0);
    expect(manifest.counts.exclusions.malformed_supersession_chain).toBe(1);
    const excluded = readFileSync(join(outputRoot, "snapshot", "excluded.jsonl"), "utf8");
    expect(excluded).toContain("malformed_supersession_chain");
  });

  test("keeps a mismatched model suggestion as non-trusted provenance only", async () => {
    const { inputDir, store, page } = fixture();
    const saved = store.saveAnnotation({
      pageId: page.id,
      nodeId: page.nodes[0]!.id,
      decision: "label",
      regions: ["footer"],
      boundary: "correct",
      clientRequestId: "export-teacher-first",
      captureHash: page.captureHash,
    });
    const suggestionId = "msug_00000000-0000-0000-0000-000000000098";
    appendFileSync(
      store.annotationsPath,
      `${JSON.stringify({ ...saved, id: "ann-teacher-mismatch", clientRequestId: "export-teacher-mismatch", supersedes: saved.id, modelSuggestionId: suggestionId, modelReview: "correct" })}\n`,
    );
    appendFileSync(
      store.modelSuggestionsPath,
      `${JSON.stringify({ schemaVersion: 1, id: suggestionId, pageId: page.id, nodeId: null, captureHash: page.captureHash, provider: "typesafe", modelId: "jev", modelRevision: "1", promptRevision: "v1", snapshotHash: `sha256:${"e".repeat(64)}`, rawAnswers: {}, provisional: true, mappedLabels: {}, createdAt: "2026-09-19T00:00:00.000Z" })}\n`,
    );
    const outputRoot = temporary("training-export-teacher-");
    const groupsPath = join(outputRoot, "groups.json");
    await Bun.write(groupsPath, JSON.stringify([{ pageId: page.id, groupId: "example.co.uk" }]));
    await exportReviewedLabels({
      inputDir,
      outputDir: join(outputRoot, "snapshot"),
      groupingInput: groupsPath,
    });
    const row = JSON.parse(
      readFileSync(join(outputRoot, "snapshot", "node-examples.jsonl"), "utf8"),
    );
    expect(row).toMatchObject({
      source: "human",
      gold: false,
      teacher: { modelSuggestionId: suggestionId, presentInAuditHistory: false },
    });
    expect(row.teacher.modelId).toBeUndefined();
  });
});
