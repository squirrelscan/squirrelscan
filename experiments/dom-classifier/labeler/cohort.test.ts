import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cohortsFromEnv, handleRequest } from "./server.ts";
import { LabelStore } from "./store.ts";
import { PRIMARY_COHORT_ID, type AnnotationInput, type CapturedPage } from "./types.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temp(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function page(id: string, nodeId: string): CapturedPage {
  return {
    id,
    url: "https://example.test/",
    title: "Example",
    capturedAt: "2026-09-19T00:00:00.000Z",
    contentHash: `sha256:${"a".repeat(64)}`,
    captureHash: `sha256:${"b".repeat(64)}`,
    width: 1440,
    height: 900,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    screenshotUrl: `/captures/${id}.png`,
    split: "training-review",
    nodes: [
      {
        id: nodeId,
        parentId: null,
        tag: "footer",
        role: "contentinfo",
        text: "Footer text",
        selector: "html > body:nth-of-type(1) > footer:nth-of-type(1)",
        rect: { x: 0, y: 0, width: 400, height: 100 },
        depth: 2,
        suggestion: null,
      },
    ],
  };
}

/** A cohort directory is exactly a `captures/` dir plus an optional sidecar. */
function writeCohort(id: string, pages: CapturedPage[], suggestions: unknown[] = []) {
  const dir = temp(`labeler-cohort-${id}-`);
  mkdirSync(join(dir, "captures"), { recursive: true });
  for (const captured of pages) {
    writeFileSync(join(dir, "captures", `${captured.id}.json`), JSON.stringify(captured));
    writeFileSync(join(dir, "captures", `${captured.id}.png`), "png-bytes");
  }
  if (suggestions.length)
    writeFileSync(
      join(dir, "model-suggestions.jsonl"),
      suggestions.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
  return { id, dir };
}

const primaryPageId = "page_1111111111111111111111aa";
const primaryNodeId = "node_1111111111111111111111aa";
const cohortPageId = "page_2222222222222222222222bb";
const cohortNodeId = "node_2222222222222222222222bb";

function annotation(pageId: string, nodeId: string, clientRequestId: string): AnnotationInput {
  return {
    pageId,
    nodeId,
    decision: "label",
    regions: ["footer"],
    boundary: "correct",
    captureHash: `sha256:${"b".repeat(64)}`,
    clientRequestId,
  };
}

function primaryWithCohort() {
  const dataDir = temp("labeler-primary-");
  const seed = new LabelStore(dataDir);
  seed.ensureDirectories();
  writeFileSync(join(dataDir, "captures", `${primaryPageId}.json`), JSON.stringify(page(primaryPageId, primaryNodeId)));
  writeFileSync(join(dataDir, "captures", `${primaryPageId}.png`), "png-bytes");
  const cohort = writeCohort("review-v1", [page(cohortPageId, cohortNodeId)]);
  return { dataDir, cohort, store: new LabelStore(dataDir, [cohort]) };
}

describe("cohort mounting", () => {
  test("lists pages from the primary set and every mounted cohort", () => {
    const { store } = primaryWithCohort();
    expect(store.listPages().map((item) => item.id).sort()).toEqual([primaryPageId, cohortPageId].sort());
    expect(store.readPage(cohortPageId).id).toBe(cohortPageId);
    expect(readFileSync(store.screenshotPath(cohortPageId), "utf8")).toBe("png-bytes");
  });

  test("stamps the owning cohort id on every stored label", () => {
    const { store } = primaryWithCohort();
    const fromPrimary = store.saveAnnotation(annotation(primaryPageId, primaryNodeId, "req_primary_1"));
    const fromCohort = store.saveAnnotation(annotation(cohortPageId, cohortNodeId, "req_cohort_1"));
    expect(fromPrimary.cohortId).toBe(PRIMARY_COHORT_ID);
    expect(fromCohort.cohortId).toBe("review-v1");
  });

  test("labels for a mounted cohort are written to the primary journal, not the cohort", () => {
    const { dataDir, cohort, store } = primaryWithCohort();
    store.saveAnnotation(annotation(cohortPageId, cohortNodeId, "req_cohort_2"));
    expect(readFileSync(join(dataDir, "annotations.jsonl"), "utf8")).toContain(cohortPageId);
    expect(() => readFileSync(join(cohort.dir, "annotations.jsonl"), "utf8")).toThrow();
  });

  test("existing labels survive a cohort being mounted and read as primary", () => {
    const { dataDir, cohort } = primaryWithCohort();
    const before = new LabelStore(dataDir);
    const existing = before.saveAnnotation(annotation(primaryPageId, primaryNodeId, "req_before_1"));
    const journal = readFileSync(join(dataDir, "annotations.jsonl"), "utf8");

    const after = new LabelStore(dataDir, [cohort]);
    expect(readFileSync(join(dataDir, "annotations.jsonl"), "utf8")).toBe(journal);
    expect(after.readAnnotations().map((row) => row.id)).toEqual([existing.id]);
    expect(after.stats().byCohort[PRIMARY_COHORT_ID]?.currentHumanLabels).toBe(1);
  });

  test("reports stats per cohort and keeps the primary entry when nothing is mounted", () => {
    const { store } = primaryWithCohort();
    store.saveAnnotation(annotation(cohortPageId, cohortNodeId, "req_cohort_3"));
    const stats = store.stats();
    expect(stats.byCohort[PRIMARY_COHORT_ID]).toEqual({
      pages: 1,
      labelledPages: 0,
      currentHumanLabels: 0,
      bySource: {},
    });
    expect(stats.byCohort["review-v1"]).toEqual({
      pages: 1,
      labelledPages: 1,
      currentHumanLabels: 1,
      bySource: {},
    });

    const soloDir = temp("labeler-solo-");
    expect(Object.keys(new LabelStore(soloDir).stats().byCohort)).toEqual([PRIMARY_COHORT_ID]);
  });

  test("reads a cohort's own model-suggestions sidecar", async () => {
    const dataDir = temp("labeler-suggest-");
    const seed = new LabelStore(dataDir);
    seed.ensureDirectories();
    const suggestion = {
      schemaVersion: 1,
      id: "msug_00000000-0000-4000-8000-000000000001",
      pageId: cohortPageId,
      nodeId: cohortNodeId,
      captureHash: `sha256:${"b".repeat(64)}`,
      provider: "typesafe",
      modelId: "jev",
      modelRevision: "jev-1.13.0",
      promptRevision: "dom-suggestions-v4",
      taxonomyRevision: "dom-taxonomy-v2",
      snapshotHash: `sha256:${"c".repeat(64)}`,
      rawAnswers: { annotator: "jev" },
      provisional: true,
      mappedLabels: { componentType: "content_section", regions: ["footer"] },
      createdAt: "2026-09-19T00:00:00.000Z",
    };
    const cohort = writeCohort("review-v1", [page(cohortPageId, cohortNodeId)], [suggestion]);
    const store = new LabelStore(dataDir, [cohort]);
    expect(store.modelSuggestionsForPage(cohortPageId).map((row) => row.id)).toEqual([suggestion.id]);
    const response = await handleRequest(
      new Request(`http://127.0.0.1/api/pages/${cohortPageId}`, { headers: { host: "127.0.0.1" } }),
      store,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).modelSuggestions).toHaveLength(1);
  });

  test("counts accepted and rejected per annotator, per cohort", () => {
    const dataDir = temp("labeler-source-");
    new LabelStore(dataDir).ensureDirectories();
    const base = {
      schemaVersion: 1,
      pageId: cohortPageId,
      nodeId: cohortNodeId,
      captureHash: `sha256:${"b".repeat(64)}`,
      provider: "typesafe",
      promptRevision: "v4",
      taxonomyRevision: "dom-taxonomy-v2",
      snapshotHash: `sha256:${"c".repeat(64)}`,
      rawAnswers: {},
      provisional: true,
      createdAt: "2026-09-19T00:00:00.000Z",
    };
    const jev = {
      ...base,
      id: "msug_00000000-0000-4000-8000-00000000000a",
      modelId: "jev",
      modelRevision: "jev-1",
      mappedLabels: { componentType: "content_section" },
    };
    const luna = {
      ...base,
      id: "msug_00000000-0000-4000-8000-00000000000b",
      modelId: "luna",
      modelRevision: "luna-1",
      mappedLabels: { componentType: "layout_container" },
    };
    const cohort = writeCohort("review-v1", [page(cohortPageId, cohortNodeId)], [jev, luna]);
    const store = new LabelStore(dataDir, [cohort]);

    // A human sides with Luna, which also rejects Jev's competing row.
    store.saveAnnotation({
      ...annotation(cohortPageId, cohortNodeId, "req_pick_luna"),
      componentType: "layout_container",
      modelSuggestionId: luna.id,
      modelReview: "accept",
    });
    store.saveModelReview({
      pageId: cohortPageId,
      nodeId: cohortNodeId,
      modelSuggestionId: jev.id,
      review: "reject",
      clientRequestId: "req_reject_jev",
      captureHash: base.captureHash,
    });

    // Both rows survive: keeping only the latest suggestion per node would have
    // hidden whichever annotator lost.
    expect(store.stats().byCohort["review-v1"]?.bySource).toEqual({
      luna: { accepted: 1, rejected: 0 },
      jev: { accepted: 0, rejected: 1 },
    });
  });

  test("the primary set wins an id collision, so a cohort cannot shadow a capture", () => {
    const { dataDir } = primaryWithCohort();
    const shadow = writeCohort("review-v1", [{ ...page(primaryPageId, primaryNodeId), title: "Shadow" }]);
    const store = new LabelStore(dataDir, [shadow]);
    expect(store.readPage(primaryPageId).title).toBe("Example");
    expect(store.cohortIdForPage(primaryPageId)).toBe(PRIMARY_COHORT_ID);
    expect(store.listPages()).toHaveLength(1);
  });

  test("rejects an unusable cohort id", () => {
    const dataDir = temp("labeler-bad-");
    expect(() => new LabelStore(dataDir, [{ id: "../escape", dir: dataDir }])).toThrow("Invalid cohort id");
    expect(() => new LabelStore(dataDir, [{ id: PRIMARY_COHORT_ID, dir: dataDir }])).toThrow("Invalid cohort id");
    expect(() => new LabelStore(dataDir, [
      { id: "a", dir: dataDir },
      { id: "a", dir: dataDir },
    ])).toThrow("Duplicate cohort id");
  });
});

describe("LABELER_COHORTS parsing", () => {
  test("parses id=path entries and ignores an empty value", () => {
    expect(cohortsFromEnv("review-v1=/private/cohort")).toEqual([{ id: "review-v1", dir: "/private/cohort" }]);
    expect(cohortsFromEnv(" a=/one , b=/two ")).toEqual([
      { id: "a", dir: "/one" },
      { id: "b", dir: "/two" },
    ]);
    expect(cohortsFromEnv("")).toEqual([]);
    expect(cohortsFromEnv(undefined)).toEqual([]);
  });

  test("rejects an entry that is not id=path", () => {
    expect(() => cohortsFromEnv("/private/cohort")).toThrow("id=path");
    expect(() => cohortsFromEnv("=/private/cohort")).toThrow("id=path");
  });
});
