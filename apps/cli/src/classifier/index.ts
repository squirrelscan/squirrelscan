// The page classifier as the CLI uses it (#2307): the lazily loaded bundled model. The hook the
// parser calls once per page is in ./hook.ts.
//
// Nothing here runs at import: the artifact is read on the first `loadBundledClassifier()` (the
// first classified page, or `self doctor`), never on startup.

import {
  FEATURIZER_VERSION,
  tryLoadModel,
  type Model,
} from "@squirrelscan/page-classifier";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { logger } from "@/utils/logger";

import { BUNDLED_ARTIFACT_MANIFEST, BUNDLED_ARTIFACT_PATH } from "./artifact";

export interface LoadedClassifier {
  /** The parsed model, or null when the bundled artifact could not be used. */
  model: Model | null;
  /** Why `model` is null; "" when it loaded. */
  reason: string;
  /** Read + sha256 + JSON parse + tree decode, in milliseconds. */
  loadMs: number;
  /** sha256 of the bytes actually read; "" when the file could not be read. */
  loadedSha256: string;
  /** Size of the bytes actually read; 0 when the file could not be read. */
  loadedBytes: number;
  /** Whether the bytes read match the manifest's sha256 and size. */
  hashMatches: boolean;
}

let loaded: LoadedClassifier | undefined;

/**
 * Hash the bytes, compare them to the manifest, and only then parse. A mismatch means no model
 * (the page classifier is an optional layer; the rules answer without it). Never throws.
 */
export function loadClassifierFromBytes(
  bytes: Uint8Array,
  manifest: { sha256: string; bytes: number },
  started: number = performance.now()
): LoadedClassifier {
  const loadedSha256 = createHash("sha256").update(bytes).digest("hex");
  const hashMatches =
    loadedSha256 === manifest.sha256 && bytes.byteLength === manifest.bytes;
  const base = { loadedSha256, loadedBytes: bytes.byteLength, hashMatches };
  if (!hashMatches) {
    return {
      ...base,
      model: null,
      reason: `artifact does not match its manifest (sha256 ${loadedSha256.slice(0, 12)}, expected ${manifest.sha256.slice(0, 12)})`,
      loadMs: performance.now() - started,
    };
  }
  try {
    const { model, reason } = tryLoadModel(
      JSON.parse(Buffer.from(bytes).toString("utf8"))
    );
    return { ...base, model, reason, loadMs: performance.now() - started };
  } catch (error) {
    return {
      ...base,
      model: null,
      reason: `artifact unreadable: ${error instanceof Error ? error.message : String(error)}`,
      loadMs: performance.now() - started,
    };
  }
}

/** Load the bundled model once; later calls return the same result. Never throws. */
export function loadBundledClassifier(): LoadedClassifier {
  if (loaded) return loaded;
  const started = performance.now();
  try {
    loaded = loadClassifierFromBytes(
      readFileSync(BUNDLED_ARTIFACT_PATH),
      BUNDLED_ARTIFACT_MANIFEST,
      started
    );
  } catch (error) {
    loaded = {
      model: null,
      reason: `artifact unreadable: ${error instanceof Error ? error.message : String(error)}`,
      loadMs: performance.now() - started,
      loadedSha256: "",
      loadedBytes: 0,
      hashMatches: false,
    };
  }
  if (!loaded.model)
    logger.warn(`page classifier unavailable: ${loaded.reason}`);
  return loaded;
}

/** Whether the model has been read yet. Creating a hook does not read it; classifying a page does. */
export function isClassifierLoaded(): boolean {
  return loaded !== undefined;
}

/** Forget the loaded model (tests only). */
export function resetBundledClassifier(): void {
  loaded = undefined;
}

export interface ClassifierInfo {
  artifactVersion: number;
  artifactSha256: string;
  artifactBytes: number;
  /** The featurizer this build was compiled with. */
  featurizerVersion: string;
  /** The featurizer the artifact was built for; differs from the above only when stale. */
  artifactFeaturizerVersion: string;
  heads: string[];
  /** sha256 of the bytes the loader read, not the manifest's value. */
  loadedSha256: string;
  loadedBytes: number;
  hashMatches: boolean;
  loaded: boolean;
  loadMs: number;
  reason: string;
}

/** Version and load time of the bundled artifact. Forces the load, which is the point. */
export function classifierInfo(): ClassifierInfo {
  const { model, reason, loadMs, loadedSha256, loadedBytes, hashMatches } =
    loadBundledClassifier();
  return {
    artifactVersion: BUNDLED_ARTIFACT_MANIFEST.artifactVersion,
    artifactSha256: BUNDLED_ARTIFACT_MANIFEST.sha256,
    artifactBytes: BUNDLED_ARTIFACT_MANIFEST.bytes,
    featurizerVersion: FEATURIZER_VERSION,
    artifactFeaturizerVersion: BUNDLED_ARTIFACT_MANIFEST.featurizerVersion,
    heads: BUNDLED_ARTIFACT_MANIFEST.heads,
    loadedSha256,
    loadedBytes,
    hashMatches,
    loaded: model !== null,
    loadMs,
    reason,
  };
}
