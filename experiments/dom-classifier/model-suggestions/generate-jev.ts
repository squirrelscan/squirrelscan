#!/usr/bin/env bun
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  buildRequest,
  createHttpTransport,
  evaluatePage,
  snapshotHashForState,
  toModelSuggestionRows,
  PROMPT_REVISION,
} from "./jev-adapter.ts";
import type { CapturedPage } from "../labeler/types.ts";

const configuredRoot = process.env.DOM_CLASSIFIER_DATA_ROOT?.trim();
if (!configuredRoot)
  throw new Error("DOM_CLASSIFIER_DATA_ROOT must point to the private model-data root");
const PRIVATE_ROOT = resolve(configuredRoot);

function privatePath(raw: string, output = false): string {
  const path = resolve(raw);
  if (!path.startsWith(`${PRIVATE_ROOT}/`)) {
    throw new Error(`${output ? "output" : "input"} must be under ${PRIVATE_ROOT}`);
  }
  return path;
}

function argument(name: string, fallback?: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${name}`);
  }
  const value = Bun.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function filesAt(input: string): string[] {
  if (statSync(input).isFile()) return [input];
  return readdirSync(input)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(input, name));
}

const input = privatePath(argument("--input"));
const output = privatePath(argument("--output"), true);
const limit = Number(argument("--limit", "3"));
const maxCandidates = Number(argument("--max-candidates", "10"));
if (!Number.isInteger(limit) || limit < 1 || limit > 200)
  throw new Error("--limit must be an integer between 1 and 200");
if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 50)
  throw new Error("--max-candidates must be 1..50");
const files = filesAt(input).slice(0, limit || undefined);
if (!files.length) throw new Error("no capture JSON files found");
mkdirSync(resolve(output, ".."), { recursive: true, mode: 0o700 });
const existing = existsSync(output)
  ? readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
  : [];
const groupKey = (row: {
  pageId?: string;
  captureHash?: string;
  snapshotHash?: string;
  promptRevision?: string;
  modelId?: string;
  modelRevision?: string;
}) =>
  `${row.pageId ?? ""}:${row.captureHash ?? ""}:${row.snapshotHash ?? ""}:${row.promptRevision ?? ""}:${row.modelId ?? ""}:${row.modelRevision ?? ""}`;
const existingGroups = new Map<string, Set<string>>();
for (const row of existing) {
  const key = groupKey(row);
  const ids = existingGroups.get(key) ?? new Set<string>();
  ids.add(row.nodeId === null ? "__page__" : String(row.nodeId));
  existingGroups.set(key, ids);
}
const transport = createHttpTransport();
let skipped = 0;
let written = 0;
const failures: Array<{ pageId: string; kind: string }> = [];
for (const [index, path] of files.entries()) {
  const page = JSON.parse(readFileSync(path, "utf8")) as CapturedPage;
  const request = buildRequest(page, maxCandidates);
  const snapshotHash = snapshotHashForState(request.state);
  const expectedKey = `${page.id}:${page.captureHash}:${snapshotHash}:${PROMPT_REVISION}:${request.model}:${request.model}`;
  const expectedIds = new Set([
    "__page__",
    ...request.state.candidates.map((candidate) => candidate.nodeId),
  ]);
  const storedIds = existingGroups.get(expectedKey);
  if (
    storedIds &&
    storedIds.size === expectedIds.size &&
    [...expectedIds].every((id) => storedIds.has(id))
  ) {
    skipped++;
    console.log(
      JSON.stringify({
        status: "skipped",
        page: index + 1,
        total: files.length,
        pageId: page.id,
        skipped,
        rowsWritten: written,
        failed: failures.length,
      }),
    );
    continue;
  }
  let evaluation;
  try {
    let error: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        evaluation = await evaluatePage(page, transport, maxCandidates);
        error = undefined;
        break;
      } catch (caught) {
        error = caught;
        if (attempt === 0) await Bun.sleep(250);
      }
    }
    if (!evaluation) throw error ?? new Error("evaluation failed");
  } catch (error) {
    failures.push({
      pageId: page.id,
      kind:
        error instanceof Error && /HTTP 401/.test(error.message) ? "authentication" : "evaluation",
    });
    console.log(
      JSON.stringify({
        status: "failed",
        page: index + 1,
        total: files.length,
        pageId: page.id,
        skipped,
        rowsWritten: written,
        failed: failures.length,
      }),
    );
    continue;
  }
  const rows = toModelSuggestionRows(page, evaluation, { noul: 0.75, choice: 0.75 });
  for (const row of rows) if (row.nodeId !== null) delete row.usage;
  appendFileSync(output, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
  written += rows.length;
  console.log(
    JSON.stringify({
      status: "captured",
      page: index + 1,
      total: files.length,
      pageId: page.id,
      skipped,
      rowsWritten: written,
      failed: failures.length,
    }),
  );
}
console.log(
  JSON.stringify({
    inputFiles: files.length,
    skipped,
    rowsWritten: written,
    failed: failures.length,
    failures,
    output,
  }),
);
