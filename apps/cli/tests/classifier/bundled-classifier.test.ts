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
  loadClassifierFromBytes,
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

describe("runtime hash check", () => {
  const bytes = readFileSync(BUNDLED_ARTIFACT_PATH);

  test("a matching artifact loads and reports the hash of the bytes read", () => {
    const result = loadClassifierFromBytes(bytes, BUNDLED_ARTIFACT_MANIFEST);
    expect(result.hashMatches).toBe(true);
    expect(result.model).not.toBeNull();
    expect(result.loadedSha256).toBe(BUNDLED_ARTIFACT_MANIFEST.sha256);
    expect(result.loadedBytes).toBe(bytes.length);
  });

  test("a flipped byte falls back to no classifier", () => {
    const flipped = Buffer.from(bytes);
    flipped[1000] ^= 0x01;
    const result = loadClassifierFromBytes(flipped, BUNDLED_ARTIFACT_MANIFEST);
    expect(result.hashMatches).toBe(false);
    expect(result.model).toBeNull();
    expect(result.reason).toContain("does not match its manifest");
    expect(result.loadedSha256).not.toBe(BUNDLED_ARTIFACT_MANIFEST.sha256);
  });

  test("doctor fails on a mismatch and prints the loaded hash", () => {
    const flipped = Buffer.from(bytes);
    flipped[1000] ^= 0x01;
    const r = loadClassifierFromBytes(flipped, BUNDLED_ARTIFACT_MANIFEST);
    const base = classifierInfo();
    const check = checkClassifier({
      info: () => ({
        ...base,
        loaded: false,
        loadedSha256: r.loadedSha256,
        loadedBytes: r.loadedBytes,
        hashMatches: false,
      }),
    });
    expect(check.status).toBe("fail");
    expect(check.message).toContain(r.loadedSha256.slice(0, 12));
  });

  test("hash cost is small next to the load", () => {
    const { createHash: hash } =
      require("node:crypto") as typeof import("node:crypto");
    const t0 = performance.now();
    hash("sha256").update(bytes).digest("hex");
    const hashMs = performance.now() - t0;
    resetBundledClassifier();
    const loadMs = loadBundledClassifier().loadMs;
    expect(hashMs).toBeLessThan(loadMs);
  });
});
