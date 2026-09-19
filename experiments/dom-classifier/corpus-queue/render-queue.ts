#!/usr/bin/env bun
/**
 * Render a bounded private manifest of public URLs into a staging LabelStore.
 * This is a command-line only importer; the localhost labeler has no route to
 * trigger it or submit URLs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  captureCorpusTarget,
  MAX_CAPTURE_HEIGHT,
  MAX_CAPTURE_TIMEOUT_MS,
  MAX_LAZY_LOAD_STEPS,
  normalizeCorpusCaptureTarget,
  pngDimensions,
  type CorpusCaptureTarget,
} from "../labeler/capture.ts";
import { LabelStore } from "../labeler/store.ts";

type Arguments = {
  manifest: string;
  stage: string;
  limit: number;
  concurrency: number;
};

type AttemptSummary = {
  requested: number;
  alreadyCaptured: number;
  deferred: number;
  attempted: number;
  captured: number;
  failed: number;
  finishedAt: string;
};

const MAX_TARGETS = 200;
const MAX_CONCURRENCY = 4;

function usage() {
  return [
    "Usage: bun render-queue.ts --manifest /private/queue.jsonl --stage /private/stage [--limit 200] [--concurrency 4]",
    "Manifest is JSONL. Each row is exactly {url,originalCrawledAt?,corpusRef?}.",
  ].join("\n");
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !["--manifest", "--stage", "--limit", "--concurrency"].includes(flag))
      throw new Error(usage());
    if (values.has(flag)) throw new Error(`Duplicate ${flag}`);
    values.set(flag, value);
  }
  const manifest = values.get("--manifest");
  const stage = values.get("--stage");
  if (!manifest || !stage) throw new Error(usage());
  const integer = (flag: "--limit" | "--concurrency", fallback: number, maximum: number) => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${flag}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error(`Invalid ${flag}`);
    return value;
  };
  return {
    manifest: resolve(manifest),
    stage: resolve(stage),
    limit: integer("--limit", MAX_TARGETS, MAX_TARGETS),
    concurrency: integer("--concurrency", MAX_CONCURRENCY, MAX_CONCURRENCY),
  };
}

function readManifest(path: string) {
  if (!existsSync(path)) throw new Error(`Manifest does not exist: ${path}`);
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (rows.length > MAX_TARGETS)
    throw new Error(`Manifest exceeds the ${MAX_TARGETS} target limit`);
  const seen = new Set<string>();
  return rows.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Manifest row ${index + 1} is not JSON`);
    }
    const target = normalizeCorpusCaptureTarget(value);
    if (seen.has(target.url)) throw new Error(`Manifest has duplicate URL: ${target.url}`);
    seen.add(target.url);
    return target;
  });
}

function successfullyStagedUrls(store: LabelStore) {
  const captured = new Set<string>();
  if (!existsSync(store.capturesDir)) return captured;
  for (const name of store.listPages()) {
    try {
      const page = store.readPage(name.id);
      const dimensions = pngDimensions(readFileSync(store.screenshotPath(page.id)));
      if (
        page.sourceKind !== "fresh_capture" ||
        typeof page.sourceUrl !== "string" ||
        dimensions.width !== page.width ||
        dimensions.height !== page.height ||
        dimensions.height > MAX_CAPTURE_HEIGHT ||
        page.documentHeight === undefined ||
        page.height !== Math.min(MAX_CAPTURE_HEIGHT, Math.ceil(page.documentHeight)) ||
        page.heightCapped !== (page.documentHeight > page.height) ||
        (page.renderSettled !== "networkidle" && page.renderSettled !== "bounded_timeout")
      )
        continue;
      captured.add(normalizeCorpusCaptureTarget({ url: page.sourceUrl }).url);
    } catch {
      // A partial or mismatched capture must be retried, never treated as complete.
    }
  }
  return captured;
}

function hostKey(target: CorpusCaptureTarget) {
  return new URL(target.url).hostname.toLowerCase();
}

async function renderOne(store: LabelStore, target: CorpusCaptureTarget) {
  try {
    const page = await captureCorpusTarget(store, target, {
      maxHeight: MAX_CAPTURE_HEIGHT,
      maxLazyLoadSteps: MAX_LAZY_LOAD_STEPS,
      timeoutMs: MAX_CAPTURE_TIMEOUT_MS,
    });
    store.recordCaptureAttempt(target.url, "captured", null);
    console.log(JSON.stringify({ status: "captured", url: target.url, pageId: page.id }));
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown capture error";
    store.recordCaptureAttempt(target.url, "failed", reason);
    console.warn(JSON.stringify({ status: "failed", url: target.url, reason }));
    return false;
  }
}

async function renderQueue(args: Arguments) {
  const targets = readManifest(args.manifest);
  const store = new LabelStore(args.stage);
  store.ensureDirectories();
  const done = successfullyStagedUrls(store);
  const notCaptured = targets.filter((target) => !done.has(target.url));
  const pending = notCaptured.slice(0, args.limit);
  const summary: AttemptSummary = {
    requested: targets.length,
    alreadyCaptured: targets.length - notCaptured.length,
    deferred: notCaptured.length - pending.length,
    attempted: pending.length,
    captured: 0,
    failed: 0,
    finishedAt: "",
  };
  const active = new Map<Promise<void>, string>();
  const activeHosts = new Set<string>();
  const waiting = [...pending];
  while (waiting.length || active.size) {
    while (active.size < args.concurrency) {
      const nextIndex = waiting.findIndex((target) => !activeHosts.has(hostKey(target)));
      if (nextIndex === -1) break;
      const [target] = waiting.splice(nextIndex, 1);
      if (!target) break;
      const host = hostKey(target);
      activeHosts.add(host);
      let task: Promise<void>;
      task = renderOne(store, target)
        .then((captured) => {
          if (captured) summary.captured += 1;
          else summary.failed += 1;
        })
        .finally(() => {
          active.delete(task);
          activeHosts.delete(host);
        });
      active.set(task, host);
    }
    if (active.size) await Promise.race(active.keys());
    else if (waiting.length) throw new Error("Queue scheduler could not select a public hostname");
  }
  summary.finishedAt = new Date().toISOString();
  writeFileSync(join(args.stage, "render-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ status: "finished", ...summary }));
}

if (import.meta.main) {
  try {
    await renderQueue(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Queue failed");
    process.exitCode = 1;
  }
}

export { parseArguments, readManifest, renderQueue };
