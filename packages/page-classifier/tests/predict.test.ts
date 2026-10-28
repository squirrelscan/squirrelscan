// The artifact has to load and fit, and the fallback has to produce the same shape as the model.
//
// These tests read the artifact bundled with this package (assets/classifier-v2.json) and skip
// the real-artifact blocks when it is absent. Parity against the training-side reference
// implementation is checked where the model is trained, not here.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ArtifactError,
  loadModel,
  scoreRow,
  scoreRows,
  softmax,
  thresholdsFor,
} from "../src/model-format";
import {
  featurizeDocument,
  FEATURIZER_VERSION,
  NODE_FEATURE_NAMES,
  PAGE_FEATURE_NAMES,
  TOKEN_BUCKETS,
  tokenBucket,
} from "../src/featurize";
import {
  classifyPage,
  selectPageType,
  toVector,
  tryLoadModel,
  withExtraBlock,
} from "../src/predict";
import { isRootPath } from "../src/rules-fallback";
import { parseHTML } from "@squirrelscan/parser/dom";

const ARTIFACT = join(import.meta.dir, "../assets/classifier-v2.json");
const HAS_ARTIFACT = existsSync(ARTIFACT);

const PAGE = `<!doctype html><html lang="en"><head><title>How we test crawlers</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"x"}</script>
</head><body class="single-post">
  <header class="site-header"><nav><a href="/">Home</a> <a href="/archive">Archive</a></nav></header>
  <main><article><header class="entry-header"><h1>How we test crawlers</h1>
    <p>By Ada Lovelace</p></header>
    <p>The first thing a crawler has to get right is the queue, and the queue is harder
      than it looks once redirects are involved.</p>
    <p>We keep a fixture site with every shape we have seen in the wild.</p></article></main>
  <aside class="sidebar"><h2>Elsewhere</h2><ul><li><a href="/blog">Blog</a></li></ul></aside>
  <footer class="site-footer"><p>&copy; 2026 Example Journal, all rights reserved.</p></footer>
</body></html>`;

const URL = "https://example.com/blog/how-we-test-crawlers";

describe("the rules path, with no model at all", () => {
  test("produces the full contract and says why it degraded", () => {
    const out = classifyPage(PAGE, URL);
    expect(out.degraded).toBe("no model artifact");
    expect(out.pageType).toEqual({ label: "article", confidence: 1, source: "rules" });
    expect(out.nodes.length).toBeGreaterThan(4);
    for (const node of out.nodes) {
      expect(node.source).toBe("rules");
      expect(typeof node.label).toBe("string");
      expect(node.confidence).toBeGreaterThanOrEqual(0);
      expect(node.nodeRef.nodeId).toBeGreaterThanOrEqual(0);
    }
  });

  test("reads the landmarks, including the nested article header", () => {
    const out = classifyPage(PAGE, URL);
    const at = (tag: string, elementId: string) =>
      out.nodes.find((n) => n.nodeRef.tag === tag && n.nodeRef.elementId === elementId) ??
      out.nodes.find((n) => n.nodeRef.tag === tag);
    expect(at("header", "")!.label).toBe("site_header");
    expect(at("footer", "")!.label).toBe("footer");
    expect(at("nav", "")!.label).toBe("navigation");
    expect(at("aside", "")!.label).toBe("sidebar");
    expect(at("main", "")!.label).toBe("main_content");
    // The <header> inside <article> is the article's own chrome.
    const headers = out.nodes.filter((n) => n.nodeRef.tag === "header");
    expect(headers.map((h) => h.label).sort()).toEqual(["article_chrome", "site_header"]);
  });

  test("homepage is a URL rule, and only a rule", () => {
    const home = `<!doctype html><html><head><title>Example</title>
      <script type="application/ld+json">{"@type":"WebSite","name":"Example"}</script>
      </head><body><main><h1>Example</h1><p>We make widgets for people.</p></main></body></html>`;
    const out = classifyPage(home, "https://example.com/");
    expect(out.pageType.label).toBe("homepage");
    expect(out.pageType.source).toBe("rules");
  });

  test("root paths use platform URL parsing (#903)", () => {
    expect(isRootPath("https://example.com")).toBe(true);
    expect(isRootPath("https://example.com/")).toBe(true);
    expect(isRootPath("https://example.com/?a=1")).toBe(true);
    expect(isRootPath("https://example.com/#top")).toBe(true);
    expect(isRootPath("https://example.com/a")).toBe(false);
    expect(isRootPath("https://example.com\\about")).toBe(false);
    expect(isRootPath("https://user@example.com/a")).toBe(false);
    expect(isRootPath("not a URL")).toBe(false);
  });

  test("a page with no structured data and no landmarks is unknown, not a guess", () => {
    const soup = `<!doctype html><html><head><title>T</title></head><body>
      <div class="wrap"><div class="row"><p>Text that makes this a candidate node.</p></div></div>
    </body></html>`;
    const out = classifyPage(soup, "https://example.com/x");
    expect(out.pageType.label).toBe("unknown");
    expect(out.nodes.every((n) => n.label === "unknown")).toBe(true);
  });
});

// A WordPress thread under the article, as the comments rule reads it.
const WITH_COMMENTS = PAGE.replace(
  "</article></main>",
  `</article>
  <div id="comments" class="comments-area"><h2>2 responses</h2><ol class="comment-list">
    <li id="comment-4" class="comment"><article id="div-comment-4" class="comment-body">
      <div class="comment-author"><a rel="external nofollow ugc" href="https://spam.example.org/">Pills</a></div>
      <div class="comment-content"><p>Great post, thanks for sharing it with us.</p></div>
    </article></li></ol></div></main>`,
);

describe("the comments rule in the output ", () => {
  test("lists the thread and labels every node inside it, with no model", () => {
    const elements: unknown[] = [];
    const out = classifyPage(WITH_COMMENTS, URL, { elementsOut: elements });
    expect(out.commentSections).toEqual([
      { nodeId: expect.any(Number), label: "comments", evidence: "comments" },
    ]);
    const thread = elements[out.commentSections[0]!.nodeId] as Element;
    expect(thread.getAttribute("id")).toBe("comments");
    const inside = out.nodes.filter((n) => thread.contains(elements[n.nodeRef.nodeId] as Element));
    expect(inside.length).toBeGreaterThan(0);
    for (const node of inside) {
      expect(node.section).toMatchObject({ label: "comments", confidence: 1, source: "rules" });
    }
    for (const node of out.nodes) if (!inside.includes(node)) expect(node.section).toBeUndefined();
  });

  test("a page without a thread lists none", () => {
    expect(classifyPage(PAGE, URL).commentSections).toEqual([]);
  });
});

describe("artifact validation", () => {
  test("a non-artifact is refused without throwing", () => {
    expect(tryLoadModel({ hello: "world" }).model).toBeNull();
    expect(tryLoadModel({ hello: "world" }).reason).toContain("not a squirrel-dom-classifier");
    expect(tryLoadModel(null).model).toBeNull();
  });

  test("a future artifact version is refused", () => {
    const out = tryLoadModel({ format: "squirrel-dom-classifier", artifactVersion: 99 });
    expect(out.model).toBeNull();
    expect(out.reason).toContain("unsupported artifact version");
  });

  test("loadModel throws ArtifactError, tryLoadModel never throws", () => {
    expect(() => loadModel({ format: "nope" })).toThrow(ArtifactError);
    expect(() => tryLoadModel({ format: "nope" })).not.toThrow();
  });
});

/**
 * One single-split tree, packed by hand in the export_model.py layout:
 * feature 0 <= 0.5 goes to leaf 10, otherwise leaf 20. `flags` = null writes a
 * version-1 block; a number writes version 2 with that per-node flag byte.
 */
function oneSplitHead(flags: number | null, dropFlags = false): Record<string, unknown> {
  const bytes: number[] = [];
  const u32 = (v: number) => bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24);
  const f32 = (v: number) => bytes.push(...new Uint8Array(new Float32Array([v]).buffer));
  const i32 = (v: number) => u32(v >>> 0);
  bytes.push(0x53, 0x51, 0x44, 0x43); // "SQDC"
  u32(flags === null ? 1 : 2);
  u32(1); // numTrees
  u32(1); // numClass
  u32(1); // perTreeInternal
  u32(2); // perTreeLeaves
  bytes.push(0, 0, 0, 0); // feature uint16[1] = 0, padded to 4
  f32(0.5);
  i32(-1); // left -> leaf 0
  i32(-2); // right -> leaf 1
  f32(10);
  f32(20);
  if (flags !== null && !dropFlags) bytes.push(flags);
  const trees = btoa(String.fromCharCode(...bytes));
  return {
    classes: ["only"],
    featureColumns: null,
    confidenceThreshold: 0.5,
    classThresholds: null,
    numClass: 1,
    numTrees: 1,
    trees,
  };
}

function oneSplitModel(flags: number | null, dropFlags = false) {
  const head = oneSplitHead(flags, dropFlags);
  return loadModel({
    format: "squirrel-dom-classifier",
    artifactVersion: 1,
    featurizerVersion: "test",
    nodeFeatureCount: 1,
    pageFeatureCount: 1,
    tokenBuckets: 0,
    region: head,
    pageType: head,
  });
}

function leafFor(flags: number | null, value: number): number {
  const out = new Float32Array(1);
  scoreRow(oneSplitModel(flags).pageType, new Float32Array([value]), out);
  return out[0]!;
}

describe("missing-value splits (tree-block version 2, #2307)", () => {
  test("version 1 walks exactly as before, NaN included", () => {
    expect(leafFor(null, 0.2)).toBe(10);
    expect(leafFor(null, 0.9)).toBe(20);
    expect(leafFor(null, Number.NaN)).toBe(20);
  });

  test("a NaN-missing node sends NaN its default way, and compares everything else", () => {
    const nanLeft = 2 | 4;
    const nanRight = 2;
    expect(leafFor(nanLeft, Number.NaN)).toBe(10);
    expect(leafFor(nanRight, Number.NaN)).toBe(20);
    expect(leafFor(nanLeft, 0.9)).toBe(20);
    expect(leafFor(nanRight, 0.2)).toBe(10);
  });

  test("on a node without missing handling a NaN reads as 0, as in LightGBM", () => {
    expect(leafFor(0, Number.NaN)).toBe(10);
  });

  test("a zero-missing node sends 0 (and NaN, read as 0) its default way", () => {
    const zeroRight = 1;
    expect(leafFor(zeroRight, 0)).toBe(20);
    expect(leafFor(zeroRight, Number.NaN)).toBe(20);
    expect(leafFor(zeroRight, 0.2)).toBe(10);
    expect(leafFor(zeroRight | 4, 0)).toBe(10);
  });

  test("a version-2 block without its flags is truncated, and version 3 is refused", () => {
    expect(() => oneSplitModel(2, true)).toThrow(ArtifactError);
    const head = oneSplitHead(null);
    const bytes = Uint8Array.from(atob(head.trees as string), (c) => c.charCodeAt(0));
    bytes[4] = 3;
    head.trees = btoa(String.fromCharCode(...bytes));
    expect(() =>
      loadModel({
        format: "squirrel-dom-classifier",
        artifactVersion: 1,
        region: head,
        pageType: head,
      }),
    ).toThrow(ArtifactError);
  });

  test("the cross-page block is the caller's values when complete, else missing", () => {
    const base = new Float32Array([1, 2]);
    expect(withExtraBlock(base, 0, null)).toBe(base);
    expect(Array.from(withExtraBlock(base, 2, [3, 4]))).toEqual([1, 2, 3, 4]);
    const absent = withExtraBlock(base, 2, null);
    expect(absent.length).toBe(4);
    expect(Number.isNaN(absent[2]!) && Number.isNaN(absent[3]!)).toBe(true);
    const short = withExtraBlock(base, 2, [3]);
    expect(Number.isNaN(short[2]!)).toBe(true);
  });
});

/**
 * A two-class head whose only split is on one input column: class 1 wins when the column is set, class 0 otherwise. `streams` is the
 * head's declared `tokenStreams` (absent = the class/id stream only).
 */
function columnHead(
  column: number,
  classes: [string, string],
  streams?: string[],
  thresholds: [number, number] = [1.01, 0.5],
): Record<string, unknown> {
  const bytes: number[] = [];
  const u32 = (v: number) => bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24);
  const f32 = (v: number) => bytes.push(...new Uint8Array(new Float32Array([v]).buffer));
  const i32 = (v: number) => u32(v >>> 0);
  bytes.push(0x53, 0x51, 0x44, 0x43); // "SQDC"
  u32(1); // version 1 block
  u32(2); // numTrees: one per class
  u32(2); // numClass
  u32(1); // internal nodes of tree 0
  u32(1); // internal nodes of tree 1
  u32(2); // leaves of tree 0
  u32(2); // leaves of tree 1
  bytes.push(column & 255, column >>> 8, column & 255, column >>> 8); // feature uint16[2]
  f32(0.5);
  f32(0.5);
  i32(-1); // tree 0: left (column not set) -> leaf 0; leaf ids are global across the block
  i32(-3); // tree 1: left -> leaf 2
  i32(-2); // tree 0: right (column set) -> leaf 1
  i32(-4); // tree 1: right -> leaf 3
  f32(5); // class 0: wins when the column is not set
  f32(-5);
  f32(-5); // class 1: wins when it is set
  f32(5);
  return {
    classes,
    featureColumns: null,
    confidenceThreshold: 1.01,
    classThresholds: thresholds,
    numClass: 2,
    numTrees: 2,
    ...(streams ? { tokenStreams: streams } : {}),
    trees: btoa(String.fromCharCode(...bytes)),
  };
}

describe("heads declare the node token streams they read (v2.3.0)", () => {
  // A head that splits on the bucket of `t:subscribe` (an own-text word): only the text stream can set that column. Both scoring paths
  // (row at a time, batched) must give a head exactly the streams it declares: the union when it declares `text`, the class/id stream
  // alone when it declares nothing, which is what the region head and every pre-2.3 head read.
  const COLUMN = NODE_FEATURE_NAMES.length + tokenBucket("t:subscribe");
  const modelWith = (
    section: Record<string, unknown>,
    region: Record<string, unknown> = oneSplitHead(null),
  ) =>
    loadModel({
      format: "squirrel-dom-classifier",
      artifactVersion: 1,
      featurizerVersion: FEATURIZER_VERSION,
      nodeFeatureCount: NODE_FEATURE_NAMES.length,
      pageFeatureCount: PAGE_FEATURE_NAMES.length,
      tokenBuckets: TOKEN_BUCKETS,
      region,
      pageType: oneSplitHead(null),
      section,
    });
  const html = `<!doctype html><html><head><title>T</title></head><body>
    <div class="box">Subscribe to our newsletter today</div><div class="other">Something else entirely, long enough</div>
  </body></html>`;
  const run = (model: ReturnType<typeof loadModel>, batch: number) =>
    classifyPage(html, URL, { model, scoringBatch: batch, budgetMs: 1e9 });

  for (const batch of [1, 32]) {
    test(`scoringBatch ${batch}: a section head declaring the text stream is scored on the union`, () => {
      const out = run(
        modelWith(columnHead(COLUMN, ["none", "newsletter_signup"], ["classid", "text"])),
        batch,
      );
      expect(out.degraded).toBe("");
      const fired = out.nodes.filter((n) => n.section?.source === "model");
      expect(fired.length).toBe(1);
      expect(fired[0]!.section!.label).toBe("newsletter_signup");
      expect(fired[0]!.nodeRef.tag).toBe("div");
    });

    test(`scoringBatch ${batch}: a head that declares nothing never sees the text stream`, () => {
      const out = run(modelWith(columnHead(COLUMN, ["none", "newsletter_signup"])), batch);
      expect(out.nodes.filter((n) => n.section?.source === "model").length).toBe(0);
    });

    test(`scoringBatch ${batch}: the region head follows its own declaration too`, () => {
      const region = (streams?: string[]) =>
        columnHead(COLUMN, ["footer", "main_content"], streams, [0.5, 0.5]);
      const plain = run(modelWith(oneSplitHead(null), region()), batch);
      const text = run(modelWith(oneSplitHead(null), region(["classid", "text"])), batch);
      const box = (out: typeof plain) => out.nodes.find((n) => n.nodeRef.tag === "div")!;
      expect(box(plain).label).toBe("footer"); // the column is never set on the class/id stream
      expect(box(text).label).toBe("main_content");
    });
  }

  test("tokenStreams is validated: unknown streams and a text-only head are refused", () => {
    const bad = (streams: unknown) => () =>
      modelWith(columnHead(COLUMN, ["a", "b"], streams as string[]));
    expect(bad(["nope"])).toThrow(ArtifactError);
    expect(bad(["text"])).toThrow(ArtifactError);
    expect(bad([])).toThrow(ArtifactError);
    expect(() => modelWith(columnHead(COLUMN, ["a", "b"], ["classid"]))).not.toThrow();
  });

  test("a head with no declaration reads the class/id stream only", () => {
    expect(modelWith(oneSplitHead(null)).section!.readsText).toBe(false);
    expect(modelWith(columnHead(COLUMN, ["a", "b"], ["classid", "text"])).section!.readsText).toBe(
      true,
    );
  });

  test("a page-type head cannot declare the text stream", () => {
    expect(() =>
      loadModel({
        format: "squirrel-dom-classifier",
        artifactVersion: 1,
        featurizerVersion: FEATURIZER_VERSION,
        nodeFeatureCount: NODE_FEATURE_NAMES.length,
        pageFeatureCount: PAGE_FEATURE_NAMES.length,
        tokenBuckets: TOKEN_BUCKETS,
        region: oneSplitHead(null),
        pageType: { ...oneSplitHead(null), tokenStreams: ["classid", "text"] },
      }),
    ).toThrow(ArtifactError);
  });

  test("an artifact built for another featurizer version degrades to the rules path, whichever side is older", () => {
    for (const version of ["v2.2.0", "v2.4.0"]) {
      const stale = {
        format: "squirrel-dom-classifier",
        artifactVersion: 1,
        featurizerVersion: version,
        nodeFeatureCount: NODE_FEATURE_NAMES.length,
        pageFeatureCount: PAGE_FEATURE_NAMES.length,
        tokenBuckets: TOKEN_BUCKETS,
        region: oneSplitHead(null),
        pageType: oneSplitHead(null),
        section: columnHead(COLUMN, ["none", "newsletter_signup"], ["classid", "text"]),
      };
      const out = classifyPage(html, URL, { model: tryLoadModel(stale).model, budgetMs: 1e9 });
      expect(out.degraded).toContain(version);
      expect(out.nodes.every((n) => n.source === "rules")).toBe(true);
      expect(out.nodes.some((n) => n.section?.source === "model")).toBe(false);
    }
  });
});

describe("platform guard thresholds ", () => {
  const withGuard = (overrides: Record<string, Record<string, number>>) => {
    const head = { ...oneSplitHead(null), platformClassThresholds: overrides };
    return loadModel({
      format: "squirrel-dom-classifier",
      artifactVersion: 1,
      featurizerVersion: "test",
      nodeFeatureCount: 1,
      pageFeatureCount: 1,
      tokenBuckets: 0,
      region: oneSplitHead(null),
      pageType: head,
    });
  };

  test("a platform with an override gets it; any other platform, or none, gets the head's", () => {
    const model = withGuard({ wix: { only: 1.01 } });
    expect(thresholdsFor(model.pageType, "wix")[0]).toBe(1.01);
    expect(thresholdsFor(model.pageType, "shopify")[0]).toBe(0.5);
    expect(thresholdsFor(model.pageType, null)[0]).toBe(0.5);
    expect(thresholdsFor(model.region, "wix")[0]).toBe(0.5);
  });

  test("an override naming a class the head does not have is refused", () => {
    expect(() => withGuard({ wix: { nope: 0.9 } })).toThrow(ArtifactError);
  });
});

// The read is LAZY and cached: the artifact is 8 MB of JSON. Tests mutate their copy, so each gets a clone.
let cached: Record<string, unknown> | undefined;
const artifactJson = (): Record<string, unknown> => structuredClone(cached ??= JSON.parse(readFileSync(ARTIFACT, "utf8")));

describe.if(HAS_ARTIFACT)("with the real artifact", () => {
  // The ceiling is 10 MB, and what matters at runtime is load time.
  test("it loads and fits the 10 MB ceiling", () => {
    const { model } = tryLoadModel(artifactJson());
    expect(model).not.toBeNull();
    const bytes = statSync(ARTIFACT).size;
    expect(bytes).toBeLessThanOrEqual(10_000_000);
    expect(model!.region.numClass).toBe(10);
    // At least 11 page-type classes: legal and pricing are model-only classes.
    expect(model!.pageType.numClass).toBeGreaterThanOrEqual(11);
    expect(model!.pageType.classThresholds.length).toBe(model!.pageType.numClass);
  });

  test("it loads (JSON parse + init) within 100 ms", () => {
    const text = readFileSync(ARTIFACT, "utf8");
    // Best of three, so one scheduling hiccup on a loaded machine is not a
    // failure; a model that is genuinely slow to load is slow every time.
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const started = Bun.nanoseconds();
      const { model } = tryLoadModel(JSON.parse(text));
      best = Math.min(best, (Bun.nanoseconds() - started) / 1e6);
      expect(model).not.toBeNull();
    }
    expect(best).toBeLessThanOrEqual(100);
  });

  test("predictions carry a source, and low confidence falls back to rules", () => {
    const { model } = tryLoadModel(artifactJson());
    const out = classifyPage(PAGE, URL, { model });
    expect(out.degraded).toBe("");
    expect(out.nodes.some((n) => n.source === "model")).toBe(true);
    for (const node of out.nodes) {
      expect(["model", "rules"]).toContain(node.source);
      expect(node.confidence).toBeGreaterThanOrEqual(0);
      expect(node.confidence).toBeLessThanOrEqual(1);
    }
    // A threshold of 1.01 can never be met. Every node is then answered either
    // by the markup (a declared landmark, source "rules") or by the model
    // declining (source "model", label "unknown") -- never by a rules guess
    // dressed up as a model answer.
    const forced = classifyPage(PAGE, URL, { model, threshold: 1.01 });
    expect(forced.nodes.length).toBe(out.nodes.length);
    for (const node of forced.nodes) {
      if (node.source === "model") expect(node.label).toBe("unknown");
      else expect(node.source).toBe("rules");
    }
    expect(forced.nodes.some((n) => n.source === "rules")).toBe(true);
  });

  test("a featurizer-version mismatch degrades instead of predicting nonsense", () => {
    const stale = { ...artifactJson(), featurizerVersion: "v1.9.9" };
    const out = classifyPage(PAGE, URL, { model: tryLoadModel(stale).model });
    expect(out.degraded).toContain("v1.9.9");
    expect(out.nodes.every((n) => n.source === "rules")).toBe(true);
  });

  test("the time budget hands the rest of the page to the rules path", () => {
    // Div soup on purpose. PAGE is all landmarks, and a node that declares its
    // own landmark is answered by the rules before the budget is ever
    // consulted -- so on PAGE this test would pass for the wrong reason.
    const soup = `<!doctype html><html><head><title>T</title></head><body>${Array.from(
      { length: 40 },
      (_, i) =>
        `<div class="row r${i}"><p>Block ${i} with enough text to be a candidate.</p></div>`,
    ).join("")}</body></html>`;
    const { model } = tryLoadModel(artifactJson());
    // The precondition is that the model PATH is reachable, not that the model
    // wins the confidence threshold on this synthetic page.
    const normal = classifyPage(soup, URL, { model });
    expect(normal.nodes.length).toBeGreaterThan(10);
    expect(normal.nodes.every((n) => n.nodeRef.tag === "div")).toBe(true);
    expect(normal.degraded).toBe("");
    const out = classifyPage(soup, URL, { model, budgetMs: -1 });
    expect(out.degraded).toContain("time budget");
    expect(out.nodes.every((n) => n.source === "rules")).toBe(true);
  });

  test("a node that declares its own landmark is answered by the markup", () => {
    const { model } = tryLoadModel(artifactJson());
    const out = classifyPage(PAGE, URL, { model });
    const at = (tag: string) => out.nodes.filter((n) => n.nodeRef.tag === tag);
    for (const tag of ["nav", "footer", "aside", "main"]) {
      for (const node of at(tag)) {
        expect([tag, node.source]).toEqual([tag, "rules"]);
        expect([tag, node.confidence]).toEqual([tag, 1]);
      }
    }
    expect(at("nav")[0]!.label).toBe("navigation");
    expect(at("footer")[0]!.label).toBe("footer");
  });
});

describe.if(HAS_ARTIFACT)("batched scoring is the row-at-a-time walk, bit for bit", () => {
  // Synthetic rows (a fixed pseudo-random stream, no page data): numeric slots hold small
  // integers and fractions, token slots are one-hot. Scores must be bit-identical whatever the
  // batch size, or the speed-up would be changing answers.
  test("scoreRows equals scoreRow on every row, in batches of 1, 7, 32 and all", () => {
    const model = loadModel(artifactJson());
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const head of [model.region, model.section!]) {
      const width = model.nodeFeatureCount + model.tokenBuckets;
      const rows = 300;
      const matrix = new Float32Array(rows * width);
      for (let row = 0; row < rows; row++) {
        for (let i = 0; i < model.nodeFeatureCount; i++) {
          const r = next();
          matrix[row * width + i] = r < 0.5 ? 0 : r < 0.8 ? Math.floor(next() * 20) : next();
        }
        for (let k = 0; k < 8; k++)
          matrix[row * width + model.nodeFeatureCount + Math.floor(next() * model.tokenBuckets)] = 1;
      }
      const expected = new Float32Array(rows * head.numClass);
      const scores = new Float32Array(head.numClass);
      for (let row = 0; row < rows; row++) {
        scoreRow(head, matrix.subarray(row * width, (row + 1) * width), scores);
        expected.set(scores, row * head.numClass);
      }
      for (const size of [1, 7, 32, rows]) {
        const out = new Float32Array(rows * head.numClass);
        for (let start = 0; start < rows; start += size) {
          const n = Math.min(size, rows - start);
          scoreRows(
            head,
            matrix.subarray(start * width, (start + n) * width),
            width,
            n,
            out.subarray(start * head.numClass, (start + n) * head.numClass),
          );
        }
        expect(Buffer.from(out.buffer).equals(Buffer.from(expected.buffer))).toBe(true);
      }
    }
  });

  test("classifyPage answers the same with any scoringBatch", () => {
    const { model } = tryLoadModel(artifactJson());
    // 120 candidate blocks, so a batch of 32 spans several chunks.
    const blocks = Array.from(
      { length: 120 },
      (_, i) =>
        `<section class="block-${i % 7}"><h2>Part ${i}</h2><p>Text ${i} about crawling.</p><a href="https://other${i}.example/">x</a></section>`,
    ).join("");
    for (const html of [PAGE, `<!doctype html><html><body><main>${blocks}</main></body></html>`]) {
      const base = classifyPage(html, URL, { model, budgetMs: 1e9, scoringBatch: 1 });
      for (const batch of [7, 32, 400]) {
        const batched = classifyPage(html, URL, { model, budgetMs: 1e9, scoringBatch: batch });
        expect(batched).toEqual(base);
      }
    }
  });
});

describe.if(HAS_ARTIFACT)("section head (the artifact has one)", () => {
  test("a node carries a section only when a class clears its threshold, never `none`", () => {
    const { model } = tryLoadModel(artifactJson());
    expect(model!.section).not.toBeNull();
    const out = classifyPage(PAGE, URL, { model });
    for (const node of out.nodes) {
      if (node.section?.source !== "model") continue;
      expect(node.section.label).not.toBe("none");
      const index = model!.section!.classes.indexOf(node.section.label);
      expect(node.section.confidence).toBeGreaterThanOrEqual(
        model!.section!.classThresholds[index]!,
      );
    }
  });

  test("the comments rule wins over the head inside a thread", () => {
    const { model } = tryLoadModel(artifactJson());
    const elements: unknown[] = [];
    const out = classifyPage(WITH_COMMENTS, URL, { model, elementsOut: elements });
    const thread = elements[out.commentSections[0]!.nodeId] as Element;
    const inside = out.nodes.filter((n) => thread.contains(elements[n.nodeRef.nodeId] as Element));
    expect(inside.length).toBeGreaterThan(0);
    for (const node of inside) expect(node.section?.source).toBe("rules");
  });
});

describe.if(HAS_ARTIFACT)("page-type head and the link graph", () => {
  test("classifyPage works with no link graph and with a complete one", () => {
    const { model } = tryLoadModel(artifactJson());
    const none = classifyPage(PAGE, URL, { model });
    const graph = classifyPage(PAGE, URL, {
      model,
      siteFeatures: Array.from({ length: model!.pageType.extraFeatureCount }, () => 0),
    });
    for (const out of [none, graph]) {
      expect(out.degraded).toBe("");
      expect(typeof out.pageType.label).toBe("string");
    }
  });
});

describe.if(HAS_ARTIFACT)("platform guard applied by classifyPage ", () => {
  test("the page's platform picks the override row; another platform's row is ignored", () => {
    const json = artifactJson() as Record<string, Record<string, unknown>>;
    const abstainAll = (head: { classes: string[] }) =>
      Object.fromEntries(head.classes.map((c) => [c, 1.01]));
    for (const name of ["pageType", "region"])
      json[name]!.platformClassThresholds = {
        custom: abstainAll(json[name] as unknown as { classes: string[] }),
      };
    const { model } = tryLoadModel(json);
    // The fixture page carries no platform markers: its bucket is "custom".
    const guarded = classifyPage(PAGE, URL, { model });
    expect(guarded.platform).toBe("custom");
    expect(guarded.pageType.source).not.toBe("model");
    for (const node of guarded.nodes)
      if (node.source === "model") expect(node.label).toBe("unknown");
    const other = classifyPage(PAGE, URL, { model, platform: "wix" });
    expect(other.platform).toBe("wix");
    expect(other.nodes.some((n) => n.source === "model" && n.label !== "unknown")).toBe(true);
  });
});

describe("page-type rules", () => {
  const withJson = (json: string): string =>
    `<!doctype html><html><head><title>T</title>
     <script type="application/ld+json">${json}</script></head><body><p>x</p></body></html>`;
  const label = (html: string, url = "https://example.com/x") => {
    const out = classifyPage(html, url);
    return out.pageType.label;
  };

  test("reads @graph, arrays and nested mainEntity", () => {
    expect(label(withJson('{"@graph":[{"@type":"WebPage"},{"@type":"BlogPosting"}]}'))).toBe(
      "article",
    );
    expect(label(withJson('[{"@type":["Product","Thing"]}]'))).toBe("product_detail");
    expect(label(withJson('{"@type":"WebPage","mainEntity":{"@type":"TechArticle"}}'))).toBe(
      "docs",
    );
  });

  test("a CollectionPage of Products is the listing, not an invented class", () => {
    expect(
      label(
        withJson(
          '{"@type":"CollectionPage","mainEntity":{"@type":"ItemList","itemListElement":[{"@type":"Product"}]}}',
        ),
      ),
    ).toBe("listing_index");
  });

  test("malformed JSON-LD does not throw", () => {
    expect(() => label(withJson("{not json"))).not.toThrow();
  });
});

describe.if(HAS_ARTIFACT)("per-class thresholds", () => {
  test("the artifact carries one threshold per class, and abstentions are above 1", () => {
    const model = loadModel(artifactJson());
    expect(model.region.classThresholds.length).toBe(model.region.numClass);
    for (const t of model.region.classThresholds) expect(t).toBeGreaterThan(0);
    // At least one class abstains; its threshold can never be met.
    expect([...model.region.classThresholds].some((t) => t > 1)).toBe(true);
  });

  test("a rejected prediction is an `unknown` from the MODEL, carrying the raw answer", () => {
    const soup = `<!doctype html><html><head><title>T</title></head><body>${Array.from(
      { length: 40 },
      (_, i) =>
        `<div class="row r${i}"><p>Block ${i} with enough text to be a candidate.</p></div>`,
    ).join("")}</body></html>`;
    const { model } = tryLoadModel(artifactJson());
    // A threshold of 1.01 rejects everything the model says.
    const out = classifyPage(soup, URL, { model, threshold: 1.01 });
    const rejected = out.nodes.filter((n) => n.label === "unknown" && n.source === "model");
    expect(rejected.length).toBeGreaterThan(0);
    for (const node of rejected) {
      // Saying "rules" here would claim the deterministic path had looked.
      expect(node.source).toBe("model");
      expect(node.confidence).toBe(0);
      expect(typeof node.rawLabel).toBe("string");
      expect(node.rawConfidence).toBeGreaterThan(0);
    }
  });
});

// pub#900: `homepage` is a URL rule. The artifact's page-type head has the class, but off the root path
// the model never answers it.
const HEAD_CLASSES = [
  "homepage",
  "product_detail",
  "product_listing",
  "article",
  "blog_post",
  "about",
  "contact",
  "docs",
  "legal",
  "pricing",
  "listing_index",
  "other",
];
// The shipped per-class bars, in class order.
const HEAD_BARS = [0.3, 0.94, 0.98, 0.95, 0.74, 0.77, 0.68, 0.87, 0.56, 0.93, 0.97, 0.91];

// A probability row from a few named classes; the rest get nothing.
const row = (given: Record<string, number>): number[] =>
  HEAD_CLASSES.map((name) => given[name] ?? 0);

describe("selectPageType: homepage is never the model's answer off the root path", () => {
  test("on the root path it is the plain argmax, homepage included", () => {
    const pick = selectPageType(row({ homepage: 0.6, other: 0.3 }), HEAD_CLASSES, HEAD_BARS, true);
    expect(pick).toEqual({ index: 0, probability: 0.6, fires: true });
  });

  test("off the root path the best OTHER class is chosen, at its own probability", () => {
    const pick = selectPageType(
      row({ homepage: 0.6, about: 0.25, other: 0.1 }),
      HEAD_CLASSES,
      HEAD_BARS,
      false,
    );
    expect(pick.index).toBe(HEAD_CLASSES.indexOf("about"));
    // Not renormalised: the bars were tuned on the head's own probabilities (0.25, not 0.25 / 0.4).
    expect(pick.probability).toBe(0.25);
  });

  test("a best other class under its own bar is the rules answer, not a model answer", () => {
    // about clears nothing at 0.25 against a 0.77 bar.
    const pick = selectPageType(
      row({ homepage: 0.6, about: 0.25, other: 0.1 }),
      HEAD_CLASSES,
      HEAD_BARS,
      false,
    );
    expect(pick.fires).toBe(false);
  });

  test("the best other class fires when it clears its own bar", () => {
    // Bars lowered, as a platform override or the `threshold` option can: blog_post 0.35 >= 0.3.
    const bars = HEAD_BARS.map(() => 0.3);
    const pick = selectPageType(row({ homepage: 0.4, blog_post: 0.35 }), HEAD_CLASSES, bars, false);
    expect(pick).toEqual({
      index: HEAD_CLASSES.indexOf("blog_post"),
      probability: 0.35,
      fires: true,
    });
  });

  test("the bar that counts is the chosen class's, not homepage's", () => {
    // homepage's own bar (0.3) is cleared by 0.4, but about's 0.77 is not cleared by 0.35.
    const pick = selectPageType(
      row({ homepage: 0.4, about: 0.35 }),
      HEAD_CLASSES,
      HEAD_BARS,
      false,
    );
    expect(pick.index).toBe(HEAD_CLASSES.indexOf("about"));
    expect(pick.fires).toBe(false);
  });

  test("when homepage is not the top class the veto changes nothing", () => {
    const probabilities = row({ blog_post: 0.8, homepage: 0.1, other: 0.05 });
    const open = selectPageType(probabilities, HEAD_CLASSES, HEAD_BARS, true);
    const closed = selectPageType(probabilities, HEAD_CLASSES, HEAD_BARS, false);
    expect(closed).toEqual(open);
    expect(open.fires).toBe(true);
  });

  test("ties go to the lower class index", () => {
    const pick = selectPageType(row({ about: 0.4, contact: 0.4 }), HEAD_CLASSES, HEAD_BARS, false);
    expect(pick.index).toBe(HEAD_CLASSES.indexOf("about"));
  });

  test("a head with no class besides homepage has nothing to answer", () => {
    const pick = selectPageType([1], ["homepage"], [0.3], false);
    expect(pick).toEqual({ index: -1, probability: 0, fires: false });
  });

  test("with the shipped bars no other class can clear its bar when homepage is on top", () => {
    // The lowest other bar is 0.56 and the top class has more than any other: both cannot be true, so off the
    // root path the shipped bars always give the rules answer. The next-class branch is reached only with
    // lowered bars (a platform override, the `threshold` option).
    const lowestOther = Math.min(...HEAD_BARS.slice(1));
    expect(lowestOther).toBeGreaterThan(0.5);
  });
});

describe("a non-root page is never labelled homepage, with or without a model", () => {
  const HOME = `<!doctype html><html><head><title>Example</title>
    <script type="application/ld+json">{"@type":"WebSite","name":"Example"}</script>
    <meta property="og:type" content="website"></head><body><main><h1>Example</h1>
    <p>We make widgets for people.</p></main></body></html>`;

  test("the rules never answer homepage for another path, whatever the structured data says", () => {
    for (const path of ["/welcome", "/en/", "/index.html", "/a/b", "/a?x=1"]) {
      const out = classifyPage(HOME, `https://example.com${path}`);
      expect(out.pageType.label).not.toBe("homepage");
    }
    // The root path is unchanged.
    expect(classifyPage(HOME, "https://example.com/").pageType).toEqual({
      label: "homepage",
      confidence: 1,
      source: "rules",
    });
  });
});

// A landing page: hero, feature grid, logos, a call to action. The shipped head reads it as a home page.
const NAV = `<header class="site-header"><nav><a href="/">Home</a> <a href="/features">Features</a>
  <a href="/pricing">Pricing</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>`;
const FOOTER = `<footer class="site-footer"><p>&copy; 2026 Example Co. All rights reserved.</p>
  <a href="/privacy">Privacy</a> <a href="/terms">Terms</a></footer>`;
const LANDING = `<!doctype html><html lang="en"><head><title>Example: build faster</title>
<meta name="description" content="Example: build faster"></head><body class="home">${NAV}<main>
<section class="hero"><h1>Build faster with Example</h1><p>The all-in-one platform for teams that ship.</p>
  <a class="btn btn-primary" href="/signup">Get started</a> <a class="btn" href="/demo">Book a demo</a></section>
<section class="features"><h2>Why teams choose us</h2><div class="grid">
  <div class="feature"><h3>Fast</h3><p>Deploys in seconds.</p></div>
  <div class="feature"><h3>Secure</h3><p>SOC 2 and SSO built in.</p></div>
  <div class="feature"><h3>Open</h3><p>APIs for everything.</p></div></div></section>
<section class="logos"><h2>Trusted by</h2><ul><li><img src="/a.svg" alt="A"></li>
  <li><img src="/b.svg" alt="B"></li><li><img src="/c.svg" alt="C"></li></ul></section>
<section class="testimonials"><h2>What customers say</h2><blockquote>Best tool we adopted this year.</blockquote></section>
<section class="cta"><h2>Ready to start?</h2><a class="btn btn-primary" href="/signup">Create your account</a></section>
</main>${FOOTER}</body></html>`;
const LOCALE_ROOT = "https://example.com/en/";

describe.if(HAS_ARTIFACT)(
  "the shipped head never answers homepage off the root path (#900)",
  () => {
    // The model's own answer for the page: the head's softmax row, before any URL rule.
    const probabilitiesFor = (
      model: NonNullable<ReturnType<typeof tryLoadModel>["model"]>,
      html: string,
      url: string,
    ) => {
      const { document } = parseHTML(html);
      const featurized = featurizeDocument(document as never, url, {});
      const values = withExtraBlock(
        toVector(
          featurized.page.features,
          featurized.page.tokens,
          model.pageFeatureCount,
          null,
          null,
        ),
        model.pageType.extraFeatureCount,
        null,
      );
      const scores = new Float32Array(model.pageType.numClass);
      scoreRow(model.pageType, values, scores);
      softmax(scores);
      return scores;
    };

    test("the premise: the landing page's top class is homepage and clears its bar", () => {
      // Before the fix this page came back as {label: "homepage", source: "model"} on a non-root path.
      const { model } = tryLoadModel(artifactJson());
      const probabilities = probabilitiesFor(model!, LANDING, LOCALE_ROOT);
      const bars = thresholdsFor(model!.pageType, "custom");
      const open = selectPageType(probabilities, model!.pageType.classes, bars, true);
      expect(model!.pageType.classes[open.index]).toBe("homepage");
      expect(open.fires).toBe(true);
    });

    test("a non-root URL with that markup is not homepage, from the model or the rules", () => {
      const { model } = tryLoadModel(artifactJson());
      const out = classifyPage(LANDING, LOCALE_ROOT, { model });
      expect(out.degraded).toBe("");
      expect(out.pageType.label).not.toBe("homepage");
      // The best other class is far under its bar, so the answer is the rules'.
      expect(out.pageType.source).toBe("rules");
      expect(out.pageType.label).toBe("unknown");
      // The fallback's confidence is the best OTHER class's probability (not homepage's ~0.9).
      const closed = selectPageType(
        probabilitiesFor(model!, LANDING, LOCALE_ROOT),
        model!.pageType.classes,
        thresholdsFor(model!.pageType, "custom"),
        false,
      );
      expect(closed.fires).toBe(false);
      expect(out.pageType.confidence).toBeCloseTo(closed.probability, 6);
      expect(out.pageType.confidence).toBeLessThan(0.5);
      for (const path of ["/welcome", "/home", "/index.html", "/lp/spring", "/a/b/c"]) {
        expect(
          classifyPage(LANDING, `https://example.com${path}`, { model }).pageType.label,
        ).not.toBe("homepage");
      }
    });

    test("the root path is unchanged: homepage from the rules at confidence 1", () => {
      const { model } = tryLoadModel(artifactJson());
      for (const url of [
        "https://example.com/",
        "https://example.com",
        "https://example.com/?a=1",
      ]) {
        expect(classifyPage(LANDING, url, { model }).pageType).toEqual({
          label: "homepage",
          confidence: 1,
          source: "rules",
        });
      }
    });

    test("the `threshold` option still applies: the best other class answers when it clears the bar", () => {
      const { model } = tryLoadModel(artifactJson());
      const closed = selectPageType(
        probabilitiesFor(model!, LANDING, LOCALE_ROOT),
        model!.pageType.classes,
        new Float64Array(model!.pageType.numClass).fill(0.001),
        false,
      );
      const out = classifyPage(LANDING, LOCALE_ROOT, { model, threshold: 0.001 });
      expect(out.pageType.source).toBe("model");
      expect<string>(out.pageType.label).toBe(model!.pageType.classes[closed.index]!);
      expect(out.pageType.label).not.toBe("homepage");
      expect(out.pageType.confidence).toBeCloseTo(closed.probability, 6);
      // A bar nothing can clear is the rules answer, and still never homepage.
      const none = classifyPage(LANDING, LOCALE_ROOT, { model, threshold: 1.01 });
      expect(none.pageType.source).toBe("rules");
      expect(none.pageType.label).not.toBe("homepage");
    });

    test("platform thresholds still apply to the class the head picks", () => {
      const json = artifactJson() as Record<string, Record<string, unknown>>;
      const classes = (json.pageType as unknown as { classes: string[] }).classes;
      // wix gets bars every class clears; every other platform keeps the head's own.
      json.pageType!.platformClassThresholds = {
        wix: Object.fromEntries(classes.map((c) => [c, 0.001])),
      };
      const { model } = tryLoadModel(json);
      const guarded = classifyPage(LANDING, LOCALE_ROOT, { model, platform: "wix" });
      expect(guarded.platform).toBe("wix");
      expect(guarded.pageType.source).toBe("model");
      expect(guarded.pageType.label).not.toBe("homepage");
      const other = classifyPage(LANDING, LOCALE_ROOT, { model, platform: "shopify" });
      expect(other.pageType.source).toBe("rules");
      expect(other.pageType.label).not.toBe("homepage");
    });
  },
);

describe("selectPageType edge cases", () => {
  test("a NaN probability is never the best class", () => {
    const pick = selectPageType(
      [0.1, Number.NaN, 0.9],
      ["homepage", "about", "contact"],
      [0.3, 0.5, 0.5],
      false,
    );
    expect(pick).toEqual({ index: 2, probability: 0.9, fires: true });
    const allNaN = selectPageType(
      [Number.NaN, Number.NaN],
      ["homepage", "about"],
      [0.3, 0.5],
      false,
    );
    expect(allNaN).toEqual({ index: -1, probability: 0, fires: false });
  });

  test("a head without a homepage class is the plain argmax either way", () => {
    const classes = ["about", "contact"];
    for (const allow of [true, false]) {
      expect(selectPageType([0.2, 0.7], classes, [0.5, 0.5], allow)).toEqual({
        index: 1,
        probability: 0.7,
        fires: true,
      });
    }
  });
});

// The wiring, with no dependency on what the shipped model predicts: a two-class head ["homepage", "about"] whose
// logits never change (the split column is a token no page sets), so every page reads homepage at ~0.99995 and
// about at ~0.0000454. The `about` bar then decides whether the best other class fires.
describe("page-type selection through classifyPage, with a head that always says homepage", () => {
  const NEVER_SET = PAGE_FEATURE_NAMES.length + tokenBucket("t:never-set-on-any-fixture");
  const modelFor = (aboutBar: number, platformBars?: Record<string, Record<string, number>>) =>
    loadModel({
      format: "squirrel-dom-classifier",
      artifactVersion: 1,
      featurizerVersion: FEATURIZER_VERSION,
      nodeFeatureCount: NODE_FEATURE_NAMES.length,
      pageFeatureCount: PAGE_FEATURE_NAMES.length,
      tokenBuckets: TOKEN_BUCKETS,
      region: oneSplitHead(null),
      pageType: {
        ...columnHead(NEVER_SET, ["homepage", "about"], undefined, [0.3, aboutBar]),
        ...(platformBars ? { platformClassThresholds: platformBars } : {}),
      },
    });
  const ABOUT_P = 1 / (1 + Math.exp(10));
  const NON_ROOT = "https://example.com/en/";
  const ROOT = "https://example.com/";
  const PLAIN = `<!doctype html><html><head><title>T</title></head><body><main><p>Some text.</p></main></body></html>`;

  test("the premise: the head reads homepage on the root path of a page with other structured data", () => {
    const out = classifyPage(PAGE, ROOT, { model: modelFor(0.5) });
    expect(out.degraded).toBe("");
    expect(out.pageType.label).toBe("homepage");
    expect(out.pageType.source).toBe("model");
    expect(out.pageType.confidence).toBeGreaterThan(0.9999);
  });

  test("off the root path the best other class under its bar is the rules answer", () => {
    const out = classifyPage(PLAIN, NON_ROOT, { model: modelFor(0.5) });
    expect(out.pageType.source).toBe("rules");
    expect(out.pageType.label).toBe("unknown");
    expect(out.pageType.confidence).toBeCloseTo(ABOUT_P, 6);
    // The rules label wins over unknown when the markup has one, still carrying about's probability.
    const article = classifyPage(PAGE, URL, { model: modelFor(0.5) });
    expect(article.pageType.label).toBe("article");
    expect(article.pageType.source).toBe("rules");
    expect(article.pageType.confidence).toBeCloseTo(ABOUT_P, 6);
  });

  test("off the root path the best other class over its own bar is the model's answer", () => {
    const out = classifyPage(PLAIN, NON_ROOT, { model: modelFor(1e-6) });
    expect(out.pageType.source).toBe("model");
    expect(out.pageType.label).toBe("about");
    expect(out.pageType.confidence).toBeCloseTo(ABOUT_P, 6);
  });

  test("the root path is unchanged: the URL rule, confidence 1, whatever the bars say", () => {
    for (const bar of [0.5, 1e-6]) {
      expect(classifyPage(PLAIN, ROOT, { model: modelFor(bar) }).pageType).toEqual({
        label: "homepage",
        confidence: 1,
        source: "rules",
      });
    }
  });

  test("the `threshold` option applies to the class the head picks, including 0", () => {
    expect(
      classifyPage(PLAIN, NON_ROOT, { model: modelFor(0.5), threshold: 0 }).pageType,
    ).toMatchObject({
      label: "about",
      source: "model",
    });
    expect(
      classifyPage(PLAIN, NON_ROOT, { model: modelFor(1e-6), threshold: 1.01 }).pageType.source,
    ).toBe("rules");
  });

  test("a platform override is read at the picked class, not at homepage", () => {
    // wix: about's bar is low and homepage's is high, so about fires. Another platform keeps the head's 0.5.
    const wix = modelFor(0.5, { wix: { homepage: 0.99, about: 1e-6 } });
    expect(classifyPage(PLAIN, NON_ROOT, { model: wix, platform: "wix" }).pageType).toMatchObject({
      label: "about",
      source: "model",
    });
    expect(classifyPage(PLAIN, NON_ROOT, { model: wix, platform: "shopify" }).pageType.source).toBe(
      "rules",
    );
    // The other way round: a low homepage bar must not let about through when about's own bar is high.
    const flipped = modelFor(1e-6, { wix: { homepage: 1e-6, about: 0.5 } });
    expect(classifyPage(PLAIN, NON_ROOT, { model: flipped, platform: "wix" }).pageType.source).toBe(
      "rules",
    );
  });
});
