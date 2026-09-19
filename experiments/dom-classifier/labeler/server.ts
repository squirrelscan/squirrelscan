#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureSeedPages } from "./capture.ts";
import { LabelStore, StoreError } from "./store.ts";
import {
  COMPONENT_SUBTYPES,
  COMPONENT_TYPES,
  CONTEXTS,
  FUNCTIONS,
  OBSERVED_STATES,
  CONTENT_KINDS,
  PAGE_TYPES,
  PAGE_TYPE_GROUPS,
  PURPOSES,
  REGIONS,
  ROLES,
  STATEFUL_COMPONENT_TYPES,
  TAXONOMY_REVISION,
  type AnnotationInput,
  type CohortSource,
  type ModelReviewInput,
  type PageAnnotationInput,
  type ReviewActionKind,
} from "./types.ts";

export const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "squirrel", "dom-labeler");
const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
]);
const staticTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Mount extra capture sets from `LABELER_COHORTS`, a comma-separated list of
 * `id=/absolute/path` entries. Each path holds `captures/` and, optionally, its
 * own `model-suggestions.jsonl`. Labels still land in the primary data
 * directory, stamped with the cohort id, so existing labels are never moved.
 */
export function cohortsFromEnv(value = process.env.LABELER_COHORTS): CohortSource[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) throw new Error(`LABELER_COHORTS entry must be id=path: ${entry}`);
      return { id: entry.slice(0, separator).trim(), dir: entry.slice(separator + 1).trim() };
    });
}

export function createLabelerServer(
  options: { dataDir?: string; staticDir?: string; cohorts?: CohortSource[] } = {},
) {
  const store = new LabelStore(
    options.dataDir ?? process.env.LABELER_DATA_DIR ?? DEFAULT_DATA_DIR,
    options.cohorts ?? cohortsFromEnv(),
  );
  const staticDir = options.staticDir ?? import.meta.dir;
  return Bun.serve({
    port: Number(process.env.PORT ?? 4317),
    hostname: process.env.HOST ?? "127.0.0.1",
    fetch: (request) => handleRequest(request, store, staticDir),
  });
}

export async function handleRequest(
  request: Request,
  store: LabelStore,
  staticDir = import.meta.dir,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    validateHost(request, url);
    if (request.method === "GET" && url.pathname === "/api/pages")
      return withCsrf(
        request,
        json({
          pages: store.listPages(),
          roles: ROLES,
          regions: REGIONS,
          functions: FUNCTIONS,
          contexts: CONTEXTS,
          componentTypes: COMPONENT_TYPES,
          componentSubtypes: COMPONENT_SUBTYPES,
          purposes: PURPOSES,
          observedStates: OBSERVED_STATES,
          statefulComponentTypes: STATEFUL_COMPONENT_TYPES,
          taxonomyRevision: TAXONOMY_REVISION,
          pageTypes: PAGE_TYPES,
          pageTypeGroups: PAGE_TYPE_GROUPS,
          contentKinds: CONTENT_KINDS,
        }),
      );
    if (request.method === "GET" && url.pathname.startsWith("/api/pages/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/pages/".length));
      const page = store.readPage(id);
      return withCsrf(
        request,
        json({
          ...page,
          annotations: store.annotationsForPage(id),
          pageAnnotations: store.pageAnnotationsForPage(id),
          modelSuggestions: store.modelSuggestionsForPage(id),
          modelReviews: store.modelReviewsForPage(id),
        }),
      );
    }
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/captures/") &&
      url.pathname.endsWith(".png")
    ) {
      const id = url.pathname.slice("/captures/".length, -4);
      const bytes = readFileSync(store.screenshotPath(id));
      return new Response(bytes, {
        headers: {
          "content-type": "image/png",
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/export") {
      return new Response(store.effectiveAnnotationsJsonl(), {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": "attachment; filename=human-annotations.jsonl",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/stats")
      return withCsrf(request, json(store.stats()));
    if (request.method === "GET" && url.pathname === "/api/export/reviews") {
      const reviewExport = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        stats: store.stats(),
        nodeAnnotationHistory: jsonlRecords(store.rawAnnotationsJsonl()),
        pageAnnotationHistory: jsonlRecords(store.rawPageAnnotationsJsonl()),
        modelReviewHistory: jsonlRecords(store.rawModelReviewsJsonl()),
        undoHistory: jsonlRecords(store.rawReviewUndosJsonl()),
      };
      return new Response(JSON.stringify(reviewExport), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": "attachment; filename=labeler-review-history.json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/annotations") {
      validateCsrf(request, url);
      const body = await request.json();
      const annotation = store.saveAnnotation(validateAnnotation(body));
      return json({ annotation }, 201);
    }
    if (request.method === "POST" && url.pathname === "/api/page-annotations") {
      validateCsrf(request, url);
      const body = await request.json();
      const annotation = store.savePageAnnotation(validatePageAnnotation(body));
      return json({ annotation }, 201);
    }
    if (request.method === "POST" && url.pathname === "/api/model-reviews") {
      validateCsrf(request, url);
      const body = await request.json();
      const modelReview = store.saveModelReview(validateModelReview(body));
      return json({ modelReview }, 201);
    }
    if (request.method === "POST" && url.pathname === "/api/review-actions/undo") {
      validateCsrf(request, url);
      const result = store.undoReviewAction(validateReviewUndo(await request.json()));
      return json(
        {
          undo: result.undo,
          annotations: store.annotationsForPage(result.undo.pageId),
          pageAnnotations: store.pageAnnotationsForPage(result.undo.pageId),
          modelReviews: store.modelReviewsForPage(result.undo.pageId),
          stats: store.stats(),
        },
        result.created ? 201 : 200,
      );
    }
    if (request.method === "GET" && staticFiles.has(url.pathname))
      return staticResponse(staticDir, staticFiles.get(url.pathname)!);
    return json({ error: "Not found" }, 404);
  } catch (error) {
    const status =
      error instanceof StoreError ? error.status : error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return json({ error: message }, status);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function validateHost(request: Request, url: URL) {
  const host = request.headers.get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(host))
    throw new HttpError(403, "Localhost host required");
  if (!/^(localhost|127\.0\.0\.1)$/.test(url.hostname))
    throw new HttpError(403, "Localhost origin required");
}

function csrfToken(request: Request) {
  return (
    request.headers.get("cookie")?.match(/(?:^|;\s*)labeler_csrf=([a-f0-9]{32})(?:;|$)/)?.[1] ??
    null
  );
}

function withCsrf(request: Request, response: Response) {
  if (csrfToken(request)) return response;
  response.headers.set(
    "set-cookie",
    `labeler_csrf=${crypto.randomUUID().replaceAll("-", "")}; Path=/; SameSite=Strict`,
  );
  return response;
}

function validateCsrf(request: Request, url: URL) {
  const origin = request.headers.get("origin");
  const expectedOrigin = `${url.protocol}//${request.headers.get("host")}`;
  if (origin !== expectedOrigin) throw new HttpError(403, "Same-origin save required");
  const token = csrfToken(request);
  if (!token || request.headers.get("x-labeler-csrf") !== token)
    throw new HttpError(403, "Missing CSRF token");
}

function validateAnnotation(value: unknown): AnnotationInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Annotation object required");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "pageId",
    "nodeId",
    "decision",
    "role",
    "context",
    "regions",
    "functions",
    "componentType",
    "componentSubtype",
    "observedState",
    "purposes",
    "comment",
    "boundary",
    "clientRequestId",
    "captureHash",
    "supersedes",
    "modelSuggestionId",
    "modelReview",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new HttpError(400, "Unknown annotation field");
  const string = (key: string, pattern: RegExp, required = true, maximum = 500) => {
    const item = input[key];
    if (item === undefined && !required) return undefined;
    if (typeof item !== "string" || item.length > maximum || !pattern.test(item))
      throw new HttpError(400, `Invalid ${key}`);
    return item;
  };
  const pageId = string("pageId", /^page_[a-f0-9]{24}$/, true, 30)!;
  const nodeId = string("nodeId", /^node_[a-f0-9]{24}$/, true, 30)!;
  const decision = string("decision", /^(label|accept|reject|unsure)$/, true, 10)!;
  const boundary = string("boundary", /^(correct|too_broad|too_narrow|mixed|unsure)$/, true, 20)!;
  const role = string(
    "role",
    /^(site_header|footer|navigation|main_content|article_header|card|aside|form|consent_banner|unknown)$/,
    false,
    20,
  );
  const context = string("context", /^(site|article|main|header|footer|unknown)$/, false, 12);
  const array = <T extends string>(key: string, allowed: readonly T[]) => {
    const item = input[key];
    if (item === undefined) return undefined;
    if (
      !Array.isArray(item) ||
      item.length > allowed.length ||
      item.some((value) => typeof value !== "string" || !allowed.includes(value as T))
    )
      throw new HttpError(400, `Invalid ${key}`);
    const labels = [...new Set(item)] as T[];
    if (labels.length !== item.length || (labels.includes("unknown" as T) && labels.length !== 1))
      throw new HttpError(400, `${key} must be unique and unknown must stand alone`);
    return labels;
  };
  const regions = array("regions", REGIONS);
  const functions = array("functions", FUNCTIONS);
  const componentType = (() => {
    const item = input.componentType;
    if (item === undefined) return undefined;
    if (
      typeof item !== "string" ||
      !COMPONENT_TYPES.includes(item as (typeof COMPONENT_TYPES)[number])
    )
      throw new HttpError(400, "Invalid componentType");
    return item as AnnotationInput["componentType"];
  })();
  const componentSubtype = string("componentSubtype", /^[a-z_]{1,20}$/, false, 20);
  if (
    componentSubtype &&
    (!componentType || !COMPONENT_SUBTYPES[componentType]?.includes(componentSubtype))
  )
    throw new HttpError(400, "Invalid componentSubtype for componentType");
  const observedState = array("observedState", OBSERVED_STATES);
  for (const state of observedState ?? []) {
    if (
      state !== "unknown" &&
      (!componentType || !STATEFUL_COMPONENT_TYPES[state].includes(componentType as never))
    )
      throw new HttpError(400, "observedState is not applicable to componentType");
  }
  const purposes = array("purposes", PURPOSES);
  const comment = string("comment", /^[\s\S]*$/, false, 800);
  const clientRequestId = string("clientRequestId", /^[A-Za-z0-9_-]{8,128}$/, true, 128)!;
  const captureHash = string("captureHash", /^sha256:[a-f0-9]{64}$/, false, 71);
  const supersedes = string("supersedes", /^ann_[0-9a-f-]{36}$/, false, 40);
  const modelSuggestionId = string("modelSuggestionId", /^msug_[0-9a-f-]{36}$/, false, 41);
  const modelReview = string("modelReview", /^(accept|correct|reject)$/, false, 10);
  if ((modelSuggestionId === undefined) !== (modelReview === undefined))
    throw new HttpError(400, "modelSuggestionId and modelReview must be supplied together");
  if (
    decision === "label" &&
    !role &&
    !(regions?.length || functions?.length || purposes?.length) &&
    !componentType
  )
    throw new HttpError(400, "label decisions need a region, function, purpose, or component type");
  if (decision === "reject" && role)
    throw new HttpError(400, "reject decisions cannot carry a legacy role");
  if (
    decision === "unsure" &&
    (role ||
      context ||
      regions?.length ||
      functions?.length ||
      componentType ||
      componentSubtype ||
      observedState?.length ||
      purposes?.length)
  )
    throw new HttpError(400, "unsure decisions cannot carry labels or context");
  return {
    pageId,
    nodeId,
    decision: decision as AnnotationInput["decision"],
    role: role as AnnotationInput["role"],
    context: context as AnnotationInput["context"],
    regions: regions as AnnotationInput["regions"],
    functions: functions as AnnotationInput["functions"],
    componentType,
    componentSubtype,
    observedState: observedState as AnnotationInput["observedState"],
    purposes: purposes as AnnotationInput["purposes"],
    comment,
    boundary: boundary as AnnotationInput["boundary"],
    clientRequestId,
    captureHash,
    supersedes,
    modelSuggestionId,
    modelReview: modelReview as AnnotationInput["modelReview"],
  };
}

function validateModelReview(value: unknown): ModelReviewInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Model review object required");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "pageId",
    "nodeId",
    "modelSuggestionId",
    "review",
    "comment",
    "clientRequestId",
    "captureHash",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new HttpError(400, "Unknown model review field");
  const string = (key: string, pattern: RegExp, required = true, maximum = 500) => {
    const item = input[key];
    if (item === undefined && !required) return undefined;
    if (typeof item !== "string" || item.length > maximum || !pattern.test(item))
      throw new HttpError(400, `Invalid ${key}`);
    return item;
  };
  const pageId = string("pageId", /^page_[a-f0-9]{24}$/, true, 30)!;
  const nodeId = input.nodeId === null ? null : string("nodeId", /^node_[a-f0-9]{24}$/, true, 30)!;
  const modelSuggestionId = string("modelSuggestionId", /^msug_[0-9a-f-]{36}$/, true, 41)!;
  const review = string("review", /^reject$/, true, 10)!;
  const comment = string("comment", /^[\s\S]*$/, false, 800);
  const clientRequestId = string("clientRequestId", /^[A-Za-z0-9_-]{8,128}$/, true, 128)!;
  const captureHash = string("captureHash", /^sha256:[a-f0-9]{64}$/, false, 71);
  return {
    pageId,
    nodeId,
    modelSuggestionId,
    review: review as "reject",
    comment,
    clientRequestId,
    captureHash,
  };
}

function validateReviewUndo(value: unknown): {
  pageId: string;
  nodeId: string | null;
  captureHash: string;
  actionKind: ReviewActionKind;
  actionId: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Undo object required");
  const input = value as Record<string, unknown>;
  if (
    !["pageId", "nodeId", "captureHash", "action"].every((key) => key in input) ||
    Object.keys(input).some((key) => !["pageId", "nodeId", "captureHash", "action"].includes(key))
  )
    throw new HttpError(400, "Invalid undo fields");
  if (typeof input.pageId !== "string" || !/^page_[a-f0-9]{24}$/.test(input.pageId))
    throw new HttpError(400, "Invalid pageId");
  if (
    input.nodeId !== null &&
    (typeof input.nodeId !== "string" || !/^node_[a-f0-9]{24}$/.test(input.nodeId))
  )
    throw new HttpError(400, "Invalid nodeId");
  if (typeof input.captureHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.captureHash))
    throw new HttpError(400, "Invalid captureHash");
  if (!input.action || typeof input.action !== "object" || Array.isArray(input.action))
    throw new HttpError(400, "Invalid undo action");
  const action = input.action as Record<string, unknown>;
  if (
    Object.keys(action).length !== 2 ||
    !["kind", "id"].every((key) => key in action) ||
    (action.kind !== "annotation" &&
      action.kind !== "page_annotation" &&
      action.kind !== "model_review") ||
    typeof action.id !== "string" ||
    !/^(ann_|pann_|mrev_)[0-9a-f-]{36}$/.test(action.id)
  )
    throw new HttpError(400, "Invalid undo action");
  const expectedPrefix =
    action.kind === "annotation" ? "ann_" : action.kind === "page_annotation" ? "pann_" : "mrev_";
  if (!action.id.startsWith(expectedPrefix))
    throw new HttpError(400, "Undo action kind does not match id");
  if ((action.kind === "page_annotation") !== (input.nodeId === null))
    throw new HttpError(400, "Undo action target does not match nodeId");
  return {
    pageId: input.pageId,
    nodeId: input.nodeId,
    captureHash: input.captureHash,
    actionKind: action.kind,
    actionId: action.id,
  };
}

function validatePageAnnotation(value: unknown): PageAnnotationInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Page annotation object required");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "pageId",
    "decision",
    "pageTypes",
    "contentKinds",
    "comment",
    "clientRequestId",
    "captureHash",
    "supersedes",
    "modelSuggestionId",
    "modelReview",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new HttpError(400, "Unknown page annotation field");
  const string = (key: string, pattern: RegExp, required = true, maximum = 500) => {
    const item = input[key];
    if (item === undefined && !required) return undefined;
    if (typeof item !== "string" || item.length > maximum || !pattern.test(item))
      throw new HttpError(400, `Invalid ${key}`);
    return item;
  };
  const array = <T extends string>(key: string, allowedValues: readonly T[]) => {
    const item = input[key];
    if (item === undefined) return undefined;
    if (
      !Array.isArray(item) ||
      item.length > allowedValues.length ||
      item.some((entry) => typeof entry !== "string" || !allowedValues.includes(entry as T))
    )
      throw new HttpError(400, `Invalid ${key}`);
    const labels = [...new Set(item)] as T[];
    if (labels.length !== item.length || (labels.includes("unknown" as T) && labels.length !== 1))
      throw new HttpError(400, `${key} must be unique and unknown must stand alone`);
    return labels;
  };
  const pageId = string("pageId", /^page_[a-f0-9]{24}$/, true, 30)!;
  const decision = string("decision", /^(label|unsure)$/, true, 10)!;
  const pageTypes = array("pageTypes", PAGE_TYPES);
  const contentKinds = array("contentKinds", CONTENT_KINDS);
  const comment = string("comment", /^[\s\S]*$/, false, 800);
  const clientRequestId = string("clientRequestId", /^[A-Za-z0-9_-]{8,128}$/, true, 128)!;
  const captureHash = string("captureHash", /^sha256:[a-f0-9]{64}$/, false, 71);
  const supersedes = string("supersedes", /^pann_[0-9a-f-]{36}$/, false, 41);
  const modelSuggestionId = string("modelSuggestionId", /^msug_[0-9a-f-]{36}$/, false, 41);
  const modelReview = string("modelReview", /^(accept|correct|reject)$/, false, 10);
  if ((modelSuggestionId === undefined) !== (modelReview === undefined))
    throw new HttpError(400, "modelSuggestionId and modelReview must be supplied together");
  if (decision === "label" && !(pageTypes?.length || contentKinds?.length))
    throw new HttpError(400, "Page labels need a page type or content kind");
  if (decision === "unsure" && (pageTypes?.length || contentKinds?.length))
    throw new HttpError(400, "Unsure page decisions cannot carry labels");
  return {
    pageId,
    decision: decision as PageAnnotationInput["decision"],
    pageTypes: pageTypes as PageAnnotationInput["pageTypes"],
    contentKinds: contentKinds as PageAnnotationInput["contentKinds"],
    comment,
    clientRequestId,
    captureHash,
    supersedes,
    modelSuggestionId,
    modelReview: modelReview as PageAnnotationInput["modelReview"],
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function jsonlRecords(value: string): unknown[] {
  return value
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function staticResponse(staticDir: string, filename: string) {
  try {
    const extension = filename.slice(filename.lastIndexOf("."));
    return new Response(readFileSync(join(staticDir, filename)), {
      headers: {
        "content-type": staticTypes[extension]!,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return json({ error: "Labeler interface is not installed yet" }, 503);
  }
}

if (import.meta.main) {
  const store = new LabelStore(process.env.LABELER_DATA_DIR ?? DEFAULT_DATA_DIR, cohortsFromEnv());
  if (process.argv[2] === "capture") {
    const pages = await captureSeedPages(store);
    console.log(`Captured ${pages.length} fixed public pages in ${store.dataDir}`);
  } else {
    const server = createLabelerServer();
    console.log(`DOM labeler listening at ${server.url}`);
  }
}
