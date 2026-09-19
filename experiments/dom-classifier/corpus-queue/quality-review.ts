#!/usr/bin/env bun
/**
 * Read-only staging-capture preflight. It never changes a capture or manifest;
 * importers can use its heldOut ids to keep unusable renders separate.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LabelStore } from "../labeler/store.ts";
import { validateCapture } from "./import-stage.ts";

type Rect = { x: number; y: number; width: number; height: number };
type CaptureNode = { id?: string; parentId?: string | null; tag?: string; selector?: string; depth?: number; text?: string; rect?: Rect };
type Capture = { id: string; url: string; title: string; width: number; height: number; documentHeight?: number; heightCapped?: boolean; renderSettled?: string; nodes?: CaptureNode[] };
/** Targeted visual findings from representative screenshot review. */
const manualHolds: Record<string, string> = {
  page_0142db501f45d5955e534db9: "visual_review_blank_tail_despite_manifest_nodes",
};

function value(flag: string) {
  const index = process.argv.indexOf(flag), result = index < 0 ? undefined : process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error("Usage: bun quality-review.ts --stage /private/stage --output /private/quality-review.json");
  return resolve(result);
}

function pngSize(bytes: Uint8Array) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function nodeIntegrityReasons(capture: Capture) {
  const nodes = capture.nodes || [], reasons: string[] = [], ids = new Set<string>();
  for (const node of nodes) {
    if (
      typeof node.id !== "string" ||
      !/^node_[a-f0-9]{24}$/.test(node.id) ||
      ids.has(node.id) ||
      !(node.parentId === null || typeof node.parentId === "string") ||
      typeof node.tag !== "string" ||
      typeof node.selector !== "string" ||
      node.selector.length > 1_000 ||
      !Number.isInteger(node.depth) ||
      node.depth < 0 ||
      !node.rect ||
      !Number.isFinite(node.rect.x) ||
      !Number.isFinite(node.rect.y) ||
      !Number.isFinite(node.rect.width) ||
      !Number.isFinite(node.rect.height) ||
      node.rect.x < 0 || node.rect.y < 0 || node.rect.width < 1 || node.rect.height < 1 ||
      node.rect.x + node.rect.width > capture.width || node.rect.y + node.rect.height > capture.height
    ) reasons.push("invalid_node_integrity");
    if (typeof node.id === "string") ids.add(node.id);
  }
  if (nodes.some((node) => node.parentId !== null && !ids.has(node.parentId || "")))
    reasons.push("invalid_node_parent_reference");
  return [...new Set(reasons)];
}

function review(capture: Capture, imagePath: string, stage: LabelStore) {
  const reasons: string[] = [], reviewFlags: string[] = [];
  const nodes = capture.nodes || [];
  // Read once and handle the failure, rather than exists/stat then read: the
  // file can be replaced or removed between the check and the read, and the
  // read would then throw or return bytes the check never saw.
  let png: Buffer | null = null;
  try {
    const bytes = readFileSync(imagePath);
    png = bytes.length < 64 ? null : bytes;
  } catch {
    png = null;
  }
  if (!png) reasons.push("missing_or_empty_png");
  else {
    const dimensions = pngSize(png);
    if (!dimensions || dimensions.width !== capture.width || dimensions.height !== capture.height) reasons.push("png_manifest_geometry_mismatch");
    if (typeof capture.documentHeight === "number") {
      const expectedHeight = Math.min(Math.ceil(capture.documentHeight), 12_000);
      if (capture.height !== expectedHeight || dimensions?.height !== expectedHeight)
        reasons.push("png_does_not_match_bounded_document_height");
    }
  }
  if (!capture.title?.trim() || nodes.length < 8) reasons.push("insufficient_rendered_content");
  const text = `${capture.title}\n${nodes.map((node) => node.text || "").join("\n")}`.toLowerCase();
  if (/just a moment|checking your browser|verify you are human|unusual traffic|bot detection/.test(text)) reasons.push("challenge_or_access_gate");
  if (/captcha/.test(text)) reviewFlags.push("captcha_text_present_review_visually_before_import");
  if (/play the demo[\s\S]{0,100}replay intro|replay intro[\s\S]{0,100}play the demo/.test(text)) reasons.push("intro_demo_overlay_obscures_page");
  reasons.push(...nodeIntegrityReasons(capture));
  try { validateCapture(stage, capture.id); }
  catch { reasons.push("capture_fails_import_validation"); }
  if (capture.heightCapped) reviewFlags.push("height_capped_but_node_rects_are_clipped_to_png");
  if (capture.renderSettled === "bounded_timeout") reviewFlags.push("render_used_bounded_timeout");
  if (new URL(capture.url).hostname === "developer.mozilla.org") reasons.push("mdn_smoke_capture_not_corpus_candidate");
  if (manualHolds[capture.id]) reasons.push(manualHolds[capture.id]!);
  return { id: capture.id, status: reasons.length ? "held_out" : "eligible", reasons: [...new Set(reasons)], reviewFlags, geometry: { width: capture.width, height: capture.height, documentHeight: capture.documentHeight ?? capture.height, nodeCount: nodes.length } };
}

function main() {
  const stage = value("--stage"), output = value("--output"), captures = join(stage, "captures");
  if (!existsSync(captures)) throw new Error("Stage capture directory does not exist");
  const stageStore = new LabelStore(stage);
  const records = readdirSync(captures).filter((name) => /^page_[a-f0-9]{24}\.json$/.test(name)).sort().flatMap((name) => {
    try {
      const capture = JSON.parse(readFileSync(join(captures, name), "utf8")) as Capture;
      return [review(capture, join(captures, `${capture.id}.png`), stageStore)];
    } catch { return [{ id: name.slice(0, -5), status: "held_out", reasons: ["invalid_manifest"], reviewFlags: [], geometry: { width: 0, height: 0, documentHeight: 0, nodeCount: 0 } }]; }
  });
  writeFileSync(output, `${JSON.stringify({ records }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ eligible: records.filter((record) => record.status === "eligible").length, heldOut: records.filter((record) => record.status === "held_out").length, output }));
}

if (import.meta.main) main();
