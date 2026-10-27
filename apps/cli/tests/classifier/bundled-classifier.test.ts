// The bundled page classifier (#2307): the embedded artifact is the one its manifest names, it
// loads lazily and once, and `self doctor` reports it.

import { FEATURIZER_VERSION } from "@squirrelscan/page-classifier";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  classifierInfo,
  isClassifierLoaded,
  loadBundledClassifier,
  resetBundledClassifier,
} from "../../src/classifier";
import {
  BUNDLED_ARTIFACT_MANIFEST,
  BUNDLED_ARTIFACT_PATH,
} from "../../src/classifier/artifact";
import { checkClassifier } from "../../src/classifier/doctor";

describe("bundled artifact", () => {
  test("the embedded file is the one the manifest names", () => {
    const bytes = readFileSync(BUNDLED_ARTIFACT_PATH);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      BUNDLED_ARTIFACT_MANIFEST.sha256
    );
    expect(bytes.length).toBe(BUNDLED_ARTIFACT_MANIFEST.bytes);
  });

  test("it is built for the featurizer this build carries", () => {
    expect(BUNDLED_ARTIFACT_MANIFEST.featurizerVersion).toBe(
      FEATURIZER_VERSION
    );
  });
});

describe("lazy load", () => {
  test("nothing is read until asked, and the model loads once", () => {
    resetBundledClassifier();
    expect(isClassifierLoaded()).toBe(false);
    const first = loadBundledClassifier();
    expect(isClassifierLoaded()).toBe(true);
    expect(first.model).not.toBeNull();
    expect(first.reason).toBe("");
    expect(loadBundledClassifier()).toBe(first);
    const info = classifierInfo();
    expect(info.loaded).toBe(true);
    expect(info.featurizerVersion).toBe(info.artifactFeaturizerVersion);
    expect(info.loadMs).toBeGreaterThan(0);
  });
});

describe("doctor check", () => {
  test("passes with version, featurizer and load time", () => {
    const check = checkClassifier();
    expect(check.status).toBe("pass");
    expect(check.message).toContain(`featurizer ${FEATURIZER_VERSION}`);
    expect(check.message).toContain(
      BUNDLED_ARTIFACT_MANIFEST.sha256.slice(0, 12)
    );
    expect(check.message).toMatch(/loaded in \d+ ms/);
  });

  test("warns when the model cannot be used", () => {
    const base = classifierInfo();
    const unloaded = checkClassifier({
      info: () => ({ ...base, loaded: false, reason: "bad" }),
    });
    expect(unloaded.status).toBe("warn");
    expect(unloaded.message).toContain("bad");
    const stale = checkClassifier({
      info: () => ({ ...base, artifactFeaturizerVersion: "v0.0.1" }),
    });
    expect(stale.status).toBe("warn");
    expect(stale.message).toContain("v0.0.1");
  });
});
