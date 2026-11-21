// The bundled artifact is weights and thresholds only: no vocabulary, no label notes, no paths.
// The check also guards every future artifact swap, since the shape is an allowlist.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  findAssetLayoutProblems,
  findStrayStrings,
  findTopologyProblems,
} from "../src/artifact-shape";

const ASSETS = join(import.meta.dir, "../assets");
const ARTIFACT = join(ASSETS, "classifier-v2.json");
const MANIFEST = join(ASSETS, "classifier-v2.manifest.json");

describe("findStrayStrings", () => {
  const valid = {
    format: "squirrel-dom-classifier",
    artifactVersion: 1,
    featurizerVersion: "v2.2.0",
    region: { classes: ["footer"], trees: "U1FEQwEAAAA=", numClass: 1 },
  };

  test("accepts the expected shape", () => {
    expect(findStrayStrings(valid)).toEqual([]);
  });

  test("names a label-source note, a token list, a path and a wrong format", () => {
    expect(
      findStrayStrings({ ...valid, pageTypeLabelSource: "vendor v8" })
    ).toEqual(["key pageTypeLabelSource"]);
    expect(
      findStrayStrings({
        ...valid,
        region: { ...valid.region, vocab: ["checkout", "cart"] },
      })
    ).toEqual(["region.vocab key"]);
    expect(
      findStrayStrings({
        ...valid,
        region: { ...valid.region, classes: ["/srv/x/data"] },
      })
    ).toEqual(["region.classes entry"]);
    expect(findStrayStrings({ ...valid, format: "other" })).toEqual([
      "format value",
    ]);
    expect(
      findStrayStrings({
        ...valid,
        region: { ...valid.region, trees: "some page words" },
      })
    ).toEqual(["region.trees value"]);
    expect(
      findStrayStrings({
        ...valid,
        region: { ...valid.region, tokenStreams: ["classid", "page text"] },
      })
    ).toEqual(["region.tokenStreams entry"]);
    expect(
      findStrayStrings({
        ...valid,
        region: { ...valid.region, tokenStreams: ["classid", "text"] },
      })
    ).toEqual([]);
  });
});

describe.if(existsSync(ARTIFACT))("the bundled artifact", () => {
  const text = readFileSync(ARTIFACT, "utf8");

  test("holds no string beyond the allowed shape", () => {
    expect(findStrayStrings(JSON.parse(text))).toEqual([]);
  });

  test("matches its manifest", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      sha256: string;
      bytes: number;
      featurizerVersion: string;
    };
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      manifest.sha256
    );
    expect(Buffer.byteLength(text)).toBe(manifest.bytes);
    expect(JSON.parse(text).featurizerVersion).toBe(manifest.featurizerVersion);
  });
});

describe("install topology", () => {
  const head = {
    classes: ["a", "b"],
    numClass: 2,
    classThresholds: [0.5, 0.5],
    trees: "U1FEQw==",
  };
  const good = { region: head, pageType: head, section: head };

  test("accepts all three heads, consistent", () => {
    expect(findTopologyProblems(good)).toEqual([]);
    if (existsSync(ARTIFACT)) {
      expect(
        findTopologyProblems(JSON.parse(readFileSync(ARTIFACT, "utf8")))
      ).toEqual([]);
    }
  });

  test("rejects a missing head and inconsistent counts", () => {
    expect(findTopologyProblems({ region: head, pageType: head })).toEqual([
      "section head missing",
    ]);
    expect(
      findTopologyProblems({ ...good, region: { ...head, numClass: 3 } })
    ).toEqual(["region.numClass does not match classes"]);
    expect(
      findTopologyProblems({
        ...good,
        pageType: { ...head, classThresholds: [0.5] },
      })
    ).toEqual(["pageType.classThresholds length does not match classes"]);
  });

  test("rejects stray files in assets/", () => {
    expect(
      findAssetLayoutProblems([
        "classifier-v2.json",
        "classifier-v2.manifest.json",
      ])
    ).toEqual([]);
    expect(findAssetLayoutProblems(["classifier-v2.json", "old.json"])).toEqual(
      ["unexpected file old.json"]
    );
  });
});
