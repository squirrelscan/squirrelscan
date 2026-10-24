// What an artifact may contain, as a checkable list (a release gate, not a runtime check).
//
// An artifact is weights and thresholds. Tokens are hashed into buckets before scoring, so no
// vocabulary is stored: the only strings are the format name, the featurizer version, class
// names, extra-feature names and the base64 tree blocks. Anything else (a label-source note, a
// token list, a path) would be a leak, and `findStrayStrings` names it.

import { ARTIFACT_FORMAT } from "./model-format";

const HEADS = ["region", "pageType", "section"] as const;

const TOP_KEYS = new Set([
  "format",
  "artifactVersion",
  "featurizerVersion",
  "nodeFeatureCount",
  "pageFeatureCount",
  "tokenBuckets",
  ...HEADS,
]);

const HEAD_KEYS = new Set([
  "classes",
  "featureColumns",
  "confidenceThreshold",
  "classThresholds",
  "numClass",
  "numTrees",
  "extraFeatureNames",
  "platformClassThresholds",
  "tokenStreams",
  "trees",
]);

/** The node token streams a head may declare it reads (see model-format.ts). */
const TOKEN_STREAMS = new Set(["classid", "text"]);

const IDENT = /^[a-z][a-z0-9_]{0,63}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
// Base64 of a tree block, which starts with the "SQDC" magic (U1FEQ).
const TREE_BLOCK = /^U1FEQ[A-Za-z0-9+/]*={0,2}$/;

/** Every string, key or value, in the artifact that the shape does not allow. */
export function findStrayStrings(artifact: unknown): string[] {
  const stray: string[] = [];
  const top = artifact as Record<string, unknown>;
  for (const key of Object.keys(top)) if (!TOP_KEYS.has(key)) stray.push(`key ${key}`);
  if (top.format !== ARTIFACT_FORMAT) stray.push("format value");
  if (typeof top.featurizerVersion !== "string" || !VERSION.test(top.featurizerVersion)) {
    stray.push("featurizerVersion value");
  }
  for (const name of HEADS) {
    const head = top[name] as Record<string, unknown> | undefined;
    if (head === undefined) continue;
    for (const key of Object.keys(head)) if (!HEAD_KEYS.has(key)) stray.push(`${name}.${key} key`);
    for (const cls of (head.classes as unknown[]) ?? []) {
      if (typeof cls !== "string" || !IDENT.test(cls)) stray.push(`${name}.classes entry`);
    }
    for (const feature of (head.extraFeatureNames as unknown[] | undefined) ?? []) {
      if (typeof feature !== "string" || !IDENT.test(feature)) {
        stray.push(`${name}.extraFeatureNames entry`);
      }
    }
    const overrides = (head.platformClassThresholds ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [platform, classes] of Object.entries(overrides)) {
      if (!IDENT.test(platform)) stray.push(`${name}.platformClassThresholds platform`);
      for (const [cls, value] of Object.entries(classes)) {
        if (!IDENT.test(cls) || typeof value !== "number") stray.push(`${name}.platform class`);
      }
    }
    for (const stream of (head.tokenStreams as unknown[] | undefined) ?? []) {
      if (typeof stream !== "string" || !TOKEN_STREAMS.has(stream)) {
        stray.push(`${name}.tokenStreams entry`);
      }
    }
    if (typeof head.trees !== "string" || !TREE_BLOCK.test(head.trees)) {
      stray.push(`${name}.trees value`);
    }
  }
  return stray;
}
