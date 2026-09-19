#!/usr/bin/env bun
/**
 * Assemble a fresh, private DOM corpus from already-rendered staging stores.
 *
 * This command never fetches, labels, modifies a source stage, or treats URL
 * hints as page truth. It only copies selected immutable capture pairs into a
 * new output directory after deterministic DOM-quality and provenance checks.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getDomain } from "../../../packages/crawler/node_modules/tldts";
import { pngDimensions } from "../labeler/capture.ts";
import { LabelStore } from "../labeler/store.ts";
import type { CapturedNode, CapturedPage } from "../labeler/types.ts";

export const FINAL_CORPUS_SIZE = 500;
export const HOMEPAGE_CAP = 100;
export const FAMILY_HINT_CAP = 125;

type SourceCohort = "cloud" | "PH" | "public";
export type SourceMetadata = {
  sourceBucket: SourceCohort;
  sourceSeed: string;
  familyHint: string;
};
export type Candidate = {
  page: CapturedPage;
  stage: string;
  source: SourceMetadata;
  domainGroup: string;
  templateFingerprint: string;
  templateFeatures: Set<string>;
};
export type HeldOut = { pageId: string; sourceUrl: string | null; reasons: string[] };
export type Selected = Candidate & { path: string };
export type Selection = {
  selected: Selected[];
  heldOut: HeldOut[];
  nearDuplicates: Array<{ keptPageId: string; heldOutPageId: string; similarity: number }>;
  diagnostics: Record<string, unknown>;
};

const challengePattern =
  /just a moment|checking your browser|verify you are human|unusual traffic|bot detection|captcha/i;
const soft404Pattern = /\b(?:404|page not found|nothing here|does not exist|not available)\b/i;
const mediaTags = new Set(["img", "picture", "figure", "video", "audio", "iframe"]);
const targetTags = new Set([
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "img",
  "picture",
  "video",
  "audio",
  "table",
  "article",
  "main",
]);

function normalizedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
    throw new Error("source URL must be public HTTPS");
  url.search = "";
  url.hash = "";
  return url.href;
}

function sourceUrl(page: CapturedPage) {
  return typeof page.sourceUrl === "string"
    ? normalizedUrl(page.sourceUrl)
    : normalizedUrl(page.url);
}

function isUsefulTarget(node: CapturedNode) {
  return (
    Number.isFinite(node.rect.x) &&
    Number.isFinite(node.rect.y) &&
    Number.isFinite(node.rect.width) &&
    Number.isFinite(node.rect.height) &&
    node.rect.width >= 2 &&
    node.rect.height >= 2 &&
    (node.text.trim().length > 0 || targetTags.has(node.tag.toLowerCase()) || Boolean(node.role))
  );
}

/** DOM-shape features intentionally exclude text and selector values. */
export function templateFeatures(page: CapturedPage) {
  const width = Math.max(1, page.width);
  const height = Math.max(1, page.height);
  const features = new Set<string>();
  for (const node of page.nodes.slice(0, 500)) {
    const tag = node.tag.toLowerCase();
    const x = Math.min(9, Math.max(0, Math.floor((node.rect.x / width) * 10)));
    const y = Math.min(19, Math.max(0, Math.floor((node.rect.y / height) * 20)));
    const size = Math.min(
      5,
      Math.floor(Math.log2(Math.max(1, node.rect.width * node.rect.height)) / 4),
    );
    features.add(`${tag}:${node.role ?? "-"}:${Math.min(node.depth, 12)}:${x}:${y}:${size}`);
  }
  return features;
}

function fingerprint(features: Set<string>) {
  return createHash("sha256")
    .update([...features].sort().join("\n"))
    .digest("hex");
}

function similarity(left: Set<string>, right: Set<string>) {
  let shared = 0;
  for (const feature of left) if (right.has(feature)) shared += 1;
  return shared / Math.max(1, left.size + right.size - shared);
}

export function qualityReasons(page: CapturedPage, png?: Uint8Array): string[] {
  const reasons: string[] = [];
  const primaryText =
    page.nodes
      .filter((node) => node.role === "main" || ["main", "article", "body"].includes(node.tag))
      .map((node) => node.text.trim())
      .sort((left, right) => right.length - left.length)[0] ?? "";
  const thinPrimary = primaryText.length < 320;
  const challengeDominates =
    challengePattern.test(page.title) || (thinPrimary && challengePattern.test(primaryText));
  const soft404Dominates =
    soft404Pattern.test(page.title) || (thinPrimary && soft404Pattern.test(primaryText));
  if (!page.title.trim() || page.nodes.length < 8) reasons.push("empty_or_insufficient_dom");
  if (challengeDominates) reasons.push("challenge_or_access_gate");
  if (soft404Dominates) reasons.push("soft_404");
  if (page.nodes.filter(isUsefulTarget).length < 3) reasons.push("inadequate_dom_targets");
  if (!/^sha256:[a-f0-9]{64}$/.test(page.captureHash)) reasons.push("invalid_capture_hash");
  if (page.sourceKind !== "fresh_capture") reasons.push("not_fresh_capture");
  if (!png) reasons.push("missing_png");
  else {
    try {
      const dimensions = pngDimensions(png);
      if (dimensions.width !== page.width || dimensions.height !== page.height)
        reasons.push("png_geometry_mismatch");
    } catch {
      reasons.push("invalid_png");
    }
  }
  return reasons;
}

function isHomepage(page: CapturedPage) {
  return new URL(sourceUrl(page)).pathname === "/";
}

function domainGroup(page: CapturedPage) {
  const hostname = new URL(sourceUrl(page)).hostname;
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

function captureDiagnostics(candidates: Candidate[]) {
  const countTags = (predicate: (node: CapturedNode) => boolean) =>
    candidates.filter((candidate) => candidate.page.nodes.some(predicate)).length;
  return {
    candidatePages: candidates.length,
    distinctDomainGroups: new Set(candidates.map((candidate) => candidate.domainGroup)).size,
    pagesWithMediaNodes: countTags((node) => mediaTags.has(node.tag.toLowerCase())),
    pagesWithTables: countTags((node) => node.tag.toLowerCase() === "table"),
    pagesWithArticleOrMain: countTags((node) =>
      ["article", "main"].includes(node.tag.toLowerCase()),
    ),
    pagesWithLongVisibleText: countTags((node) => node.text.trim().length >= 160),
  };
}

function canSelect(candidate: Candidate, familyCounts: Map<string, number>, homepageCount: number) {
  if (isHomepage(candidate.page) && homepageCount >= HOMEPAGE_CAP) return false;
  return (familyCounts.get(candidate.source.familyHint) ?? 0) < FAMILY_HINT_CAP;
}

/** Pure deterministic selection, used by the CLI and synthetic tests. */
export function selectCaptures(candidates: Candidate[], target = FINAL_CORPUS_SIZE): Selection {
  if (!Number.isInteger(target) || target < 1 || target > FINAL_CORPUS_SIZE)
    throw new Error(`target must be an integer between 1 and ${FINAL_CORPUS_SIZE}`);
  const heldOut: HeldOut[] = [];
  const ordered = [...candidates].sort(
    (left, right) =>
      left.source.sourceBucket.localeCompare(right.source.sourceBucket) ||
      left.domainGroup.localeCompare(right.domainGroup) ||
      sourceUrl(left.page).localeCompare(sourceUrl(right.page)),
  );
  const kept: Candidate[] = [];
  const exactBodies = new Set<string>();
  const exactUrls = new Set<string>();
  const nearDuplicates: Selection["nearDuplicates"] = [];
  for (const candidate of ordered) {
    const url = sourceUrl(candidate.page);
    if (exactUrls.has(url)) {
      heldOut.push({
        pageId: candidate.page.id,
        sourceUrl: url,
        reasons: ["exact_source_url_duplicate"],
      });
      continue;
    }
    if (exactBodies.has(candidate.page.contentHash)) {
      heldOut.push({
        pageId: candidate.page.id,
        sourceUrl: sourceUrl(candidate.page),
        reasons: ["exact_body_duplicate"],
      });
      continue;
    }
    const near = kept.find(
      (prior) => similarity(prior.templateFeatures, candidate.templateFeatures) >= 0.92,
    );
    if (near) {
      nearDuplicates.push({
        keptPageId: near.page.id,
        heldOutPageId: candidate.page.id,
        similarity: similarity(near.templateFeatures, candidate.templateFeatures),
      });
    }
    exactBodies.add(candidate.page.contentHash);
    exactUrls.add(url);
    kept.push(candidate);
  }

  const selected: Candidate[] = [];
  const familyCounts = new Map<string, number>();
  let homepageCount = 0;
  const remaining = [...kept];
  // Round-robin domains first, then fill deterministically. This increases
  // observed domain coverage without inventing page-type labels from URL hints.
  while (selected.length < target && remaining.length) {
    const usedDomains = new Set<string>();
    let added = false;
    for (let index = 0; index < remaining.length && selected.length < target;) {
      const candidate = remaining[index]!;
      if (
        usedDomains.has(candidate.domainGroup) ||
        !canSelect(candidate, familyCounts, homepageCount)
      ) {
        index += 1;
        continue;
      }
      selected.push(candidate);
      remaining.splice(index, 1);
      usedDomains.add(candidate.domainGroup);
      familyCounts.set(
        candidate.source.familyHint,
        (familyCounts.get(candidate.source.familyHint) ?? 0) + 1,
      );
      if (isHomepage(candidate.page)) homepageCount += 1;
      added = true;
    }
    if (!added) break;
  }
  for (const candidate of remaining)
    heldOut.push({
      pageId: candidate.page.id,
      sourceUrl: sourceUrl(candidate.page),
      reasons: ["selection_cap_or_target"],
    });

  const diagnostics = {
    ...captureDiagnostics(selected),
    selectedPages: selected.length,
    selectedDomainGroups: new Set(selected.map((candidate) => candidate.domainGroup)).size,
    sourceBuckets: Object.fromEntries(
      [...new Set(selected.map((candidate) => candidate.source.sourceBucket))]
        .sort()
        .map((bucket) => [
          bucket,
          selected.filter((candidate) => candidate.source.sourceBucket === bucket).length,
        ]),
    ),
    familyHints: Object.fromEntries([...familyCounts.entries()].sort()),
    homepageCount,
    note: "familyHint is provisional sampling metadata, not a DOM, Jev, Luna, or human label.",
  };
  return {
    selected: selected.map((candidate) => ({
      ...candidate,
      path: `captures/${candidate.page.id}.json`,
    })),
    heldOut,
    nearDuplicates,
    diagnostics,
  };
}

function readInventory(paths: string[]) {
  const inventory = new Map<string, SourceMetadata>();
  for (const path of paths) {
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`Invalid inventory JSON at ${path}:${index + 1}`);
      }
      const rawUrl = typeof row.url === "string" ? row.url : row.sourceUrl;
      const sourceBucket = row.sourceBucket;
      const sourceSeed = typeof row.sourceSeed === "string" ? row.sourceSeed : row.seedUrl;
      const familyHint = row.familyHint;
      const cohort =
        typeof sourceBucket === "string" && /^(?:cloud|cloud-runs)$/i.test(sourceBucket)
          ? "cloud"
          : typeof sourceBucket === "string" && /^(?:ph|product-hunt)$/i.test(sourceBucket)
            ? "PH"
            : typeof sourceBucket === "string" && /^public$/i.test(sourceBucket)
              ? "public"
              : null;
      if (
        typeof rawUrl !== "string" ||
        !cohort ||
        typeof sourceSeed !== "string" ||
        typeof familyHint !== "string" ||
        !sourceSeed ||
        !familyHint
      )
        throw new Error(`Invalid source metadata at ${path}:${index + 1}`);
      const key = normalizedUrl(rawUrl);
      const value: SourceMetadata = {
        sourceBucket: cohort,
        sourceSeed,
        familyHint,
      };
      const previous = inventory.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value))
        throw new Error(`Conflicting source metadata for ${key}`);
      inventory.set(key, value);
    }
  }
  return inventory;
}

function stageCandidates(stagePath: string, inventory: Map<string, SourceMetadata>) {
  const store = new LabelStore(stagePath);
  const candidates: Candidate[] = [];
  const heldOut: HeldOut[] = [];
  for (const summary of store.listPages()) {
    let page: CapturedPage;
    try {
      page = store.readPage(summary.id);
      const key = sourceUrl(page);
      const reasons = qualityReasons(page, readFileSync(store.screenshotPath(page.id)));
      const source = inventory.get(key);
      if (!source) reasons.push("missing_source_metadata");
      if (reasons.length) {
        heldOut.push({ pageId: page.id, sourceUrl: key, reasons });
        continue;
      }
      const features = templateFeatures(page);
      candidates.push({
        page,
        stage: stagePath,
        source: source!,
        domainGroup: domainGroup(page),
        templateFingerprint: fingerprint(features),
        templateFeatures: features,
      });
    } catch {
      heldOut.push({ pageId: summary.id, sourceUrl: null, reasons: ["unreadable_capture_pair"] });
    }
  }
  return { candidates, heldOut };
}

function parseArguments(argv: string[]) {
  const stages: string[] = [],
    inventories: string[] = [];
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index],
      value = argv[index + 1];
    if (!flag || !value || !["--stage", "--inventory", "--output"].includes(flag))
      throw new Error(
        "Usage: bun quality.ts --stage /private/stage [--stage /private/stage] --inventory /private/sources.jsonl [--inventory /private/sources.jsonl] --output /private/final-corpus",
      );
    if (flag === "--stage") stages.push(resolve(value));
    else if (flag === "--inventory") inventories.push(resolve(value));
    else if (output) throw new Error("--output must appear once");
    else output = resolve(value);
  }
  if (!stages.length || !inventories.length || !output)
    throw new Error("stage, inventory, and output are required");
  if (new Set(stages).size !== stages.length) throw new Error("duplicate stage");
  return { stages, inventories, output };
}

export function assemble(stages: string[], inventories: string[], output: string) {
  if (existsSync(output))
    throw new Error("output directory already exists; assembly never overwrites a corpus");
  const metadata = readInventory(inventories);
  const gathered = stages.map((stage) => stageCandidates(stage, metadata));
  const selection = selectCaptures(gathered.flatMap((item) => item.candidates));
  selection.heldOut.unshift(...gathered.flatMap((item) => item.heldOut));
  mkdirSync(join(output, "captures"), { recursive: true, mode: 0o700 });
  for (const item of selection.selected) {
    const sourceStore = new LabelStore(item.stage);
    copyFileSync(sourceStore.capturePath(item.page.id), join(output, item.path), 0);
    copyFileSync(
      sourceStore.screenshotPath(item.page.id),
      join(output, `captures/${item.page.id}.png`),
      0,
    );
  }
  const manifest = selection.selected.map((item) => ({
    pageId: item.page.id,
    path: item.path,
    sourceBucket: item.source.sourceBucket,
    sourceSeed: item.source.sourceSeed,
    sourceUrl: sourceUrl(item.page),
    captureHash: item.page.captureHash,
    capturedAt: item.page.capturedAt,
    domainGroup: item.domainGroup,
    familyHint: item.source.familyHint,
  }));
  writeFileSync(
    join(output, "manifest.jsonl"),
    `${manifest.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  const report = {
    complete: selection.selected.length >= FINAL_CORPUS_SIZE,
    status: selection.selected.length >= FINAL_CORPUS_SIZE ? "complete" : "provisional",
    requested: FINAL_CORPUS_SIZE,
    shortfall: Math.max(0, FINAL_CORPUS_SIZE - selection.selected.length),
    ...selection.diagnostics,
    heldOut: selection.heldOut,
    nearDuplicates: selection.nearDuplicates,
  };
  writeFileSync(join(output, "quality-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return report;
}

if (import.meta.main) {
  try {
    const { stages, inventories, output } = parseArguments(process.argv.slice(2));
    console.log(JSON.stringify(assemble(stages, inventories, output)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "quality assembly failed");
    process.exitCode = 1;
  }
}
