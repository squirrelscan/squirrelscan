#!/usr/bin/env bun
/**
 * Validate reviewed staged renders and copy only immutable capture pairs into
 * the active labeler capture directory. It never reads or writes annotations.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_CAPTURE_HEIGHT,
  normalizeCorpusCaptureTarget,
  pngDimensions,
  type CorpusCaptureTarget,
} from "../labeler/capture.ts";
import { LabelStore } from "../labeler/store.ts";
import type { CapturedPage } from "../labeler/types.ts";
import { readManifest } from "./render-queue.ts";

type Arguments = { stage: string; destination: string; review: string; manifest: string };
type QualityRecord = {
  id: string;
  status: "eligible" | "held_out";
  reasons: string[];
  reviewFlags: string[];
  geometry: { width: number; height: number; documentHeight: number; nodeCount: number };
};
type ImportSummary = {
  inspected: number;
  eligible: number;
  heldOut: number;
  imported: number;
  alreadyPresent: number;
};

function usage() {
  return "Usage: bun import-stage.ts --stage /private/stage --manifest /private/queue.jsonl --review /private/quality-review.json --destination /private/human-ui-v1";
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !["--stage", "--destination", "--review", "--manifest"].includes(flag))
      throw new Error(usage());
    if (values.has(flag)) throw new Error(`Duplicate ${flag}`);
    values.set(flag, value);
  }
  const stage = values.get("--stage");
  const destination = values.get("--destination");
  const review = values.get("--review");
  const manifest = values.get("--manifest");
  if (!stage || !destination || !review || !manifest) throw new Error(usage());
  return {
    stage: resolve(stage),
    destination: resolve(destination),
    review: resolve(review),
    manifest: resolve(manifest),
  };
}

function readQualityReview(path: string, stagedIds: Set<string>) {
  if (!existsSync(path)) throw new Error("Quality review does not exist");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Quality review is not valid JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("records" in value) ||
    !Array.isArray(value.records)
  )
    throw new Error("Invalid quality review shape");
  const records = new Map<string, QualityRecord>();
  for (const entry of value.records) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid quality review record");
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !["id", "status", "reasons", "reviewFlags", "geometry"].includes(key),
      ) ||
      typeof record.id !== "string" ||
      !/^page_[a-f0-9]{24}$/.test(record.id) ||
      (record.status !== "eligible" && record.status !== "held_out") ||
      !Array.isArray(record.reasons) ||
      !Array.isArray(record.reviewFlags) ||
      record.reasons.length > 20 ||
      record.reviewFlags.length > 20 ||
      record.reasons.some((reason) => typeof reason !== "string" || reason.length > 200) ||
      record.reviewFlags.some((flag) => typeof flag !== "string" || flag.length > 120) ||
      !record.geometry ||
      typeof record.geometry !== "object" ||
      Array.isArray(record.geometry) ||
      Object.keys(record.geometry).some(
        (key) => !["width", "height", "documentHeight", "nodeCount"].includes(key),
      )
    )
      throw new Error("Invalid quality review record");
    const geometry = record.geometry as Record<string, unknown>;
    if (
      ![geometry.width, geometry.height, geometry.documentHeight, geometry.nodeCount].every(
        (number) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0,
      )
    )
      throw new Error("Invalid quality review geometry");
    if (!stagedIds.has(record.id) || records.has(record.id))
      throw new Error("Quality review has an unknown or duplicate capture ID");
    records.set(record.id, record as QualityRecord);
  }
  if (records.size !== stagedIds.size || [...stagedIds].some((id) => !records.has(id)))
    throw new Error("Quality review is missing a staged capture ID");
  return records;
}

function assertSafeNodeGeometry(page: CapturedPage, width: number, height: number) {
  const ids = new Set<string>();
  for (const node of page.nodes) {
    if (
      !/^node_[a-f0-9]{24}$/.test(node.id) ||
      typeof node.tag !== "string" ||
      typeof node.selector !== "string" ||
      node.selector.length > 1_000 ||
      !Number.isInteger(node.depth) ||
      node.depth < 0 ||
      !Number.isFinite(node.rect.x) ||
      !Number.isFinite(node.rect.y) ||
      !Number.isFinite(node.rect.width) ||
      !Number.isFinite(node.rect.height) ||
      node.rect.x < 0 ||
      node.rect.y < 0 ||
      node.rect.width < 1 ||
      node.rect.height < 1 ||
      node.rect.x + node.rect.width > width ||
      node.rect.y + node.rect.height > height ||
      ids.has(node.id)
    )
      throw new Error(`Invalid geometry for ${page.id}`);
    ids.add(node.id);
  }
  if (page.nodes.some((node) => node.parentId !== null && !ids.has(node.parentId)))
    throw new Error(`Invalid node parent for ${page.id}`);
}

function validateCapture(store: LabelStore, id: string) {
  const page = store.readPage(id);
  if (
    page.sourceKind !== "fresh_capture" ||
    typeof page.sourceUrl !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(page.captureHash) ||
    page.screenshotUrl !== `/captures/${page.id}.png`
  )
    throw new Error(`Invalid provenance for ${id}`);
  normalizeCorpusCaptureTarget({ url: page.sourceUrl });
  const screenshot = readFileSync(store.screenshotPath(id));
  const dimensions = pngDimensions(screenshot);
  if (
    dimensions.width !== page.width ||
    dimensions.height !== page.height ||
    page.width < 1 ||
    page.height < 1 ||
    page.height > MAX_CAPTURE_HEIGHT
  )
    throw new Error(`PNG dimensions do not match ${id}`);
  if (
    page.documentHeight === undefined ||
    !Number.isFinite(page.documentHeight) ||
    page.documentHeight < page.height ||
    page.height !== Math.min(MAX_CAPTURE_HEIGHT, Math.ceil(page.documentHeight)) ||
    page.heightCapped !== page.documentHeight > page.height
  )
    throw new Error(`Invalid bounded document height for ${id}`);
  if (page.renderSettled !== "networkidle" && page.renderSettled !== "bounded_timeout")
    throw new Error(`Missing render-settle provenance for ${id}`);
  assertSafeNodeGeometry(page, dimensions.width, dimensions.height);
  return { page, screenshot };
}

function assertReviewedGeometry(record: QualityRecord, page: CapturedPage) {
  if (
    record.geometry.width !== page.width ||
    record.geometry.height !== page.height ||
    record.geometry.documentHeight !== page.documentHeight ||
    record.geometry.nodeCount !== page.nodes.length
  )
    throw new Error(`Quality review geometry does not match ${page.id}`);
}

function assertFrozenProvenance(page: CapturedPage, target: CorpusCaptureTarget) {
  const sourceUrl = normalizeCorpusCaptureTarget({ url: page.sourceUrl! }).url;
  if (
    sourceUrl !== target.url ||
    (page.originalCrawledAt ?? null) !== (target.originalCrawledAt ?? null) ||
    (page.corpusRef ?? null) !== (target.corpusRef ?? null)
  )
    throw new Error(`Capture provenance does not match frozen queue: ${page.id}`);
}

function existingCaptureIsIdentical(destination: LabelStore, page: CapturedPage) {
  const hasManifest = existsSync(destination.capturePath(page.id));
  const hasScreenshot = existsSync(destination.screenshotPath(page.id));
  if (hasManifest !== hasScreenshot)
    throw new Error(`Destination has a partial capture pair for ${page.id}; quarantine it manually`);
  if (!hasManifest)
    return false;
  const existing = validateCapture(destination, page.id).page;
  if (existing.captureHash !== page.captureHash || existing.contentHash !== page.contentHash)
    throw new Error(`Existing capture ID conflicts with ${page.id}`);
  return true;
}

async function importStage(args: Arguments) {
  const stage = new LabelStore(args.stage);
  const destination = new LabelStore(args.destination);
  if (!existsSync(stage.capturesDir)) throw new Error("Stage has no captures directory");
  destination.ensureDirectories();
  const stagedIds = new Set(
    readdirSync(stage.capturesDir)
      .filter((name) => /^page_[a-f0-9]{24}\.json$/.test(name))
      .map((name) => name.slice(0, -5)),
  );
  const review = readQualityReview(args.review, stagedIds);
  const staged = [...review.values()]
    .filter((record) => record.status === "eligible")
    .map((record) => ({ ...validateCapture(stage, record.id), review: record }));
  for (const item of staged) assertReviewedGeometry(item.review, item.page);
  const manifestTargets = new Map(readManifest(args.manifest).map((target) => [target.url, target]));
  for (const item of staged) {
    const sourceUrl = normalizeCorpusCaptureTarget({ url: item.page.sourceUrl! }).url;
    const target = manifestTargets.get(sourceUrl);
    if (!target)
      throw new Error(`Eligible capture is outside the frozen queue: ${item.page.id}`);
    assertFrozenProvenance(item.page, target);
  }
  const summary: ImportSummary = {
    inspected: stagedIds.size,
    eligible: staged.length,
    heldOut: stagedIds.size - staged.length,
    imported: 0,
    alreadyPresent: 0,
  };
  for (const { page, screenshot } of staged) {
    if (existingCaptureIsIdentical(destination, page)) {
      summary.alreadyPresent += 1;
      continue;
    }
    destination.writeCapture(page, screenshot);
    summary.imported += 1;
  }
  console.log(JSON.stringify({ status: "imported", ...summary }));
}

if (import.meta.main) {
  try {
    await importStage(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Import failed");
    process.exitCode = 1;
  }
}

export { assertFrozenProvenance, existingCaptureIsIdentical, importStage, parseArguments, validateCapture };
