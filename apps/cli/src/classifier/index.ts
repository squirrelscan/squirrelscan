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
import { readFileSync } from "node:fs";

import { logger } from "@/utils/logger";

import { BUNDLED_ARTIFACT_MANIFEST, BUNDLED_ARTIFACT_PATH } from "./artifact";

export interface LoadedClassifier {
  /** The parsed model, or null when the bundled artifact could not be used. */
  model: Model | null;
  /** Why `model` is null; "" when it loaded. */
  reason: string;
  /** Read + JSON parse + tree decode, in milliseconds. */
  loadMs: number;
}

let loaded: LoadedClassifier | undefined;

/** Load the bundled model once; later calls return the same result. Never throws. */
export function loadBundledClassifier(): LoadedClassifier {
  if (loaded) return loaded;
  const started = performance.now();
  try {
    const { model, reason } = tryLoadModel(
      JSON.parse(readFileSync(BUNDLED_ARTIFACT_PATH, "utf8"))
    );
    loaded = { model, reason, loadMs: performance.now() - started };
  } catch (error) {
    loaded = {
      model: null,
      reason: `artifact unreadable: ${error instanceof Error ? error.message : String(error)}`,
      loadMs: performance.now() - started,
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
  loaded: boolean;
  loadMs: number;
  reason: string;
}

/** Version and load time of the bundled artifact. Forces the load, which is the point. */
export function classifierInfo(): ClassifierInfo {
  const { model, reason, loadMs } = loadBundledClassifier();
  return {
    artifactVersion: BUNDLED_ARTIFACT_MANIFEST.artifactVersion,
    artifactSha256: BUNDLED_ARTIFACT_MANIFEST.sha256,
    artifactBytes: BUNDLED_ARTIFACT_MANIFEST.bytes,
    featurizerVersion: FEATURIZER_VERSION,
    artifactFeaturizerVersion: BUNDLED_ARTIFACT_MANIFEST.featurizerVersion,
    heads: BUNDLED_ARTIFACT_MANIFEST.heads,
    loaded: model !== null,
    loadMs,
    reason,
  };
}
