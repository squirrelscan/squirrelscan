import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LabelStore } from "../labeler/store.ts";
import type {
  Annotation,
  CapturedPage,
  ModelSuggestion,
  PageAnnotation,
} from "../labeler/types.ts";

const JOURNALS = [
  "annotations.jsonl",
  "page-annotations.jsonl",
  "model-suggestions.jsonl",
  "model-reviews.jsonl",
  "review-undos.jsonl",
] as const;

export type ExportOptions = {
  inputDir: string;
  outputDir: string;
  groupingInput?: string;
};

type Grouping = { groupId: string; source: "tldts" | "documented_input" };
type Exclusion = { kind: "node" | "page"; annotationId: string; reasons: string[] };

/**
 * Creates an immutable, private training snapshot. The source label store is only
 * read; the output must be a new directory outside this checkout.
 */
export async function exportReviewedLabels(options: ExportOptions) {
  const inputDir = realpathSync(options.inputDir);
  const outputDir = resolve(options.outputDir);
  rejectUnsafeOutput(inputDir, outputDir);
  mkdirSync(dirname(outputDir), { recursive: true, mode: 0o700 });
  mkdirSync(outputDir, { mode: 0o700 });
  mkdirSync(join(outputDir, "audit", "captures"), { recursive: true, mode: 0o700 });
  const sourceStore = new LabelStore(inputDir);
  const sourceCaptureNames = existsSync(sourceStore.capturesDir)
    ? readdirSync(sourceStore.capturesDir).filter((name) => /^page_[a-f0-9]{24}\.json$/.test(name))
    : [];
  for (const file of JOURNALS)
    copySnapshotFile(join(inputDir, file), join(outputDir, "audit", file));
  for (const name of sourceCaptureNames)
    copySnapshotFile(
      join(sourceStore.capturesDir, name),
      join(outputDir, "audit", "captures", name),
    );
  assertSourceUnchanged(inputDir, sourceCaptureNames, outputDir);
  const groups = await resolveGroups(options.groupingInput);
  const store = new LabelStore(join(outputDir, "audit"));
  const pages = loadPages(store);
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const suggestions = new Map(
    store.readModelSuggestions().map((suggestion) => [suggestion.id, suggestion]),
  );
  const exclusions: Exclusion[] = [];
  const annotations = store.readAnnotations();
  const pageAnnotations = store.readPageAnnotations();
  // Undo records are copied verbatim into audit/. Remove undone actions before
  // resolving the append-only chain, matching the live backend: undoing a
  // revision restores its predecessor; undoing the sole action leaves none.
  const undone = readUndoKeys(join(outputDir, "audit", "review-undos.jsonl"));
  const activeAnnotations = annotations.filter(
    (item) => !undone.has(`annotation\u0000${item.id}`),
  );
  const activePageAnnotations = pageAnnotations.filter(
    (item) => !undone.has(`page_annotation\u0000${item.id}`),
  );
  const duplicateIds = duplicateIdsIn([...annotations, ...pageAnnotations]);
  const nodeExamples = latestBy(
    activeAnnotations,
    (annotation) => `${annotation.pageId}\u0000${annotation.nodeId}`,
    duplicateIds,
  ).flatMap(({ item, malformed }) =>
    nodeExample(item, pageById, suggestions, groups, exclusions, malformed),
  );
  const pageExamples = latestBy(
    activePageAnnotations,
    (annotation) => annotation.pageId,
    duplicateIds,
  ).flatMap(({ item, malformed }) =>
    pageExample(item, pageById, suggestions, groups, exclusions, malformed),
  );

  const captureEntries = pages.map((page) => {
    const source = store.capturePath(page.id);
    return {
      pageId: page.id,
      captureHash: page.captureHash,
      contentHash: page.contentHash,
      sourceSha256: sha256File(source),
    };
  });
  writeJsonl(join(outputDir, "node-examples.jsonl"), nodeExamples);
  writeJsonl(join(outputDir, "page-examples.jsonl"), pageExamples);
  writeJsonl(join(outputDir, "excluded.jsonl"), exclusions);
  const auditFiles = [
    ...JOURNALS.filter((file) => existsSync(join(outputDir, "audit", file))).map((file) => ({
      path: `audit/${file}`,
      sha256: sha256File(join(outputDir, "audit", file)),
    })),
    ...captureEntries.map((entry) => ({
      path: `audit/captures/${entry.pageId}.json`,
      sha256: entry.sourceSha256,
    })),
  ];
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    supervision: {
      contract: "positive_only",
      statement:
        "Each listed axis contains only explicit positive human observations. Omitted axes are unobserved and must never be interpreted as negative.",
      trainingRequirement:
        "Do not train ordinary BCE with absent classes as zero. Future training needs label-level reviewed-completeness or negative-confirmation data, or a positive-unlabeled method.",
      source: "human",
      gold: false,
      teacherPolicy:
        "Model suggestions are retained solely as teacher provenance and never create examples or gold labels.",
    },
    grouping: groups.source,
    input: { path: inputDir, auditFiles },
    counts: {
      captures: pages.length,
      nodeExamples: nodeExamples.length,
      pageExamples: pageExamples.length,
      exclusions: countReasons(exclusions),
    },
    captureEntries,
  };
  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return manifest;
}

function copySnapshotFile(source: string, target: string) {
  if (!existsSync(source)) return;
  copyFileSync(source, target);
  chmodSync(target, 0o600);
}

function assertSourceUnchanged(inputDir: string, captureNames: string[], outputDir: string) {
  const sourceStore = new LabelStore(inputDir);
  const currentNames = existsSync(sourceStore.capturesDir)
    ? readdirSync(sourceStore.capturesDir).filter((name) => /^page_[a-f0-9]{24}\.json$/.test(name))
    : [];
  if (currentNames.join("\u0000") !== captureNames.join("\u0000"))
    throw new Error("Label store changed during snapshot; retry export");
  for (const file of JOURNALS) {
    const source = join(inputDir, file);
    const copied = join(outputDir, "audit", file);
    if (
      existsSync(source) !== existsSync(copied) ||
      (existsSync(source) && sha256File(source) !== sha256File(copied))
    )
      throw new Error("Label store changed during snapshot; retry export");
  }
  for (const name of captureNames) {
    const source = join(sourceStore.capturesDir, name);
    const copied = join(outputDir, "audit", "captures", name);
    if (sha256File(source) !== sha256File(copied))
      throw new Error("Label store changed during snapshot; retry export");
  }
}

function loadPages(store: LabelStore) {
  if (!existsSync(store.capturesDir)) return [] as CapturedPage[];
  return readdirSync(store.capturesDir)
    .filter((name) => /^page_[a-f0-9]{24}\.json$/.test(name))
    .map((name) => store.readPage(name.slice(0, -5)));
}

function nodeExample(
  annotation: Annotation,
  pageById: Map<string, CapturedPage>,
  suggestions: Map<string, ModelSuggestion>,
  groups: Map<string, Grouping>,
  exclusions: Exclusion[],
  malformedSupersession: boolean,
) {
  const page = pageById.get(annotation.pageId);
  const reasons = nodeReasons(annotation, page);
  if (malformedSupersession) reasons.push("malformed_supersession_chain");
  if (reasons.length) return exclude("node", annotation.id, reasons, exclusions);
  const node = page!.nodes.find((candidate) => candidate.id === annotation.nodeId)!;
  const labels: Record<string, unknown> = {};
  if (annotation.labelSchemaVersion === 2) {
    if (annotation.regions.length) labels.regions = annotation.regions;
    if (annotation.functions.length) labels.functions = annotation.functions;
  }
  if (annotation.componentSchemaVersion === 3) {
    if (annotation.componentType) labels.componentType = annotation.componentType;
    if (annotation.componentSubtype) labels.componentSubtype = annotation.componentSubtype;
    if (annotation.observedState.length) labels.observedState = annotation.observedState;
    if (annotation.purposes.length) labels.purposes = annotation.purposes;
  }
  if (!Object.keys(labels).length)
    return exclude("node", annotation.id, ["no_supported_explicit_axis"], exclusions);
  return [
    {
      kind: "node",
      annotationId: annotation.id,
      capture: captureProvenance(page!),
      nodeId: node.id,
      node: {
        tag: node.tag,
        role: node.role,
        selector: node.selector,
        rect: node.rect,
        depth: node.depth,
      },
      splitGroup: groupFor(page!, groups),
      labels,
      source: "human",
      gold: false,
      annotationTimestamp: annotation.timestamp,
      teacher: teacherProvenance(
        annotation.modelSuggestionId,
        annotation.modelReview,
        suggestions,
        annotation.pageId,
        annotation.nodeId,
        annotation.captureHash,
      ),
    },
  ];
}

function pageExample(
  annotation: PageAnnotation,
  pageById: Map<string, CapturedPage>,
  suggestions: Map<string, ModelSuggestion>,
  groups: Map<string, Grouping>,
  exclusions: Exclusion[],
  malformedSupersession: boolean,
) {
  const page = pageById.get(annotation.pageId);
  const reasons: string[] = [];
  if (!page || page.captureHash !== annotation.captureHash)
    reasons.push("stale_or_missing_capture");
  if (annotation.source !== "human") reasons.push("non_human_source");
  if (annotation.decision === "unsure") reasons.push("decision_unsure");
  if (malformedSupersession) reasons.push("malformed_supersession_chain");
  if (reasons.length) return exclude("page", annotation.id, reasons, exclusions);
  const labels: Record<string, unknown> = {};
  if (annotation.pageTypes.length) labels.pageTypes = annotation.pageTypes;
  if (annotation.contentKinds.length) labels.contentKinds = annotation.contentKinds;
  if (!Object.keys(labels).length)
    return exclude("page", annotation.id, ["no_supported_explicit_axis"], exclusions);
  return [
    {
      kind: "page",
      annotationId: annotation.id,
      capture: captureProvenance(page!),
      splitGroup: groupFor(page!, groups),
      labels,
      source: "human",
      gold: false,
      annotationTimestamp: annotation.timestamp,
      teacher: teacherProvenance(
        annotation.modelSuggestionId,
        annotation.modelReview,
        suggestions,
        annotation.pageId,
        null,
        annotation.captureHash,
      ),
    },
  ];
}

function nodeReasons(annotation: Annotation, page: CapturedPage | undefined) {
  const reasons: string[] = [];
  if (
    !page ||
    page.captureHash !== annotation.captureHash ||
    !page.nodes.some((node) => node.id === annotation.nodeId)
  )
    reasons.push("stale_or_missing_capture_or_node");
  if (annotation.source !== "human") reasons.push("non_human_source");
  if (annotation.decision === "reject" || annotation.decision === "unsure")
    reasons.push(`decision_${annotation.decision}`);
  if (annotation.boundary !== "correct") reasons.push(`boundary_${annotation.boundary}`);
  return reasons;
}

function captureProvenance(page: CapturedPage) {
  return {
    pageId: page.id,
    url: page.url,
    captureHash: page.captureHash,
    contentHash: page.contentHash,
    capturedAt: page.capturedAt,
  };
}

function teacherProvenance(
  id: string | null,
  review: string | null,
  suggestions: Map<string, ModelSuggestion>,
  pageId?: string,
  nodeId?: string | null,
  captureHash?: string,
) {
  if (!id) return null;
  const suggestion = suggestions.get(id);
  const validTarget =
    suggestion?.pageId === pageId &&
    suggestion?.nodeId === nodeId &&
    suggestion?.captureHash === captureHash;
  return {
    modelSuggestionId: id,
    modelReview: review,
    presentInAuditHistory: Boolean(validTarget),
    ...(validTarget
      ? {
          provider: suggestion!.provider,
          modelId: suggestion!.modelId,
          modelRevision: suggestion!.modelRevision,
          promptRevision: suggestion!.promptRevision,
          snapshotHash: suggestion!.snapshotHash,
        }
      : {}),
  };
}

function exclude(
  kind: Exclusion["kind"],
  annotationId: string,
  reasons: string[],
  exclusions: Exclusion[],
) {
  exclusions.push({ kind, annotationId, reasons });
  return [];
}

function duplicateIdsIn(items: Array<{ id: string }>) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function latestBy<T extends { id: string; supersedes: string | null }>(
  items: T[],
  key: (item: T) => string,
  duplicateIds: Set<string>,
) {
  const latest = new Map<string, { item: T; malformed: boolean }>();
  for (const item of items) {
    const group = key(item);
    const previous = latest.get(group);
    latest.set(group, {
      item,
      // Store journals are append-only chains. A missing or branching pointer
      // makes the effective label ambiguous, so it is excluded rather than guessed.
      malformed:
        (previous?.malformed ?? false) ||
        duplicateIds.has(item.id) ||
        item.supersedes !== (previous?.item.id ?? null),
    });
  }
  return [...latest.values()];
}

function countReasons(exclusions: Exclusion[]) {
  const counts: Record<string, number> = {};
  for (const exclusion of exclusions)
    for (const reason of exclusion.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

function writeJsonl(path: string, rows: unknown[]) {
  writeFileSync(
    path,
    rows.map((row) => JSON.stringify(row)).join(rows.length ? "\n" : "") +
      (rows.length ? "\n" : ""),
    { mode: 0o600 },
  );
}

function readUndoKeys(path: string) {
  if (!existsSync(path)) return new Set<string>();
  const keys = new Set<string>();
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid review undo JSON at ${path}:${index + 1}`);
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("actionKind" in value) ||
      !("actionId" in value) ||
      typeof value.actionKind !== "string" ||
      typeof value.actionId !== "string"
    )
      throw new Error(`Invalid review undo record at ${path}:${index + 1}`);
    keys.add(`${value.actionKind}\u0000${value.actionId}`);
  }
  return keys;
}

function sha256File(path: string) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function rejectUnsafeOutput(inputDir: string, outputDir: string) {
  if (!isAbsolute(outputDir)) throw new Error("Output must be an absolute private path");
  const canonicalOutput = canonicalize(outputDir);
  const repositoryRoot = realpathSync(
    resolve(dirname(new URL(import.meta.url).pathname), "../../.."),
  );
  if (isWithin(repositoryRoot, canonicalOutput))
    throw new Error("Output must be outside the repository so real exports cannot enter Git");
  if (isWithin(inputDir, canonicalOutput) || isWithin(canonicalOutput, inputDir))
    throw new Error("Output must be separate from the active label store");
  if (existsSync(outputDir))
    throw new Error("Output directory already exists; snapshots are immutable");
}

function canonicalize(path: string) {
  const tail: string[] = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    tail.unshift(cursor.slice(cursor.lastIndexOf("/") + 1));
    cursor = dirname(cursor);
  }
  return join(realpathSync(cursor), ...tail);
}

function isWithin(parent: string, child: string) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function resolveGroups(groupingInput?: string) {
  if (groupingInput) return documentedGroups(groupingInput);
  try {
    const load = Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<{
      getDomain: (url: string, options: { allowPrivateDomains: true }) => string | null;
    }>;
    const { getDomain } = await load("tldts");
    const groups = new Map<string, Grouping>();
    return Object.assign(groups, {
      source: "tldts" as const,
      domainFor: (url: string) => getDomain(url, { allowPrivateDomains: true }),
    });
  } catch {
    throw new Error(
      "tldts is unavailable; provide --grouping-input with documented pageId/url group IDs to prevent unsafe domain splits",
    );
  }
}

function documentedGroups(path: string) {
  const rows = JSON.parse(readFileSync(path, "utf8")) as Array<{
    pageId?: string;
    url?: string;
    groupId: string;
  }>;
  const groups = new Map<string, Grouping>();
  for (const row of rows) {
    if ((!row.pageId && !row.url) || typeof row.groupId !== "string" || !row.groupId)
      throw new Error("Invalid grouping input row");
    for (const key of [row.pageId && `page:${row.pageId}`, row.url && `url:${row.url}`].filter(
      Boolean,
    ) as string[]) {
      const existing = groups.get(key);
      if (existing && existing.groupId !== row.groupId)
        throw new Error(`Conflicting documented split group for ${key}`);
      groups.set(key, { groupId: row.groupId, source: "documented_input" });
    }
  }
  return Object.assign(groups, { source: "documented_input" as const });
}

function groupFor(
  page: CapturedPage,
  groups: Map<string, Grouping> & { source?: string; domainFor?: (url: string) => string | null },
) {
  if (groups.source === "tldts") {
    const domain = groups.domainFor!(page.url);
    if (!domain) throw new Error(`Cannot derive eTLD+1 for ${page.id}; provide --grouping-input`);
    return { groupId: domain, source: "tldts" };
  }
  const group = groups.get(`page:${page.id}`) ?? groups.get(`url:${page.url}`);
  const byPage = groups.get(`page:${page.id}`);
  const byUrl = groups.get(`url:${page.url}`);
  if (byPage && byUrl && byPage.groupId !== byUrl.groupId)
    throw new Error(`Conflicting documented split groups for ${page.id}`);
  if (!group) throw new Error(`Missing documented split group for ${page.id}`);
  return group;
}
