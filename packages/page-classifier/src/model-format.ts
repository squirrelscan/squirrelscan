// Decoding and evaluating the packed classifier artifact, in pure TypeScript.
//
// The arithmetic here is deliberately boring, because it has to agree with
// export_model.py's reference evaluator exactly: thresholds are float32,
// compared with <=, left when true. `Math.fround` is what makes the comparison
// float32 in a language whose numbers are float64 — without it a threshold
// that rounded to float32 on the way out would be compared against a float64
// feature value, and the two runtimes would disagree on the rows that sit
// between the two representations.
//
// Layout (little-endian), one block per head:
//
//   magic "SQDC" | uint32 version | uint32 numTrees | uint32 numClass
//   uint32 perTreeInternal[numTrees]
//   uint32 perTreeLeaves[numTrees]
//   (pad to 4) uint16 feature[totalInternal]
//   (pad to 4) float32 threshold[totalInternal]
//   int32 left[totalInternal]    >= 0 internal node index, < 0 leaf -(v)-1
//   int32 right[totalInternal]
//   float32 leaf[totalLeaves]
//   uint8 flags[totalInternal]   tree-block version 2 only
//
// Version 2 carries LightGBM's missing-value handling per node (a head trained
// with NaN in its input, e.g. page type with the cross-page block dropped):
// bits 0-1 missing type (0 None, 1 Zero, 2 NaN), bit 2 default_left. The walk
// is LightGBM's NumericalDecision, mirrored in export_model.missing_aware_step.
// A version-1 block has no flags and walks exactly as before.

export const ARTIFACT_FORMAT = "squirrel-dom-classifier";
export const ARTIFACT_VERSION = 1;
/** Tree-block versions this runtime evaluates: 1 plain, 2 with missing flags. */
const TREE_BLOCK_VERSIONS = new Set([1, 2]);
const MISSING_ZERO = 1;
const MISSING_NAN = 2;
const DEFAULT_LEFT = 4;
/** LightGBM's kZeroThreshold. */
const ZERO_THRESHOLD = 1e-35;
const MAGIC = 0x43_44_51_53; // "SQDC" little-endian

/** Node token streams (featurizer v2.3.0): `classid` = `tokens` (s:, p:), `text` = `textTokens` (t:, st:, a:, r:, h:). */
export type TokenStream = "classid" | "text";
const TOKEN_STREAMS: ReadonlySet<string> = new Set(["classid", "text"]);

export interface HeadJson {
  classes: string[];
  featureColumns: number[] | null;
  confidenceThreshold: number;
  /** Per class, or null. A value above 1 means that class abstains. */
  classThresholds: number[] | null;
  numClass: number;
  numTrees: number;
  /** Which node token streams the head was trained on; absent = ["classid"], the only stream before v2.3.0. A head that reads
   *  `text` gets the union of both. Declared so a head never silently receives the wrong token input. */
  tokenStreams?: TokenStream[];
  /** Names of a block appended after [numeric, tokens] (page type's cross-page
   *  features). Absent for heads that read only the featurizer vector. */
  extraFeatureNames?: string[];
  /** The platform guard: platform bucket -> class name -> threshold, replacing
   *  the class threshold on pages of that platform (a value above 1 abstains). */
  platformClassThresholds?: Record<string, Record<string, number>>;
  trees: string;
}

export interface ArtifactJson {
  format: string;
  artifactVersion: number;
  featurizerVersion: string;
  nodeFeatureCount: number;
  pageFeatureCount: number;
  tokenBuckets: number;
  region: HeadJson;
  pageType: HeadJson;
  /** Optional third head: section purpose per candidate node. */
  section?: HeadJson;
}

export interface Head {
  classes: string[];
  /** Per-class confidence thresholds, chosen on val for precision >= 0.95 on
   *  the non-declared population. Falls back to `confidenceThreshold` for every
   *  class when the artifact carries none. */
  classThresholds: Float64Array;
  /** Indices into the featurizer's full vector, or null for "all of it". */
  featureColumns: Int32Array | null;
  confidenceThreshold: number;
  numClass: number;
  numTrees: number;
  treeStart: Int32Array;
  leafStart: Int32Array;
  perInternal: Int32Array;
  feature: Uint16Array;
  threshold: Float32Array;
  left: Int32Array;
  right: Int32Array;
  leaf: Float32Array;
  /** Per-node missing-value flags (tree-block version 2), or null. */
  flags: Uint8Array | null;
  /** The node token streams this head reads (see `HeadJson.tokenStreams`). */
  tokenStreams: readonly TokenStream[];
  /** True when the head reads the text/attribute stream as well as the class/id stream. */
  readsText: boolean;
  /** Width of the block appended after [numeric, tokens]; 0 for most heads. */
  extraFeatureCount: number;
  extraFeatureNames: string[];
  /** Full per-class threshold arrays for the platforms the guard overrides. */
  platformThresholds: Map<string, Float64Array>;
}

export interface Model {
  featurizerVersion: string;
  nodeFeatureCount: number;
  pageFeatureCount: number;
  tokenBuckets: number;
  region: Head;
  pageType: Head;
  /** Section purpose per node, or null for an artifact without that head. */
  section: Head | null;
}

export class ArtifactError extends Error {}

function decodeBase64(value: string): ArrayBuffer {
  // A fresh, 4-byte-aligned buffer, so the typed-array views below are legal.
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function decodeHead(json: HeadJson): Head {
  const buffer = decodeBase64(json.trees);
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new ArtifactError("bad tree-block magic");
  const version = view.getUint32(4, true);
  if (!TREE_BLOCK_VERSIONS.has(version)) {
    throw new ArtifactError(`unsupported tree-block version ${version}`);
  }
  const numTrees = view.getUint32(8, true);
  const numClass = view.getUint32(12, true);
  if (numClass !== json.numClass || numTrees !== json.numTrees) {
    throw new ArtifactError("tree block disagrees with its own header");
  }

  let offset = 16;
  const perInternal = new Int32Array(numTrees);
  const perLeaves = new Int32Array(numTrees);
  for (let i = 0; i < numTrees; i++) perInternal[i] = view.getUint32(offset + i * 4, true);
  offset += numTrees * 4;
  for (let i = 0; i < numTrees; i++) perLeaves[i] = view.getUint32(offset + i * 4, true);
  offset += numTrees * 4;

  let totalInternal = 0;
  let totalLeaves = 0;
  const treeStart = new Int32Array(numTrees);
  const leafStart = new Int32Array(numTrees);
  for (let i = 0; i < numTrees; i++) {
    treeStart[i] = totalInternal;
    leafStart[i] = totalLeaves;
    totalInternal += perInternal[i]!;
    totalLeaves += perLeaves[i]!;
  }

  const feature = new Uint16Array(buffer, offset, totalInternal);
  offset += totalInternal * 2;
  offset += (4 - (offset % 4)) % 4;
  const threshold = new Float32Array(buffer, offset, totalInternal);
  offset += totalInternal * 4;
  const left = new Int32Array(buffer, offset, totalInternal);
  offset += totalInternal * 4;
  const right = new Int32Array(buffer, offset, totalInternal);
  offset += totalInternal * 4;
  const leaf = new Float32Array(buffer, offset, totalLeaves);
  offset += totalLeaves * 4;
  let flags: Uint8Array | null = null;
  if (version === 2) {
    if (offset + totalInternal > buffer.byteLength)
      throw new ArtifactError("tree block is truncated");
    flags = new Uint8Array(buffer, offset, totalInternal);
    offset += totalInternal;
  }
  if (offset > buffer.byteLength) throw new ArtifactError("tree block is truncated");

  const tokenStreams: TokenStream[] = json.tokenStreams ?? ["classid"];
  if (
    !Array.isArray(tokenStreams) ||
    tokenStreams.length === 0 ||
    !tokenStreams.includes("classid") ||
    tokenStreams.some((stream) => !TOKEN_STREAMS.has(stream))
  ) {
    throw new ArtifactError(`unsupported tokenStreams ${JSON.stringify(json.tokenStreams)}`);
  }

  const perClass = new Float64Array(numClass).fill(json.confidenceThreshold);
  if (json.classThresholds) {
    if (json.classThresholds.length !== numClass) {
      throw new ArtifactError("classThresholds length does not match numClass");
    }
    perClass.set(json.classThresholds);
  }

  const platformThresholds = new Map<string, Float64Array>();
  for (const [platform, overrides] of Object.entries(json.platformClassThresholds ?? {})) {
    const row = Float64Array.from(perClass);
    for (const [name, value] of Object.entries(overrides)) {
      const index = json.classes.indexOf(name);
      if (index < 0 || typeof value !== "number")
        throw new ArtifactError(`platform override for unknown class ${name}`);
      row[index] = value;
    }
    platformThresholds.set(platform, row);
  }

  return {
    classes: json.classes,
    classThresholds: perClass,
    featureColumns: json.featureColumns ? Int32Array.from(json.featureColumns) : null,
    confidenceThreshold: json.confidenceThreshold,
    numClass,
    numTrees,
    treeStart,
    leafStart,
    perInternal,
    feature,
    threshold,
    left,
    right,
    leaf,
    flags,
    tokenStreams,
    readsText: tokenStreams.includes("text"),
    extraFeatureCount: json.extraFeatureNames?.length ?? 0,
    extraFeatureNames: json.extraFeatureNames ?? [],
    platformThresholds,
  };
}

/** The per-class thresholds for a page of this platform bucket: the guard's
 *  override row when the artifact has one for it, the head's own otherwise. */
export function thresholdsFor(head: Head, platform: string | null): Float64Array {
  return (platform !== null && head.platformThresholds.get(platform)) || head.classThresholds;
}

/** Parse an artifact. Throws ArtifactError on anything it cannot trust. */
export function loadModel(json: unknown): Model {
  const artifact = json as ArtifactJson;
  if (!artifact || artifact.format !== ARTIFACT_FORMAT) {
    throw new ArtifactError("not a squirrel-dom-classifier artifact");
  }
  if (artifact.artifactVersion !== ARTIFACT_VERSION) {
    throw new ArtifactError(`unsupported artifact version ${artifact.artifactVersion}`);
  }
  const pageType = decodeHead(artifact.pageType);
  if (pageType.readsText) {
    // Page tokens have no text stream; a page-type head declaring one would be reading nothing it was trained on.
    throw new ArtifactError("a page-type head cannot read the text token stream");
  }
  return {
    featurizerVersion: artifact.featurizerVersion,
    nodeFeatureCount: artifact.nodeFeatureCount,
    pageFeatureCount: artifact.pageFeatureCount,
    tokenBuckets: artifact.tokenBuckets,
    region: decodeHead(artifact.region),
    pageType,
    section: artifact.section ? decodeHead(artifact.section) : null,
  };
}

/**
 * Raw class scores for one row. `values` is the FULL featurizer vector
 * (numeric features followed by the token buckets). A head trained on a subset
 * of columns has that mapping baked into its packed feature indices by the
 * exporter, so this walk never needs to know about it; `featureColumns` is
 * retained only as metadata describing which columns the head actually uses.
 */
export function scoreRow(head: Head, values: Float32Array, out: Float32Array): void {
  if (head.flags) {
    scoreRowMissing(head, head.flags, values, out);
    return;
  }
  out.fill(0);
  const { feature, threshold, left, right, leaf, treeStart, leafStart, perInternal } = head;
  for (let tree = 0; tree < head.numTrees; tree++) {
    const cls = tree % head.numClass;
    const internal = perInternal[tree]!;
    if (internal === 0) {
      // A stump: one leaf and no split, which the child encoding cannot name,
      // so it is addressed by the tree's own leaf offset.
      out[cls]! += leaf[leafStart[tree]!]!;
      continue;
    }
    let node = treeStart[tree]!;
    for (;;) {
      // `values` is a Float32Array, so reading it already yields the float32
      // value: an explicit Math.fround here was a no-op called ~3,850 times per
      // row. The exporter bakes the full-vector feature index into the tree, so
      // there is no column indirection either.
      const next = values[feature[node]!]! <= threshold[node]! ? left[node]! : right[node]!;
      if (next < 0) {
        // The exporter re-bases child pointers into the CONCATENATED arrays, so
        // -next-1 is already the global leaf index. Adding leafStart here as
        // well double-counts the offset, which reads a leaf from a later tree
        // and quietly produces a plausible wrong answer: it cost 9,718 of
        // 10,000 parity rows.
        out[cls]! += leaf[-next - 1]!;
        break;
      }
      node = next;
    }
  }
}

/**
 * Raw class scores for `count` rows at once: `rows` holds them back to back,
 * `width` floats each, and `out` receives `numClass` scores per row.
 *
 * Tree-major: each tree walks every row before the next tree starts. A region
 * tree is ~127 leaves and the head is 3.6 MB, so the row-at-a-time walk in
 * `scoreRow` reads a fresh tree from memory for every node; here a tree's upper
 * levels stay in cache for the whole batch. Every row still adds its trees'
 * leaves in tree order, into a float32 slot, so the scores are bit-for-bit
 * those of `scoreRow`. Plain (version-1) blocks only: a head with missing-value
 * flags falls back to one `scoreRow` per row.
 */
export function scoreRows(
  head: Head,
  rows: Float32Array,
  width: number,
  count: number,
  out: Float32Array,
): void {
  const k = head.numClass;
  if (head.flags) {
    const scores = new Float32Array(k);
    for (let r = 0; r < count; r++) {
      scoreRow(head, rows.subarray(r * width, (r + 1) * width), scores);
      out.set(scores, r * k);
    }
    return;
  }
  out.fill(0, 0, count * k);
  const { feature, threshold, left, right, leaf, treeStart, leafStart, perInternal } = head;
  let cls = 0;
  for (let tree = 0; tree < head.numTrees; tree++) {
    if (perInternal[tree]! === 0) {
      const value = leaf[leafStart[tree]!]!;
      for (let r = 0; r < count; r++) out[r * k + cls]! += value;
    } else {
      const root = treeStart[tree]!;
      for (let r = 0, base = 0; r < count; r++, base += width) {
        let node = root;
        for (;;) {
          const next =
            rows[base + feature[node]!]! <= threshold[node]! ? left[node]! : right[node]!;
          if (next < 0) {
            out[r * k + cls]! += leaf[-next - 1]!;
            break;
          }
          node = next;
        }
      }
    }
    cls = cls + 1 === k ? 0 : cls + 1;
  }
}

/**
 * The same walk for a version-2 block, with LightGBM's missing-value decision
 * at every node. Kept separate so the plain walk, which every region and
 * section node takes, pays nothing for it.
 */
function scoreRowMissing(
  head: Head,
  flags: Uint8Array,
  values: Float32Array,
  out: Float32Array,
): void {
  out.fill(0);
  const { feature, threshold, left, right, leaf, treeStart, leafStart, perInternal } = head;
  for (let tree = 0; tree < head.numTrees; tree++) {
    const cls = tree % head.numClass;
    if (perInternal[tree]! === 0) {
      out[cls]! += leaf[leafStart[tree]!]!;
      continue;
    }
    let node = treeStart[tree]!;
    for (;;) {
      const flag = flags[node]!;
      const missing = flag & 3;
      let value = values[feature[node]!]!;
      // NaN on a node that does not treat NaN as missing reads as 0.0.
      if (value !== value && missing !== MISSING_NAN) value = 0;
      let next: number;
      if (
        (missing === MISSING_NAN && value !== value) ||
        (missing === MISSING_ZERO && Math.abs(value) <= ZERO_THRESHOLD)
      ) {
        next = flag & DEFAULT_LEFT ? left[node]! : right[node]!;
      } else {
        next = value <= threshold[node]! ? left[node]! : right[node]!;
      }
      if (next < 0) {
        out[cls]! += leaf[-next - 1]!;
        break;
      }
      node = next;
    }
  }
}

/** Softmax in place, returning the argmax and its probability. */
export function softmax(scores: Float32Array): { index: number; probability: number } {
  let max = -Infinity;
  for (let i = 0; i < scores.length; i++) if (scores[i]! > max) max = scores[i]!;
  let total = 0;
  for (let i = 0; i < scores.length; i++) {
    const value = Math.exp(scores[i]! - max);
    scores[i] = value;
    total += value;
  }
  let best = 0;
  for (let i = 0; i < scores.length; i++) {
    scores[i] = scores[i]! / total;
    if (scores[i]! > scores[best]!) best = i;
  }
  return { index: best, probability: scores[best]! };
}
