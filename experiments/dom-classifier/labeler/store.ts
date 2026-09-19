import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  COMPONENT_SUBTYPES,
  COMPONENT_TYPES,
  CONTEXTS,
  FUNCTIONS,
  OBSERVED_STATES,
  CONTENT_KINDS,
  PAGE_TYPES,
  PURPOSES,
  REGIONS,
  ROLES,
  STATEFUL_COMPONENT_TYPES,
  TAXONOMY_REVISION,
  COHORT_ID_PATTERN,
  PRIMARY_COHORT_ID,
  type Annotation,
  type CohortSource,
  type AnnotationInput,
  type CapturedPage,
  type ContentKind,
  type ComponentType,
  type FunctionLabel,
  type ModelReview,
  type ModelReviewInput,
  type ModelReviewRecord,
  type ModelSuggestion,
  type LabelerStats,
  type ObservedState,
  type Purpose,
  type PageAnnotation,
  type PageAnnotationInput,
  type PageType,
  type Region,
  type Role,
  type ReviewActionKind,
  type ReviewUndoRecord,
} from "./types.ts";

const annotationFile = "annotations.jsonl";
const pageAnnotationFile = "page-annotations.jsonl";
const modelSuggestionFile = "model-suggestions.jsonl";
const modelReviewFile = "model-reviews.jsonl";
const reviewUndoFile = "review-undos.jsonl";
const captureIdPattern = /^page_[a-f0-9]{24}$/;

export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class LabelStore {
  readonly capturesDir: string;
  readonly annotationsPath: string;
  readonly pageAnnotationsPath: string;
  /** Immutable offline predictions; the labeler never writes this sidecar. */
  readonly modelSuggestionsPath: string;
  readonly modelReviewsPath: string;
  readonly reviewUndosPath: string;
  readonly captureAttemptsPath: string;
  private readonly lockPath: string;

  /** Extra read-only capture sets mounted beside the primary one. */
  readonly cohorts: readonly CohortSource[];

  constructor(readonly dataDir: string, cohorts: readonly CohortSource[] = []) {
    for (const cohort of cohorts)
      if (!COHORT_ID_PATTERN.test(cohort.id) || cohort.id === PRIMARY_COHORT_ID)
        throw new StoreError(400, `Invalid cohort id: ${cohort.id}`);
    if (new Set(cohorts.map((cohort) => cohort.id)).size !== cohorts.length)
      throw new StoreError(400, "Duplicate cohort id");
    this.cohorts = cohorts;
    this.capturesDir = join(dataDir, "captures");
    this.annotationsPath = join(dataDir, annotationFile);
    this.pageAnnotationsPath = join(dataDir, pageAnnotationFile);
    this.modelSuggestionsPath = join(dataDir, modelSuggestionFile);
    this.modelReviewsPath = join(dataDir, modelReviewFile);
    this.reviewUndosPath = join(dataDir, reviewUndoFile);
    this.captureAttemptsPath = join(dataDir, "capture-attempts.jsonl");
    this.lockPath = join(dataDir, ".annotations.lock");
  }

  ensureDirectories() {
    mkdirSync(this.capturesDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
  }

  /** Primary first, then each mounted cohort, in mount order. */
  private captureSources(): Array<{ id: string; dir: string }> {
    return [
      { id: PRIMARY_COHORT_ID, dir: this.capturesDir },
      ...this.cohorts.map((cohort) => ({ id: cohort.id, dir: join(cohort.dir, "captures") })),
    ];
  }

  /**
   * Which mounted set holds this capture. Primary wins a collision, so mounting
   * a cohort can never shadow an existing capture or its labels.
   */
  cohortIdForPage(id: string): string {
    if (!captureIdPattern.test(id)) throw new StoreError(404, "Unknown capture");
    for (const source of this.captureSources())
      if (existsSync(join(source.dir, `${id}.json`))) return source.id;
    return PRIMARY_COHORT_ID;
  }

  private resolveCapture(id: string, extension: ".json" | ".png") {
    if (!captureIdPattern.test(id)) throw new StoreError(404, "Unknown capture");
    for (const source of this.captureSources()) {
      const candidate = join(source.dir, `${id}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
    // Fall back to the primary path so writes and "not found" errors are unchanged.
    return join(this.capturesDir, `${id}${extension}`);
  }

  capturePath(id: string) {
    return this.resolveCapture(id, ".json");
  }

  screenshotPath(id: string) {
    return this.resolveCapture(id, ".png");
  }

  writeCapture(page: CapturedPage, png: Uint8Array) {
    this.ensureDirectories();
    if (!captureIdPattern.test(page.id)) throw new StoreError(404, "Unknown capture");
    // Always write to the primary set: a mounted cohort is read-only.
    const imagePath = join(this.capturesDir, `${page.id}.png`);
    const manifestPath = join(this.capturesDir, `${page.id}.json`);
    // Resolving across sources makes a cohort collision a conflict, not a silent
    // shadow of an existing capture.
    if (existsSync(this.screenshotPath(page.id)) || existsSync(this.capturePath(page.id)))
      throw new StoreError(409, "Capture already exists");
    this.atomicWrite(imagePath, png);
    try {
      this.atomicWrite(manifestPath, JSON.stringify(page));
    } catch (error) {
      rmSync(imagePath, { force: true });
      throw error;
    }
  }

  /** Every capture id across the primary set and each mounted cohort, deduped. */
  private allCaptureIds(): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const source of this.captureSources()) {
      if (!existsSync(source.dir)) continue;
      for (const name of readdirSync(source.dir)) {
        if (!/^page_[a-f0-9]{24}\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }

  listPages() {
    if (this.captureSources().every((source) => !existsSync(source.dir))) return [];
    const annotations = this.effectiveAnnotations();
    const pageAnnotations = this.effectivePageAnnotations();
    const reviewed = new Map<string, Set<string>>();
    for (const annotation of annotations) {
      const nodeIds = reviewed.get(annotation.pageId) ?? new Set<string>();
      nodeIds.add(annotation.nodeId);
      reviewed.set(annotation.pageId, nodeIds);
    }
    const pageReviewed = new Map<string, number>();
    for (const annotation of pageAnnotations)
      pageReviewed.set(annotation.pageId, (pageReviewed.get(annotation.pageId) ?? 0) + 1);
    return this.allCaptureIds()
      .map((id) => this.readPage(id))
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .map((page) => ({
        id: page.id,
        title: page.title,
        url: page.url,
        capturedAt: page.capturedAt,
        width: page.width,
        height: page.height,
        screenshotUrl: page.screenshotUrl,
        reviewedCount: reviewed.get(page.id)?.size ?? 0,
        pageReviewedCount: pageReviewed.get(page.id) ?? 0,
      }));
  }

  /** Computes current-capture progress directly from immutable captures and append-only journals. */
  stats(): LabelerStats {
    if (this.captureSources().every((source) => !existsSync(source.dir))) return emptyStats();
    const pages = this.allCaptureIds().flatMap((id) => {
      try {
        return [this.readPage(id)];
      } catch {
        return [];
      }
    });
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const currentNodeKeys = new Set(
      pages.flatMap((page) => page.nodes.map((node) => `${page.id}\u0000${node.id}`)),
    );
    const currentAnnotations = this.effectiveAnnotations().filter(
      (annotation) =>
        pageById.get(annotation.pageId)?.captureHash === annotation.captureHash &&
        currentNodeKeys.has(`${annotation.pageId}\u0000${annotation.nodeId}`),
    );
    const latestNodeAnnotation = latestBy(
      currentAnnotations,
      (annotation) => `${annotation.pageId}\u0000${annotation.nodeId}`,
    );
    const currentPageAnnotations = this.effectivePageAnnotations().filter(
      (annotation) => pageById.get(annotation.pageId)?.captureHash === annotation.captureHash,
    );
    const latestPageAnnotation = latestBy(
      currentPageAnnotations,
      (annotation) => annotation.pageId,
    );
    const positiveNodes = [...latestNodeAnnotation.values()].filter(
      (annotation) => annotation.decision === "label" || annotation.decision === "accept",
    );
    const labelledPages = new Set(positiveNodes.map((annotation) => annotation.pageId));
    const positivePageLabels = [...latestPageAnnotation.values()].filter(
      (annotation) => annotation.decision === "label",
    );
    for (const annotation of positivePageLabels) labelledPages.add(annotation.pageId);

    const latestSuggestionByTarget = new Map<string, ModelSuggestion>();
    for (const suggestion of this.readModelSuggestions()) {
      const page = pageById.get(suggestion.pageId);
      if (
        page?.captureHash !== suggestion.captureHash ||
        (suggestion.nodeId !== null &&
          !currentNodeKeys.has(`${suggestion.pageId}\u0000${suggestion.nodeId}`))
      )
        continue;
      latestSuggestionByTarget.set(
        `${suggestion.pageId}\u0000${suggestion.nodeId ?? "page"}\u0000${suggestion.captureHash}`,
        suggestion,
      );
    }
    // The sidecar is append-only. Queue/stats describe only the latest model
    // decision for each current target; exports retain every historical row.
    const suggestionsById = new Map(
      [...latestSuggestionByTarget.values()].map((suggestion) => [suggestion.id, suggestion]),
    );
    const reviews = new Map<string, { review: ModelReview; timestamp: number; order: number }>();
    let order = 0;
    const considerReview = (
      suggestionId: string | null,
      review: ModelReview | null,
      timestamp: string,
    ) => {
      order += 1;
      if (!suggestionId || !review || !suggestionsById.has(suggestionId)) return;
      const candidate = { review, timestamp: Date.parse(timestamp) || 0, order };
      const existing = reviews.get(suggestionId);
      if (
        !existing ||
        candidate.timestamp > existing.timestamp ||
        (candidate.timestamp === existing.timestamp && candidate.order > existing.order)
      )
        reviews.set(suggestionId, candidate);
    };
    for (const annotation of currentAnnotations)
      considerReview(annotation.modelSuggestionId, annotation.modelReview, annotation.timestamp);
    for (const annotation of currentPageAnnotations)
      considerReview(annotation.modelSuggestionId, annotation.modelReview, annotation.timestamp);
    for (const review of this.effectiveModelReviews()) {
      const suggestion = suggestionsById.get(review.modelSuggestionId);
      if (
        suggestion &&
        suggestion.pageId === review.pageId &&
        suggestion.nodeId === review.nodeId &&
        suggestion.captureHash === review.captureHash
      )
        considerReview(review.modelSuggestionId, review.review, review.timestamp);
    }
    const reviewed = { accepted: 0, corrected: 0, rejected: 0 };
    for (const review of reviews.values()) {
      if (review.review === "accept") reviewed.accepted += 1;
      else if (review.review === "correct") reviewed.corrected += 1;
      else reviewed.rejected += 1;
    }
    const suggestions = [...suggestionsById.values()];
    const humanReviewedTargets = new Set([
      ...latestNodeAnnotation.keys(),
      ...latestPageAnnotation.keys().map((pageId) => `${pageId}\u0000page`),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      pages: {
        total: pages.length,
        labelled: labelledPages.size,
        currentPageLabels: positivePageLabels.length,
      },
      elements: {
        total: currentNodeKeys.size,
        currentHumanLabels: positiveNodes.length,
        latestManualLabels: positiveNodes.filter(
          (annotation) => annotation.decision === "label" && annotation.modelSuggestionId === null,
        ).length,
      },
      suggestions: {
        total: suggestions.length,
        page: suggestions.filter((suggestion) => suggestion.nodeId === null).length,
        element: suggestions.filter((suggestion) => suggestion.nodeId !== null).length,
        pending: suggestions.filter(
          (suggestion) =>
            !reviews.has(suggestion.id) &&
            !humanReviewedTargets.has(`${suggestion.pageId}\u0000${suggestion.nodeId ?? "page"}`),
        ).length,
        reviewed,
      },
      byCohort: this.cohortBreakdown(
        pages,
        positiveNodes,
        labelledPages,
        this.sourceDecisions(pageById, currentNodeKeys, latestNodeAnnotation),
      ),
    };
  }

  /**
   * Which annotator a human sided with, per decision.
   *
   * Deliberately built from EVERY current suggestion rather than
   * `latestSuggestionByTarget`: a disagreement node carries one suggestion per
   * annotator, and keeping only the latest would hide the one that lost.
   */
  private sourceDecisions(
    pageById: Map<string, CapturedPage>,
    currentNodeKeys: Set<string>,
    latestNodeAnnotation: Map<string, Annotation>,
  ): Array<{ pageId: string; modelId: string; decision: "accepted" | "rejected" }> {
    const current = new Map<string, ModelSuggestion>();
    for (const suggestion of this.readModelSuggestions()) {
      if (pageById.get(suggestion.pageId)?.captureHash !== suggestion.captureHash) continue;
      if (
        suggestion.nodeId !== null &&
        !currentNodeKeys.has(`${suggestion.pageId}\u0000${suggestion.nodeId}`)
      )
        continue;
      current.set(suggestion.id, suggestion);
    }
    const decisions: Array<{ pageId: string; modelId: string; decision: "accepted" | "rejected" }> = [];
    for (const annotation of latestNodeAnnotation.values()) {
      const suggestion = annotation.modelSuggestionId
        ? current.get(annotation.modelSuggestionId)
        : undefined;
      if (!suggestion || annotation.modelReview !== "accept") continue;
      decisions.push({ pageId: suggestion.pageId, modelId: suggestion.modelId, decision: "accepted" });
    }
    for (const review of this.effectiveModelReviews()) {
      const suggestion = current.get(review.modelSuggestionId);
      if (!suggestion || suggestion.pageId !== review.pageId || suggestion.nodeId !== review.nodeId)
        continue;
      decisions.push({ pageId: suggestion.pageId, modelId: suggestion.modelId, decision: "rejected" });
    }
    return decisions;
  }

  /**
   * Counts per mounted cohort. A page's cohort comes from which set holds its
   * capture, so a label written before cohorts existed lands under the primary
   * id without any row being rewritten.
   */
  private cohortBreakdown(
    pages: CapturedPage[],
    positiveNodes: Annotation[],
    labelledPages: Set<string>,
    sourceDecisions: Array<{ pageId: string; modelId: string; decision: "accepted" | "rejected" }> = [],
  ): LabelerStats["byCohort"] {
    const empty = () => ({ pages: 0, labelledPages: 0, currentHumanLabels: 0, bySource: {} });
    const breakdown: LabelerStats["byCohort"] = { [PRIMARY_COHORT_ID]: empty() };
    for (const cohort of this.cohorts) breakdown[cohort.id] = empty();
    const cohortByPage = new Map(pages.map((page) => [page.id, this.cohortIdForPage(page.id)]));
    for (const page of pages) {
      const bucket = breakdown[cohortByPage.get(page.id) ?? PRIMARY_COHORT_ID];
      if (!bucket) continue;
      bucket.pages += 1;
      if (labelledPages.has(page.id)) bucket.labelledPages += 1;
    }
    for (const annotation of positiveNodes) {
      const bucket = breakdown[cohortByPage.get(annotation.pageId) ?? PRIMARY_COHORT_ID];
      if (bucket) bucket.currentHumanLabels += 1;
    }
    for (const entry of sourceDecisions) {
      const bucket = breakdown[cohortByPage.get(entry.pageId) ?? PRIMARY_COHORT_ID];
      if (!bucket) continue;
      const source = (bucket.bySource[entry.modelId] ??= { accepted: 0, rejected: 0 });
      source[entry.decision] += 1;
    }
    return breakdown;
  }

  readPage(id: string): CapturedPage {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.capturePath(id), "utf8"));
    } catch {
      throw new StoreError(404, "Capture not found");
    }
    if (!isPage(value) || value.id !== id) throw new StoreError(500, "Invalid capture manifest");
    return value;
  }

  annotationsForPage(pageId: string) {
    return this.effectiveAnnotations().filter((annotation) => annotation.pageId === pageId);
  }

  pageAnnotationsForPage(pageId: string) {
    return this.effectivePageAnnotations().filter((annotation) => annotation.pageId === pageId);
  }

  /** Only predictions for this page's current immutable capture are exposed. */
  modelSuggestionsForPage(pageId: string) {
    const page = this.readPage(pageId);
    return this.readModelSuggestions().filter(
      (suggestion) => suggestion.pageId === pageId && suggestion.captureHash === page.captureHash,
    );
  }

  /**
   * The primary sidecar plus each cohort's own, in mount order. All of them are
   * read-only here; the labeler never writes a suggestion.
   */
  readModelSuggestions(): ModelSuggestion[] {
    const paths = [
      this.modelSuggestionsPath,
      ...this.cohorts.map((cohort) => join(cohort.dir, modelSuggestionFile)),
    ];
    return paths.flatMap((path) => {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const suggestion = normalizeModelSuggestion(JSON.parse(line));
            return suggestion ? [suggestion] : [];
          } catch {
            return [];
          }
        });
    });
  }

  modelReviewsForPage(pageId: string) {
    const page = this.readPage(pageId);
    return this.effectiveModelReviews().filter(
      (review) => review.pageId === pageId && review.captureHash === page.captureHash,
    );
  }

  readModelReviews(): ModelReviewRecord[] {
    if (!existsSync(this.modelReviewsPath)) return [];
    return readFileSync(this.modelReviewsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const review = normalizeModelReviewRecord(JSON.parse(line));
          return review ? [review] : [];
        } catch {
          return [];
        }
      });
  }

  readAnnotations(): Annotation[] {
    if (!existsSync(this.annotationsPath)) return [];
    return readFileSync(this.annotationsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const annotation = normalizeStoredAnnotation(JSON.parse(line));
          return annotation ? [annotation] : [];
        } catch {
          return [];
        }
      });
  }

  rawAnnotationsJsonl() {
    return existsSync(this.annotationsPath) ? readFileSync(this.annotationsPath, "utf8") : "";
  }

  rawPageAnnotationsJsonl() {
    return existsSync(this.pageAnnotationsPath)
      ? readFileSync(this.pageAnnotationsPath, "utf8")
      : "";
  }

  rawModelReviewsJsonl() {
    return existsSync(this.modelReviewsPath) ? readFileSync(this.modelReviewsPath, "utf8") : "";
  }

  rawReviewUndosJsonl() {
    return existsSync(this.reviewUndosPath) ? readFileSync(this.reviewUndosPath, "utf8") : "";
  }

  /** Current records omit append-only actions that have subsequently been undone. */
  effectiveAnnotations() {
    const undone = this.undoneActionKeys();
    return this.readAnnotations().filter(
      (annotation) => !undone.has(actionKey("annotation", annotation.id)),
    );
  }

  effectivePageAnnotations() {
    const undone = this.undoneActionKeys();
    return this.readPageAnnotations().filter(
      (annotation) => !undone.has(actionKey("page_annotation", annotation.id)),
    );
  }

  effectiveModelReviews() {
    const undone = this.undoneActionKeys();
    return this.readModelReviews().filter(
      (review) => !undone.has(actionKey("model_review", review.id)),
    );
  }

  effectiveAnnotationsJsonl() {
    const undone = this.undoneActionKeys();
    const lines = this.rawAnnotationsJsonl()
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        try {
          const value = JSON.parse(line) as { id?: unknown };
          return typeof value.id !== "string" || !undone.has(actionKey("annotation", value.id));
        } catch {
          return true;
        }
      });
    return lines.length ? `${lines.join("\n")}\n` : "";
  }

  undoReviewAction(input: {
    pageId: string;
    nodeId: string | null;
    captureHash: string;
    actionKind: ReviewActionKind;
    actionId: string;
  }) {
    const page = this.readPage(input.pageId);
    if (input.captureHash !== page.captureHash)
      throw new StoreError(409, "Capture is stale; reload the page");
    this.ensureDirectories();
    this.acquireLock();
    try {
      const existing = this.readReviewUndos().find(
        (undo) => undo.actionKind === input.actionKind && undo.actionId === input.actionId,
      );
      if (existing) {
        if (
          existing.pageId !== input.pageId ||
          existing.nodeId !== input.nodeId ||
          existing.captureHash !== input.captureHash
        )
          throw new StoreError(409, "Undo action does not match this capture target");
        return { undo: existing, created: false };
      }
      const action = this.findUndoableAction(input);
      if (!action) throw new StoreError(409, "Review action is not current for this target");
      const undo: ReviewUndoRecord = {
        id: `undo_${crypto.randomUUID()}`,
        actionKind: input.actionKind,
        actionId: input.actionId,
        pageId: input.pageId,
        nodeId: input.nodeId,
        captureHash: input.captureHash,
        timestamp: new Date().toISOString(),
      };
      appendFileSync(this.reviewUndosPath, `${JSON.stringify(undo)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return { undo, created: true };
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private findUndoableAction(input: {
    pageId: string;
    nodeId: string | null;
    captureHash: string;
    actionKind: ReviewActionKind;
    actionId: string;
  }) {
    if (input.actionKind === "annotation") {
      if (input.nodeId === null) return null;
      const current = this.effectiveAnnotations().filter(
        (annotation) =>
          annotation.pageId === input.pageId &&
          annotation.nodeId === input.nodeId &&
          annotation.captureHash === input.captureHash,
      );
      return current.at(-1)?.id === input.actionId ? current.at(-1) : null;
    }
    if (input.actionKind === "page_annotation") {
      if (input.nodeId !== null) return null;
      const current = this.effectivePageAnnotations().filter(
        (annotation) =>
          annotation.pageId === input.pageId && annotation.captureHash === input.captureHash,
      );
      return current.at(-1)?.id === input.actionId ? current.at(-1) : null;
    }
    const current = this.effectiveModelReviews().filter(
      (review) =>
        review.pageId === input.pageId &&
        review.nodeId === input.nodeId &&
        review.captureHash === input.captureHash,
    );
    return current.at(-1)?.id === input.actionId ? current.at(-1) : null;
  }

  private undoneActionKeys() {
    return new Set(this.readReviewUndos().map((undo) => actionKey(undo.actionKind, undo.actionId)));
  }

  readReviewUndos(): ReviewUndoRecord[] {
    if (!existsSync(this.reviewUndosPath)) return [];
    return readFileSync(this.reviewUndosPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const undo = normalizeReviewUndoRecord(JSON.parse(line));
          return undo ? [undo] : [];
        } catch {
          return [];
        }
      });
  }

  readPageAnnotations(): PageAnnotation[] {
    if (!existsSync(this.pageAnnotationsPath)) return [];
    return readFileSync(this.pageAnnotationsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const annotation = normalizePageAnnotation(JSON.parse(line));
          return annotation ? [annotation] : [];
        } catch {
          return [];
        }
      });
  }

  recordCaptureAttempt(url: string, status: "captured" | "failed", reason: string | null) {
    this.ensureDirectories();
    const attempt = {
      attemptedAt: new Date().toISOString(),
      url,
      status,
      reason: reason?.replace(/\s+/g, " ").slice(0, 240) ?? null,
    };
    appendFileSync(this.captureAttemptsPath, `${JSON.stringify(attempt)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  saveAnnotation(input: AnnotationInput): Annotation {
    const page = this.readPage(input.pageId);
    const node = page.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!node) throw new StoreError(400, "Node does not belong to capture");
    if (input.captureHash && input.captureHash !== page.captureHash)
      throw new StoreError(409, "Capture is stale; reload the page");
    const labels = labelsForInput(input);
    const component = componentForInput(input);
    if (
      input.decision === "label" &&
      labels.regions.length + labels.functions.length + component.purposes.length === 0 &&
      !component.componentType
    )
      throw new StoreError(
        400,
        "Label decisions need a region, function, purpose, or component type",
      );
    if (input.decision === "accept") {
      if (!node.suggestion) throw new StoreError(400, "Accept requires a current weak suggestion");
      if (input.role && input.role !== node.suggestion.role)
        throw new StoreError(400, "Accept must confirm this node's current weak suggestion");
      const suggestionLabels = labelsForLegacyRole(node.suggestion.role);
      const acceptedLabels =
        input.regions === undefined && input.functions === undefined && !component.hasV3Data
          ? mergedLabels(labels, suggestionLabels)
          : labels;
      if (!acceptsWeakSuggestion(node.suggestion.role, acceptedLabels, component))
        throw new StoreError(400, "Accept must include this node's current weak suggestion");
      labels.regions = acceptedLabels.regions;
      labels.functions = acceptedLabels.functions;
    }
    if (input.decision === "reject") {
      if (!node.suggestion) throw new StoreError(400, "Reject requires a current weak suggestion");
      if (input.role) throw new StoreError(400, "Reject decisions cannot carry a legacy role");
      const suggestionLabels = labelsForLegacyRole(node.suggestion.role);
      if (
        includesAll(labels.regions, suggestionLabels.regions) &&
        includesAll(labels.functions, suggestionLabels.functions)
      )
        throw new StoreError(400, "Reject cannot retain the rejected weak suggestion");
    }
    if (
      input.decision === "unsure" &&
      (input.role ||
        input.context ||
        labels.regions.length ||
        labels.functions.length ||
        component.componentType ||
        component.purposes.length ||
        component.observedState.length)
    )
      throw new StoreError(400, "Unsure decisions cannot carry labels or context");
    const persistedRole =
      input.decision === "accept" ? (input.role ?? node.suggestion!.role) : (input.role ?? null);
    const modelReview = this.modelReviewForNode(input, page.captureHash, labels, component);
    this.ensureDirectories();
    this.acquireLock();
    try {
      const current = this.readAnnotations();
      const duplicate = current.find((item) => item.clientRequestId === input.clientRequestId);
      if (duplicate) {
        if (
          !sameAnnotationRequest(
            duplicate,
            input,
            page.captureHash,
            labels,
            persistedRole,
            component,
            modelReview,
          )
        )
          throw new StoreError(409, "clientRequestId was already used for a different annotation");
        return duplicate;
      }
      if (input.supersedes) {
        const original = current.find((annotation) => annotation.id === input.supersedes);
        const latest = this.effectiveAnnotations()
          .filter(
            (annotation) =>
              annotation.pageId === input.pageId && annotation.nodeId === input.nodeId,
          )
          .at(-1);
        if (
          !original ||
          original.pageId !== input.pageId ||
          original.nodeId !== input.nodeId ||
          latest?.id !== original.id
        )
          throw new StoreError(
            409,
            "supersedes must reference the latest annotation for this node",
          );
      }
      const annotation: Annotation = {
        id: `ann_${crypto.randomUUID()}`,
        pageId: input.pageId,
        nodeId: input.nodeId,
        decision: input.decision,
        role: persistedRole,
        context: input.context ?? null,
        regions: labels.regions,
        functions: labels.functions,
        labelSchemaVersion: 2,
        componentType: component.componentType,
        componentSubtype: component.componentSubtype,
        observedState: component.observedState,
        purposes: component.purposes,
        componentSchemaVersion: component.hasV3Data ? 3 : 0,
        componentProjection: null,
        purposeProjection: null,
        comment: input.comment ?? null,
        boundary: input.boundary,
        clientRequestId: input.clientRequestId,
        captureHash: page.captureHash,
        supersedes: input.supersedes ?? null,
        // AnnotationInput keeps these optional for requests; persisted records use null.
        modelSuggestionId: modelReview?.id ?? (null as never),
        modelReview: modelReview?.review ?? (null as never),
        source: "human",
        gold: false,
        timestamp: new Date().toISOString(),
        // Which mounted capture set this label belongs to.
        cohortId: this.cohortIdForPage(input.pageId),
      };
      appendFileSync(this.annotationsPath, `${JSON.stringify(annotation)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return annotation;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  savePageAnnotation(input: PageAnnotationInput): PageAnnotation {
    const page = this.readPage(input.pageId);
    if (input.captureHash && input.captureHash !== page.captureHash)
      throw new StoreError(409, "Capture is stale; reload the page");
    const pageTypes =
      input.pageTypes === undefined ? [] : checkedAxis(input.pageTypes, PAGE_TYPES, "pageTypes");
    const contentKinds =
      input.contentKinds === undefined
        ? []
        : checkedAxis(input.contentKinds, CONTENT_KINDS, "contentKinds");
    const modelReview = this.modelReviewForPage(input, page.captureHash, pageTypes, contentKinds);
    if (input.decision === "label" && pageTypes.length + contentKinds.length === 0)
      throw new StoreError(400, "Page labels need a page type or content kind");
    if (input.decision === "unsure" && (pageTypes.length || contentKinds.length))
      throw new StoreError(400, "Unsure page decisions cannot carry labels");
    this.ensureDirectories();
    this.acquireLock();
    try {
      const current = this.readPageAnnotations();
      const duplicate = current.find((item) => item.clientRequestId === input.clientRequestId);
      if (duplicate) {
        if (
          !samePageAnnotationRequest(
            duplicate,
            input,
            page.captureHash,
            pageTypes,
            contentKinds,
            modelReview,
          )
        )
          throw new StoreError(
            409,
            "clientRequestId was already used for a different page annotation",
          );
        return duplicate;
      }
      if (input.supersedes) {
        const original = current.find((annotation) => annotation.id === input.supersedes);
        const latest = this.effectivePageAnnotations()
          .filter((annotation) => annotation.pageId === input.pageId)
          .at(-1);
        if (!original || original.pageId !== input.pageId || latest?.id !== original.id)
          throw new StoreError(
            409,
            "supersedes must reference the latest annotation for this page",
          );
      }
      const annotation: PageAnnotation = {
        id: `pann_${crypto.randomUUID()}`,
        pageId: input.pageId,
        decision: input.decision,
        pageTypes,
        contentKinds,
        comment: input.comment ?? null,
        clientRequestId: input.clientRequestId,
        captureHash: page.captureHash,
        supersedes: input.supersedes ?? null,
        // PageAnnotationInput keeps these optional for requests; persisted records use null.
        modelSuggestionId: modelReview?.id ?? (null as never),
        modelReview: modelReview?.review ?? (null as never),
        source: "human",
        gold: false,
        timestamp: new Date().toISOString(),
        // Which mounted capture set this label belongs to.
        cohortId: this.cohortIdForPage(input.pageId),
      };
      appendFileSync(this.pageAnnotationsPath, `${JSON.stringify(annotation)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return annotation;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  saveModelReview(input: ModelReviewInput): ModelReviewRecord {
    const page = this.readPage(input.pageId);
    if (input.captureHash && input.captureHash !== page.captureHash)
      throw new StoreError(409, "Capture is stale; reload the page");
    const suggestion = this.readModelSuggestions().find(
      (candidate) => candidate.id === input.modelSuggestionId,
    );
    if (
      !suggestion ||
      suggestion.pageId !== input.pageId ||
      suggestion.nodeId !== input.nodeId ||
      suggestion.captureHash !== page.captureHash
    )
      throw new StoreError(400, "Model suggestion does not belong to this capture target");
    this.ensureDirectories();
    this.acquireLock();
    try {
      const current = this.readModelReviews();
      const duplicate = current.find((review) => review.clientRequestId === input.clientRequestId);
      if (duplicate) {
        if (
          duplicate.pageId !== input.pageId ||
          duplicate.nodeId !== input.nodeId ||
          duplicate.modelSuggestionId !== input.modelSuggestionId ||
          duplicate.review !== input.review ||
          duplicate.comment !== (input.comment ?? null) ||
          duplicate.captureHash !== (input.captureHash ?? page.captureHash)
        )
          throw new StoreError(
            409,
            "clientRequestId was already used for a different model review",
          );
        return duplicate;
      }
      const review: ModelReviewRecord = {
        id: `mrev_${crypto.randomUUID()}`,
        pageId: input.pageId,
        nodeId: input.nodeId,
        modelSuggestionId: input.modelSuggestionId,
        review: "reject",
        comment: input.comment ?? null,
        clientRequestId: input.clientRequestId,
        captureHash: page.captureHash,
        source: "human",
        timestamp: new Date().toISOString(),
        cohortId: this.cohortIdForPage(input.pageId),
      };
      appendFileSync(this.modelReviewsPath, `${JSON.stringify(review)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return review;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private modelReviewForNode(
    input: AnnotationInput,
    captureHash: string,
    labels: { regions: Region[]; functions: FunctionLabel[] },
    component: ReturnType<typeof componentForInput>,
  ) {
    const review = this.resolveModelReview(input, captureHash, input.nodeId);
    if (review?.review === "accept") {
      const mapped = review.suggestion.mappedLabels;
      const hasMappedAxis = Boolean(
        mapped.regions?.length ||
        mapped.functions?.length ||
        mapped.purposes?.length ||
        mapped.componentType,
      );
      if (!hasMappedAxis)
        throw new StoreError(400, "Model suggestion has no applicable mapped labels");
      if (
        !includesAll(labels.regions, mapped.regions ?? []) ||
        !includesAll(labels.functions, mapped.functions ?? []) ||
        !includesAll(component.purposes, mapped.purposes ?? []) ||
        (mapped.componentType !== undefined && component.componentType !== mapped.componentType)
      )
        throw new StoreError(400, "Accept must include this model suggestion's mapped labels");
    }
    return review && { id: review.suggestion.id, review: review.review };
  }

  private modelReviewForPage(
    input: PageAnnotationInput,
    captureHash: string,
    pageTypes: PageType[],
    contentKinds: ContentKind[],
  ) {
    const review = this.resolveModelReview(input, captureHash, null);
    if (review?.review === "accept") {
      const mapped = review.suggestion.mappedLabels;
      const hasMappedAxis = Boolean(mapped.pageTypes?.length || mapped.contentKinds?.length);
      if (!hasMappedAxis)
        throw new StoreError(400, "Model suggestion has no applicable mapped labels");
      if (
        !includesAll(pageTypes, mapped.pageTypes ?? []) ||
        !includesAll(contentKinds, mapped.contentKinds ?? [])
      )
        throw new StoreError(400, "Accept must include this model suggestion's mapped labels");
    }
    return review && { id: review.suggestion.id, review: review.review };
  }

  private resolveModelReview(
    input: Pick<AnnotationInput, "pageId" | "modelSuggestionId" | "modelReview">,
    captureHash: string,
    nodeId: string | null,
  ): { suggestion: ModelSuggestion; review: ModelReview } | null {
    const hasId = input.modelSuggestionId !== undefined;
    const hasReview = input.modelReview !== undefined;
    if (hasId !== hasReview)
      throw new StoreError(400, "modelSuggestionId and modelReview must be supplied together");
    if (!hasId) return null;
    const suggestion = this.readModelSuggestions().find(
      (candidate) => candidate.id === input.modelSuggestionId,
    );
    if (
      !suggestion ||
      suggestion.pageId !== input.pageId ||
      suggestion.captureHash !== captureHash ||
      suggestion.nodeId !== nodeId
    )
      throw new StoreError(400, "Model suggestion does not belong to this capture target");
    return { suggestion, review: input.modelReview! };
  }

  private atomicWrite(path: string, value: string | Uint8Array) {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, value, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private acquireLock() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        mkdirSync(this.lockPath, { mode: 0o700 });
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    throw new StoreError(503, "Annotation store is busy; try again");
  }
}

function sameAnnotationRequest(
  annotation: Annotation,
  input: AnnotationInput,
  captureHash: string,
  labels: { regions: Region[]; functions: FunctionLabel[] },
  persistedRole: Role | null,
  component: ReturnType<typeof componentForInput>,
  modelReview: { id: string; review: ModelReview } | null,
) {
  return (
    annotation.pageId === input.pageId &&
    annotation.nodeId === input.nodeId &&
    annotation.decision === input.decision &&
    annotation.role === persistedRole &&
    annotation.context === (input.context ?? null) &&
    sameLabels(annotation.regions, labels.regions) &&
    sameLabels(annotation.functions, labels.functions) &&
    annotation.componentType === component.componentType &&
    annotation.componentSubtype === component.componentSubtype &&
    sameLabels(annotation.observedState, component.observedState) &&
    sameLabels(annotation.purposes, component.purposes) &&
    annotation.comment === (input.comment ?? null) &&
    annotation.boundary === input.boundary &&
    annotation.captureHash === (input.captureHash ?? captureHash) &&
    annotation.supersedes === (input.supersedes ?? null) &&
    annotation.modelSuggestionId === (modelReview?.id ?? null) &&
    annotation.modelReview === (modelReview?.review ?? null)
  );
}

function latestBy<T>(items: T[], key: (item: T) => string) {
  const latest = new Map<string, T>();
  for (const item of items) latest.set(key(item), item);
  return latest;
}

function actionKey(kind: ReviewActionKind, id: string) {
  return `${kind}\u0000${id}`;
}

function emptyStats(): LabelerStats {
  return {
    generatedAt: new Date().toISOString(),
    pages: { total: 0, labelled: 0, currentPageLabels: 0 },
    elements: { total: 0, currentHumanLabels: 0, latestManualLabels: 0 },
    suggestions: {
      total: 0,
      page: 0,
      element: 0,
      pending: 0,
      reviewed: { accepted: 0, corrected: 0, rejected: 0 },
    },
    byCohort: {
      [PRIMARY_COHORT_ID]: { pages: 0, labelledPages: 0, currentHumanLabels: 0, bySource: {} },
    },
  };
}

function samePageAnnotationRequest(
  annotation: PageAnnotation,
  input: PageAnnotationInput,
  captureHash: string,
  pageTypes: PageType[],
  contentKinds: ContentKind[],
  modelReview: { id: string; review: ModelReview } | null,
) {
  return (
    annotation.pageId === input.pageId &&
    annotation.decision === input.decision &&
    sameLabels(annotation.pageTypes, pageTypes) &&
    sameLabels(annotation.contentKinds, contentKinds) &&
    annotation.comment === (input.comment ?? null) &&
    annotation.captureHash === (input.captureHash ?? captureHash) &&
    annotation.supersedes === (input.supersedes ?? null) &&
    annotation.modelSuggestionId === (modelReview?.id ?? null) &&
    annotation.modelReview === (modelReview?.review ?? null)
  );
}

function labelsForInput(input: AnnotationInput) {
  const fallback = mergedLabels(
    labelsForLegacyRole(input.role ?? null),
    labelsForLegacyContext(input.context ?? null),
  );
  return {
    regions:
      input.regions === undefined
        ? fallback.regions
        : checkedAxis(input.regions, REGIONS, "regions"),
    functions:
      input.functions === undefined
        ? fallback.functions
        : checkedAxis(input.functions, FUNCTIONS, "functions"),
  };
}

function componentForInput(input: AnnotationInput) {
  const componentType = input.componentType ?? null;
  if (componentType !== null && !COMPONENT_TYPES.includes(componentType))
    throw new StoreError(400, "Invalid componentType");
  const allowedSubtypes = componentType ? COMPONENT_SUBTYPES[componentType] : undefined;
  if (input.componentSubtype !== undefined) {
    if (!componentType || !allowedSubtypes || !allowedSubtypes.includes(input.componentSubtype))
      throw new StoreError(400, "Invalid componentSubtype for componentType");
  }
  const observedState =
    input.observedState === undefined
      ? []
      : checkedAxis(input.observedState, OBSERVED_STATES, "observedState");
  for (const state of observedState) {
    if (state === "unknown") continue;
    if (!componentType || !STATEFUL_COMPONENT_TYPES[state].includes(componentType as never))
      throw new StoreError(400, "observedState is not applicable to componentType");
  }
  const purposes =
    input.purposes === undefined ? [] : checkedAxis(input.purposes, PURPOSES, "purposes");
  return {
    componentType,
    componentSubtype: input.componentSubtype ?? null,
    observedState,
    purposes,
    hasV3Data:
      componentType !== null ||
      input.componentSubtype !== undefined ||
      input.observedState !== undefined ||
      input.purposes !== undefined,
  };
}

function legacyComponentProjection(role: Role | null, functions: FunctionLabel[]) {
  const candidates = new Set<ComponentType>();
  if (role === "card" || functions.includes("card")) candidates.add("card");
  if (role === "form" || functions.includes("form")) candidates.add("form");
  if (role === "consent_banner" || functions.includes("consent_banner")) candidates.add("banner");
  if (candidates.size !== 1) return null;
  return { componentType: [...candidates][0]!, provenance: "legacy-v1-v2" as const };
}

function legacyPurposeProjection(role: Role | null, functions: FunctionLabel[]) {
  if (role === "navigation" || functions.includes("navigation"))
    return { purposes: ["navigation"] as Purpose[], provenance: "legacy-v1-v2" as const };
  return null;
}

function acceptsWeakSuggestion(
  role: Role,
  labels: { regions: Region[]; functions: FunctionLabel[] },
  component: ReturnType<typeof componentForInput>,
) {
  const suggestionLabels = labelsForLegacyRole(role);
  if (
    includesAll(labels.regions, suggestionLabels.regions) &&
    includesAll(labels.functions, suggestionLabels.functions)
  )
    return true;
  if (role === "navigation")
    return (
      component.componentType === "navigation_menu" || component.purposes.includes("navigation")
    );
  if (role === "card") return component.componentType === "card";
  if (role === "form") return component.componentType === "form";
  if (role === "consent_banner")
    return component.componentType === "banner" || component.purposes.includes("consent");
  return false;
}

function labelsForLegacyRole(role: Role | null) {
  if (!role) return { regions: [] as Region[], functions: [] as FunctionLabel[] };
  if (role === "navigation")
    return { regions: [] as Region[], functions: ["navigation"] as FunctionLabel[] };
  if (role === "card" || role === "form" || role === "consent_banner")
    return { regions: [] as Region[], functions: [role] as FunctionLabel[] };
  const regionByRole: Partial<Record<Role, Region>> = {
    site_header: "site_header",
    footer: "footer",
    aside: "sidebar",
    main_content: "main_content",
    article_header: "article_header",
    unknown: "unknown",
  };
  return {
    regions: regionByRole[role] ? [regionByRole[role]!] : [],
    functions: [] as FunctionLabel[],
  };
}

function labelsForLegacyContext(context: Annotation["context"]) {
  const regionByContext: Partial<Record<NonNullable<Annotation["context"]>, Region>> = {
    header: "site_header",
    footer: "footer",
    main: "main_content",
  };
  const region = context ? regionByContext[context] : undefined;
  return { regions: region ? [region] : [], functions: [] as FunctionLabel[] };
}

function mergedLabels(...labels: Array<{ regions: Region[]; functions: FunctionLabel[] }>) {
  const regions = [...new Set(labels.flatMap((item) => item.regions))];
  const functions = [...new Set(labels.flatMap((item) => item.functions))];
  return {
    regions: regions.includes("unknown") ? ["unknown"] : regions,
    functions: functions.includes("unknown") ? ["unknown"] : functions,
  } as { regions: Region[]; functions: FunctionLabel[] };
}

function checkedAxis<T extends string>(value: unknown, allowed: readonly T[], name: string): T[] {
  if (
    !Array.isArray(value) ||
    value.length > allowed.length ||
    value.some((item) => typeof item !== "string" || !allowed.includes(item as T))
  )
    throw new StoreError(400, `Invalid ${name}`);
  const labels = [...new Set(value)] as T[];
  if (labels.length !== value.length || (labels.includes("unknown" as T) && labels.length !== 1))
    throw new StoreError(400, `${name} must be unique and unknown must stand alone`);
  return labels;
}

function includesAll<T>(labels: T[], required: T[]) {
  return required.every((label) => labels.includes(label));
}

function sameLabels<T>(left: T[], right: T[]) {
  return left.length === right.length && left.every((label, index) => label === right[index]);
}

function isPage(value: unknown): value is CapturedPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<CapturedPage>;
  return (
    typeof page.id === "string" &&
    typeof page.url === "string" &&
    typeof page.title === "string" &&
    typeof page.contentHash === "string" &&
    typeof page.captureHash === "string" &&
    Array.isArray(page.nodes) &&
    typeof page.width === "number" &&
    typeof page.height === "number"
  );
}

function normalizeStoredAnnotation(value: unknown): Annotation | null {
  if (!value || typeof value !== "object") return null;
  const annotation = value as Partial<Annotation>;
  if (
    typeof annotation.id !== "string" ||
    typeof annotation.pageId !== "string" ||
    typeof annotation.nodeId !== "string" ||
    typeof annotation.clientRequestId !== "string" ||
    typeof annotation.captureHash !== "string" ||
    typeof annotation.decision !== "string" ||
    typeof annotation.boundary !== "string"
  )
    return null;
  const role = annotation.role ?? null;
  const context = annotation.context ?? null;
  if ((role !== null && !ROLES.includes(role)) || (context !== null && !CONTEXTS.includes(context)))
    return null;
  try {
    const hasV2Axes = annotation.regions !== undefined || annotation.functions !== undefined;
    const labels = hasV2Axes
      ? {
          regions:
            annotation.regions === undefined
              ? []
              : checkedAxis(annotation.regions, REGIONS, "regions"),
          functions:
            annotation.functions === undefined
              ? []
              : checkedAxis(annotation.functions, FUNCTIONS, "functions"),
        }
      : mergedLabels(labelsForLegacyRole(role), labelsForLegacyContext(context));
    const hasV3ComponentData = annotation.componentSchemaVersion === 3;
    const component = hasV3ComponentData
      ? componentForInput({
          componentType: annotation.componentType ?? undefined,
          componentSubtype: annotation.componentSubtype ?? undefined,
          observedState: annotation.observedState,
          purposes: annotation.purposes,
        } as AnnotationInput)
      : {
          componentType: null,
          componentSubtype: null,
          observedState: [] as ObservedState[],
          purposes: [] as Purpose[],
          hasV3Data: false,
        };
    return {
      ...annotation,
      role,
      context,
      regions: labels.regions,
      functions: labels.functions,
      labelSchemaVersion: hasV2Axes ? 2 : 1,
      componentType: component.componentType,
      componentSubtype: component.componentSubtype,
      observedState: component.observedState,
      purposes: component.purposes,
      componentSchemaVersion: hasV3ComponentData ? 3 : 0,
      componentProjection: hasV3ComponentData
        ? null
        : legacyComponentProjection(role, labels.functions),
      purposeProjection: hasV3ComponentData
        ? null
        : legacyPurposeProjection(role, labels.functions),
      modelSuggestionId:
        typeof annotation.modelSuggestionId === "string" ? annotation.modelSuggestionId : null,
      modelReview:
        annotation.modelReview === "accept" ||
        annotation.modelReview === "correct" ||
        annotation.modelReview === "reject"
          ? annotation.modelReview
          : null,
    } as Annotation;
  } catch {
    return null;
  }
}

function normalizePageAnnotation(value: unknown): PageAnnotation | null {
  if (!value || typeof value !== "object") return null;
  const annotation = value as Partial<PageAnnotation>;
  if (
    typeof annotation.id !== "string" ||
    typeof annotation.pageId !== "string" ||
    typeof annotation.decision !== "string" ||
    typeof annotation.clientRequestId !== "string" ||
    typeof annotation.captureHash !== "string" ||
    !Array.isArray(annotation.pageTypes) ||
    !Array.isArray(annotation.contentKinds)
  )
    return null;
  try {
    return {
      ...annotation,
      pageTypes: checkedAxis(annotation.pageTypes, PAGE_TYPES, "pageTypes"),
      contentKinds: checkedAxis(annotation.contentKinds, CONTENT_KINDS, "contentKinds"),
      modelSuggestionId:
        typeof annotation.modelSuggestionId === "string" ? annotation.modelSuggestionId : null,
      modelReview:
        annotation.modelReview === "accept" ||
        annotation.modelReview === "correct" ||
        annotation.modelReview === "reject"
          ? annotation.modelReview
          : null,
    } as PageAnnotation;
  } catch {
    return null;
  }
}

function normalizeModelReviewRecord(value: unknown): ModelReviewRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const review = value as Partial<ModelReviewRecord>;
  if (
    typeof review.id !== "string" ||
    !/^mrev_[0-9a-f-]{36}$/.test(review.id) ||
    typeof review.pageId !== "string" ||
    !captureIdPattern.test(review.pageId) ||
    !(typeof review.nodeId === "string" || review.nodeId === null) ||
    (typeof review.nodeId === "string" && !/^node_[a-f0-9]{24}$/.test(review.nodeId)) ||
    typeof review.modelSuggestionId !== "string" ||
    !/^msug_[0-9a-f-]{36}$/.test(review.modelSuggestionId) ||
    review.review !== "reject" ||
    !(typeof review.comment === "string" || review.comment === null) ||
    (typeof review.comment === "string" && review.comment.length > 800) ||
    typeof review.clientRequestId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(review.clientRequestId) ||
    typeof review.captureHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(review.captureHash) ||
    review.source !== "human" ||
    typeof review.timestamp !== "string" ||
    Number.isNaN(Date.parse(review.timestamp))
  )
    return null;
  return review as ModelReviewRecord;
}

function normalizeReviewUndoRecord(value: unknown): ReviewUndoRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const undo = value as Partial<ReviewUndoRecord>;
  if (
    typeof undo.id !== "string" ||
    !/^undo_[0-9a-f-]{36}$/.test(undo.id) ||
    (undo.actionKind !== "annotation" &&
      undo.actionKind !== "page_annotation" &&
      undo.actionKind !== "model_review") ||
    typeof undo.actionId !== "string" ||
    typeof undo.pageId !== "string" ||
    !captureIdPattern.test(undo.pageId) ||
    !(typeof undo.nodeId === "string" || undo.nodeId === null) ||
    (typeof undo.nodeId === "string" && !/^node_[a-f0-9]{24}$/.test(undo.nodeId)) ||
    typeof undo.captureHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(undo.captureHash) ||
    typeof undo.timestamp !== "string" ||
    Number.isNaN(Date.parse(undo.timestamp))
  )
    return null;
  return undo as ReviewUndoRecord;
}

function normalizeModelSuggestion(value: unknown): ModelSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<ModelSuggestion> & { schemaVersion?: unknown };
  if (
    row.schemaVersion !== 1 ||
    typeof row.id !== "string" ||
    !/^msug_[0-9a-f-]{36}$/.test(row.id) ||
    typeof row.pageId !== "string" ||
    !captureIdPattern.test(row.pageId) ||
    !(typeof row.nodeId === "string" || row.nodeId === null) ||
    (typeof row.nodeId === "string" && !/^node_[a-f0-9]{24}$/.test(row.nodeId)) ||
    typeof row.captureHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(row.captureHash) ||
    row.provider !== "typesafe" ||
    !boundedIdentifier(row.modelId, 160) ||
    !boundedIdentifier(row.modelRevision, 160) ||
    !boundedIdentifier(row.promptRevision, 160) ||
    (row.taxonomyRevision !== undefined && row.taxonomyRevision !== TAXONOMY_REVISION) ||
    typeof row.snapshotHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(row.snapshotHash) ||
    !isJsonValue(row.rawAnswers) ||
    JSON.stringify(row.rawAnswers).length > 100_000 ||
    typeof row.provisional !== "boolean" ||
    typeof row.createdAt !== "string" ||
    Number.isNaN(Date.parse(row.createdAt)) ||
    !row.mappedLabels ||
    typeof row.mappedLabels !== "object" ||
    Array.isArray(row.mappedLabels)
  )
    return null;
  if (
    (row.rawClass !== undefined && !boundedIdentifier(row.rawClass, 160)) ||
    (row.score !== undefined && !probability(row.score)) ||
    !validUsage(row.usage)
  )
    return null;
  try {
    const mappedLabels = normalizeMappedLabels(row.mappedLabels);
    const axisProbabilities = normalizeAxisProbabilities(row.axisProbabilities);
    const componentTypeChoice = normalizeComponentTypeChoice(row.componentTypeChoice);
    const usage = normalizeUsage(row.usage);
    return {
      schemaVersion: 1,
      id: row.id,
      pageId: row.pageId,
      nodeId: row.nodeId,
      captureHash: row.captureHash,
      provider: row.provider,
      modelId: row.modelId,
      modelRevision: row.modelRevision,
      promptRevision: row.promptRevision,
      ...(row.taxonomyRevision === undefined ? {} : { taxonomyRevision: row.taxonomyRevision }),
      snapshotHash: row.snapshotHash,
      rawAnswers: row.rawAnswers,
      ...(row.rawClass === undefined ? {} : { rawClass: row.rawClass }),
      ...(row.score === undefined ? {} : { score: row.score }),
      ...(usage === undefined ? {} : { usage }),
      provisional: row.provisional,
      mappedLabels,
      ...(axisProbabilities === undefined ? {} : { axisProbabilities }),
      ...(componentTypeChoice === undefined ? {} : { componentTypeChoice }),
      createdAt: row.createdAt,
    };
  } catch {
    return null;
  }
}

function normalizeMappedLabels(value: ModelSuggestion["mappedLabels"]) {
  const labels = value as Record<string, unknown>;
  if (
    Object.keys(labels).some(
      (key) =>
        ![
          "regions",
          "functions",
          "purposes",
          "componentType",
          "pageTypes",
          "contentKinds",
        ].includes(key),
    )
  )
    throw new StoreError(400, "Invalid model mappedLabels");
  const componentType = labels.componentType;
  if (
    componentType !== undefined &&
    (typeof componentType !== "string" || !COMPONENT_TYPES.includes(componentType as ComponentType))
  )
    throw new StoreError(400, "Invalid model componentType");
  return {
    ...(labels.regions === undefined
      ? {}
      : { regions: checkedAxis(labels.regions, REGIONS, "model regions") }),
    ...(labels.functions === undefined
      ? {}
      : { functions: checkedAxis(labels.functions, FUNCTIONS, "model functions") }),
    ...(labels.purposes === undefined
      ? {}
      : { purposes: checkedAxis(labels.purposes, PURPOSES, "model purposes") }),
    ...(componentType === undefined ? {} : { componentType }),
    ...(labels.pageTypes === undefined
      ? {}
      : { pageTypes: checkedAxis(labels.pageTypes, PAGE_TYPES, "model pageTypes") }),
    ...(labels.contentKinds === undefined
      ? {}
      : { contentKinds: checkedAxis(labels.contentKinds, CONTENT_KINDS, "model contentKinds") }),
  } as ModelSuggestion["mappedLabels"];
}

function normalizeAxisProbabilities(
  value: unknown,
): ModelSuggestion["axisProbabilities"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StoreError(400, "Invalid model probabilities");
  const axes = value as Record<string, unknown>;
  const allowed = {
    regions: REGIONS,
    functions: FUNCTIONS,
    purposes: PURPOSES,
    pageTypes: PAGE_TYPES,
    contentKinds: CONTENT_KINDS,
  } as const;
  if (Object.keys(axes).some((key) => !(key in allowed)))
    throw new StoreError(400, "Invalid model probability axis");
  const result: Record<string, unknown> = {};
  for (const [axis, values] of Object.entries(allowed)) {
    const probabilities = axes[axis];
    if (probabilities === undefined) continue;
    if (!Array.isArray(probabilities) || probabilities.length > values.length)
      throw new StoreError(400, "Invalid model probabilities");
    const seen = new Set<string>();
    for (const item of probabilities) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new StoreError(400, "Invalid model probability");
      const entry = item as { label?: unknown; yesProbability?: unknown };
      if (
        typeof entry.label !== "string" ||
        !values.includes(entry.label as never) ||
        !probability(entry.yesProbability) ||
        seen.has(entry.label)
      )
        throw new StoreError(400, "Invalid model probability");
      seen.add(entry.label);
    }
    result[axis] = probabilities;
  }
  return result as ModelSuggestion["axisProbabilities"];
}

function normalizeComponentTypeChoice(
  value: unknown,
): ModelSuggestion["componentTypeChoice"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StoreError(400, "Invalid componentTypeChoice");
  const choice = value as { choice?: unknown; distribution?: unknown; confidence?: unknown };
  if (
    typeof choice.choice !== "string" ||
    !COMPONENT_TYPES.includes(choice.choice as ComponentType) ||
    !probability(choice.confidence) ||
    !Array.isArray(choice.distribution) ||
    choice.distribution.length === 0 ||
    choice.distribution.length > COMPONENT_TYPES.length
  )
    throw new StoreError(400, "Invalid componentTypeChoice");
  const seen = new Set<string>();
  for (const item of choice.distribution) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new StoreError(400, "Invalid componentTypeChoice");
    const entry = item as { label?: unknown; probability?: unknown };
    if (
      typeof entry.label !== "string" ||
      !COMPONENT_TYPES.includes(entry.label as ComponentType) ||
      !probability(entry.probability) ||
      seen.has(entry.label)
    )
      throw new StoreError(400, "Invalid componentTypeChoice");
    seen.add(entry.label);
  }
  return choice as ModelSuggestion["componentTypeChoice"];
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function boundedIdentifier(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9._:/@-]+$/.test(value)
  );
}

function validUsage(value: unknown) {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return (
    Object.keys(usage).every(
      (key) =>
        key === "inputTokens" ||
        key === "outputTokens" ||
        key === "input_tokens" ||
        key === "output_tokens",
    ) && Object.values(usage).every((count) => Number.isInteger(count) && (count as number) >= 0)
  );
}

function normalizeUsage(value: unknown): ModelSuggestion["usage"] | undefined {
  if (value === undefined) return undefined;
  const usage = value as {
    inputTokens?: number;
    outputTokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  return {
    ...((usage.inputTokens ?? usage.input_tokens) === undefined
      ? {}
      : { inputTokens: usage.inputTokens ?? usage.input_tokens }),
    ...((usage.outputTokens ?? usage.output_tokens) === undefined
      ? {}
      : { outputTokens: usage.outputTokens ?? usage.output_tokens }),
  };
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
}
