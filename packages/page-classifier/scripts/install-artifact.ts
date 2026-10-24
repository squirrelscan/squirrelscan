// Install a release artifact: `bun run scripts/install-artifact.ts <artifact.json>`.
//
// Keeps only the allowed keys (see src/artifact-shape.ts), writes assets/classifier-v2.json
// compact, and rewrites the manifest with its sha256, size and featurizer version. Refuses a file
// that does not load or still holds a stray string after the strip.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findStrayStrings } from "../src/artifact-shape";
import { tryLoadModel } from "../src/predict";

const source = process.argv[2];
if (!source) throw new Error("usage: install-artifact.ts <artifact.json>");

const assets = join(import.meta.dir, "../assets");
const json = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;

// Metadata the exporter may record (label sources, notes) is dropped; the shape check then proves
// nothing else is left.
const KEEP = new Set([
  "format",
  "artifactVersion",
  "featurizerVersion",
  "nodeFeatureCount",
  "pageFeatureCount",
  "tokenBuckets",
  "region",
  "pageType",
  "section",
]);
const clean = Object.fromEntries(Object.entries(json).filter(([key]) => KEEP.has(key)));
for (const head of ["region", "pageType", "section"] as const) {
  const value = clean[head] as Record<string, unknown> | undefined;
  if (!value) continue;
  clean[head] = Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      [
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
      ].includes(key),
    ),
  );
}

const stray = findStrayStrings(clean);
if (stray.length > 0) throw new Error(`artifact holds disallowed strings: ${stray.join(", ")}`);
const { model, reason } = tryLoadModel(clean);
if (!model) throw new Error(`artifact does not load: ${reason}`);

const text = JSON.stringify(clean);
writeFileSync(join(assets, "classifier-v2.json"), text);
const manifest = {
  file: "classifier-v2.json",
  sha256: createHash("sha256").update(text).digest("hex"),
  bytes: Buffer.byteLength(text),
  format: clean.format,
  artifactVersion: clean.artifactVersion,
  featurizerVersion: clean.featurizerVersion,
  heads: ["region", "pageType", "section"].filter((head) => clean[head] !== undefined),
};
writeFileSync(join(assets, "classifier-v2.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(manifest);
