// The inference entry point: HTML in, region and page-type labels out.
//
// One contract for both paths. Every result carries {label, confidence, source}
// where source is "model" or "rules", and a consumer never branches on source
// except to display it. The rules path runs when:
//
//   - no artifact was supplied, or it failed to parse;
//   - the artifact was built for a different featurizer version;
//   - the model's confidence for that node is below the artifact's threshold;
//   - the time budget ran out partway through a page.
//
// A missing model therefore degrades attribution, never detection.
//
// Comment threads are the exception to "the model answers sections": the
// deterministic comments rule (comments-rule.ts) reads them from the markup on
// every page, with or without an artifact, and wins over the section head.

import { parseHTML } from "@squirrelscan/parser/dom";
import {
  featurizeDocument,
  FEATURIZER_VERSION,
  mergeTokens,
  TOKEN_BUCKETS,
  type NodeFeatures,
  type WalkAttributes,
} from "./featurize";
import {
  ArtifactError,
  loadModel,
  scoreRow,
  scoreRows,
  softmax,
  thresholdsFor,
  type Model,
} from "./model-format";
import { commentRule, type CommentSection } from "./comments-rule";
import { platformBucket, platformOf } from "./platform";
import { chromeIndices, chromeMass, SITE_CHROME_THRESHOLD } from "./region-groups";
import {
  declaresOwnRegion,
  isRootPath,
  rulePageType,
  ruleRegion,
  type PageTypeLabel,
  type RegionLabel,
} from "./rules-fallback";

export type Source = "model" | "rules";

export interface Prediction<T extends string> {
  label: T;
  confidence: number;
  source: Source;
  /**
   * What the model said before the per-class threshold rejected it. Present
   * ONLY on an abstention (`label: "unknown"`, `source: "model"`), and only for
   * debugging: it is below the precision bar the thresholds enforce, so it must
   * not be displayed to a user or used to name a fix.
   */
  rawLabel?: string;
  rawConfidence?: number;
}

export interface SectionPrediction {
  label: string;
  confidence: number;
  /** "model" for the section head, "rules" for the comments rule. */
  source: Source;
  /** Rules only: the id or class token the comments rule matched, lowercased,
   *  digits folded to N. Markup, never page text. */
  evidence?: string;
}

export interface NodePrediction extends Prediction<RegionLabel> {
  /** Stable reference to the node within this page: its preorder element
   *  index, the tag, and the id attribute when the page provided one. */
  nodeRef: { nodeId: number; tag: string; elementId: string };
  /** The node's section purpose (ad, cookie_consent, faq_block, ...): the
   *  comments rule's `comments` or `reviews` when the node sits in a declared
   *  comment thread, else the section head's class when the artifact has the
   *  head AND the class clears its per-class threshold. Absent means `none`,
   *  abstained, or not scored. */
  section?: SectionPrediction;
}

/** A comment thread the page's markup declares (comments-rule.ts). */
export interface CommentSectionRef {
  /** The thread's outermost container. Not necessarily a candidate node: big
   *  threads often sit past the candidate cap. */
  nodeId: number;
  label: CommentSection;
  /** The id or class token that matched, lowercased, digits folded to N. */
  evidence: string;
}

export interface PageClassification {
  pageType: Prediction<PageTypeLabel>;
  nodes: NodePrediction[];
  /** Why any part of this page fell back, or "" when nothing did. */
  degraded: string;
  /** The platform bucket the thresholds were chosen for, or null when unknown. */
  platform: string | null;
  /** The page's comment threads, outermost containers in document order;
   *  empty when it declares none. From the rules, so present without a model
   *  and whatever the budget did. */
  commentSections: CommentSectionRef[];
}

export interface ClassifyOptions {
  /** Parsed artifact. Omit to run the deterministic path only. */
  model?: Model | null;
  /** Wall-clock budget for the whole page. Exceeding it finishes the remaining
   *  nodes through the rules path rather than returning a partial answer. */
  budgetMs?: number;
  /** Override the artifact's own threshold, for evaluation. */
  threshold?: number;
  /**
   * The page's cross-page block (inbound same-site anchors, template cluster)
   * in the order of the page-type head's `extraFeatureNames`, when the caller
   * has the site's link graph. Absent, null, or the wrong length means "no
   * graph": the block is passed as missing (NaN), which is how the head was
   * trained to work on a single-URL audit.
   */
  siteFeatures?: ArrayLike<number> | null;
  /** The page's raw HTML, read ONLY for the platform fingerprint that picks
   *  the guard's per-platform thresholds. classifyPage passes it itself. */
  html?: string;
  /** A platform the caller already knows (bucket or platform name); wins over
   *  `html`. Neither given: the artifact's global thresholds apply. */
  platform?: string | null;
  /** Receives the walked elements in nodeId order (see
   *  FeaturizeOptions.elementsOut). Pass it to place elements on the page
   *  with `elementPlacer` (placement.ts). */
  elementsOut?: unknown[];
  /** Analysis only: receives wall-clock ms per stage, so a bench can time the
   *  heads directly instead of subtracting a separate featurize run. */
  timingsOut?: ClassifyTimings;
  /** Answer `site_chrome` for nodes the class thresholds leave unknown when the chrome classes'
   *  summed probability reaches the CV-calibrated threshold (region-groups.ts). Default
   *  true; off whenever `threshold` is overridden, since that is a per-class evaluation. */
  groupFallback?: boolean;
  /** Rows scored per tree pass (see `scoreRows`); 1 is the row-at-a-time walk.
   *  Scores are identical either way; only the speed differs. */
  scoringBatch?: number;
}

export interface ClassifyTimings {
  featurizeMs: number;
  pageTypeMs: number;
  regionMs: number;
  sectionMs: number;
}

// Measured on 1,500 real pages with batched scoring. With 500 ms the model finishes every normal page (CLI-path
// p95 ~75 ms) and about three quarters of link-heavy pages. Huge DOMs (10k+
// elements) still overrun, since featurize itself can take ~400 ms; they then
// finish on the rules path. The old 25 ms finished only 44-64% of normal pages.
const DEFAULT_BUDGET_MS = 500;
// Rows per tree pass. Scores are bit-identical at any size; 32 cut region time
// ~1.9x and section ~1.6x against row-at-a-time, and keeps the budget checked
// every 32 nodes, as before.
const DEFAULT_SCORING_BATCH = 32;

/** Parse an artifact, returning null (never throwing) when it cannot be used. */
export function tryLoadModel(json: unknown): { model: Model | null; reason: string } {
  try {
    return { model: loadModel(json), reason: "" };
  } catch (error) {
    const reason = error instanceof ArtifactError ? error.message : "artifact failed to parse";
    return { model: null, reason };
  }
}

export interface PageTypePick {
  /** Index of the model's best admissible class, or -1 when none is admissible. */
  index: number;
  /** That class's softmax probability as the model gave it, never renormalised:
   *  the per-class bars were tuned on unrenormalised probabilities. 0 when
   *  nothing is admissible. */
  probability: number;
  /** Whether the class clears its own bar. False means the rules answer. */
  fires: boolean;
}

/**
 * The model's page type answer, from one softmax row.
 *
 * `homepage` is a URL rule: the artifact's head has the class, but off the root
 * path it is never an answer. With `allowHomepage` false the best OTHER class
 * is chosen instead, at its own probability against its own bar. With it true
 * this is the plain argmax. Ties go to the lower class index, as `softmax` does,
 * and a NaN probability is never chosen.
 *
 * @param probabilities one probability per class, in class order
 * @param thresholds one bar per class, in class order
 */
export function selectPageType(
  probabilities: ArrayLike<number>,
  classes: readonly string[],
  thresholds: ArrayLike<number>,
  allowHomepage: boolean,
): PageTypePick {
  let index = -1;
  let best = -Infinity;
  for (let i = 0; i < classes.length; i++) {
    if (!allowHomepage && classes[i] === "homepage") continue;
    // `>` against -Infinity: a NaN probability is never the best, and a tie keeps the lower index.
    if (probabilities[i]! > best) {
      best = probabilities[i]!;
      index = i;
    }
  }
  if (index === -1) return { index, probability: 0, fires: false };
  return { index, probability: best, fires: best >= thresholds[index]! };
}

/** Parses through the same entry the CLI uses, so inference sees the same DOM
 *  the training data was built from. */
export function classifyPage(
  html: string,
  url: string,
  options: ClassifyOptions = {},
): PageClassification {
  const { document } = parseHTML(html);
  return classifyDocument(document, url, { html, ...options });
}

/** For callers that already hold a parsed document, which the CLI does. */
export function classifyDocument(
  document: unknown,
  url: string,
  options: ClassifyOptions = {},
): PageClassification {
  const started = Date.now();
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const timings = options.timingsOut;
  let mark = timings ? performance.now() : 0;
  const lap = (): number => {
    const now = performance.now();
    const elapsed = now - mark;
    mark = now;
    return elapsed;
  };
  const elements = options.elementsOut ?? [];
  const attributes: WalkAttributes = { classAttr: [], idAttr: [], subtreeSize: [] };
  const featurized = featurizeDocument(document as never, url, {
    elementsOut: elements,
    attributesOut: attributes,
  });
  const byId = new Map<number, NodeFeatures>();
  for (const node of featurized.nodes) byId.set(node.nodeId, node);
  if (timings) timings.featurizeMs = lap();

  const model = options.model ?? null;
  let degraded = "";
  if (!model) {
    degraded = "no model artifact";
  } else if (model.featurizerVersion !== FEATURIZER_VERSION) {
    degraded = `artifact built for featurizer ${model.featurizerVersion}, this build is ${FEATURIZER_VERSION}`;
  } else if (model.tokenBuckets !== TOKEN_BUCKETS) {
    degraded = "artifact token-bucket count does not match the featurizer";
  } else if (
    featurized.nodes.length > 0 &&
    featurized.nodes[0]!.features.length !== model.nodeFeatureCount
  ) {
    degraded = "artifact node-feature width does not match the featurizer";
  }
  const usable = degraded === "" ? model : null;
  const platform = options.platform
    ? platformBucket(options.platform)
    : options.html !== undefined
      ? platformBucket(platformOf(options.html))
      : null;

  // Page type. The homepage rule runs FIRST, ahead of the model, because it is
  // the one page class whose label comes from the URL. The artifact's head has
  // a `homepage` class, but on a non-root URL it is never an answer: the model
  // picks the best other class (selectPageType) or the rules answer.
  let pageType: Prediction<PageTypeLabel>;
  const ruleType = rulePageType(document as never, url);
  const rootPath = isRootPath(url);
  if (rootPath && ruleType === "homepage") {
    pageType = { label: "homepage", confidence: 1, source: "rules" };
  } else if (usable) {
    const values = withExtraBlock(
      toVector(
        featurized.page.features,
        featurized.page.tokens,
        usable.pageFeatureCount,
        null,
        null,
      ),
      usable.pageType.extraFeatureCount,
      options.siteFeatures ?? null,
    );
    const scores = new Float32Array(usable.pageType.numClass);
    scoreRow(usable.pageType, values, scores);
    softmax(scores);
    // Per class when the artifact carries them (page type v8); otherwise every
    // entry equals the head's single confidenceThreshold.
    const thresholds =
      options.threshold !== undefined
        ? new Float64Array(usable.pageType.numClass).fill(options.threshold)
        : thresholdsFor(usable.pageType, platform);
    const pick = selectPageType(scores, usable.pageType.classes, thresholds, rootPath);
    pageType = pick.fires
      ? {
          label: usable.pageType.classes[pick.index] as PageTypeLabel,
          confidence: pick.probability,
          source: "model",
        }
      : { label: ruleType, confidence: pick.probability, source: "rules" };
  } else {
    pageType = { label: ruleType, confidence: ruleType === "unknown" ? 0 : 1, source: "rules" };
  }

  if (timings) timings.pageTypeMs = lap();
  const nodes: NodePrediction[] = [];
  const scores = usable ? new Float32Array(usable.region.numClass) : null;
  const regionThresholds = usable ? thresholdsFor(usable.region, platform) : null;
  const chrome =
    usable && (options.groupFallback ?? true) && options.threshold === undefined
      ? chromeIndices(usable.region.classes, regionThresholds!)
      : [];
  let values: Float32Array | null = null;
  let previousTokens: number[] | null = null;
  let budgetSpent = false;

  const batch = Math.max(1, Math.floor(options.scoringBatch ?? DEFAULT_SCORING_BATCH));
  const width = usable ? usable.nodeFeatureCount + TOKEN_BUCKETS : 0;
  const matrix = usable && batch > 1 ? new Float32Array(batch * width) : null;
  if (matrix && usable && scores) {
    // The same decisions as the row-at-a-time loop below, a chunk of `batch`
    // nodes at a time: markup wins, the budget is checked once per chunk, and
    // the model's rows for the chunk are scored together.
    const k = usable.region.numClass;
    const chunkScores = new Float32Array(batch * k);
    const asked = new Uint8Array(batch);
    const all = featurized.nodes;
    for (let start = 0; start < all.length; start += batch) {
      const end = Math.min(start + batch, all.length);
      if (!budgetSpent && Date.now() - started > budget) {
        budgetSpent = true;
        degraded = degraded || `time budget ${budget}ms exceeded`;
      }
      let rows = 0;
      for (let i = start; i < end; i++) {
        const ask = !budgetSpent && !declaresOwnRegion(all[i]!);
        asked[i - start] = ask ? 1 : 0;
        if (ask) {
          writeRow(
            matrix,
            rows++ * width,
            all[i]!,
            usable.nodeFeatureCount,
            usable.region.readsText,
          );
        }
      }
      if (rows > 0) scoreRows(usable.region, matrix, width, rows, chunkScores);
      let row = 0;
      for (let i = start; i < end; i++) {
        const node = all[i]!;
        const nodeRef = { nodeId: node.nodeId, tag: node.tag, elementId: node.elementId };
        if (!asked[i - start]) {
          nodes.push({ nodeRef, ...withRules(node, byId) });
          continue;
        }
        const rowScores = chunkScores.subarray(row * k, (row + 1) * k);
        row++;
        const { index, probability } = softmax(rowScores);
        const threshold = options.threshold ?? regionThresholds![index]!;
        const mass =
          probability >= threshold || chrome.length === 0 ? 0 : chromeMass(rowScores, chrome);
        nodes.push(
          probability >= threshold
            ? {
                nodeRef,
                label: usable.region.classes[index] as RegionLabel,
                confidence: probability,
                source: "model",
              }
            : mass >= SITE_CHROME_THRESHOLD
              ? { nodeRef, label: "site_chrome", confidence: mass, source: "model" }
              : {
                  nodeRef,
                  label: "unknown",
                  confidence: 0,
                  source: "model",
                  rawLabel: usable.region.classes[index],
                  rawConfidence: probability,
                },
        );
      }
    }
  } else {
    for (const node of featurized.nodes) {
      const nodeRef = { nodeId: node.nodeId, tag: node.tag, elementId: node.elementId };
      if (!usable || !scores || budgetSpent) {
        nodes.push({ nodeRef, ...withRules(node, byId) });
        continue;
      }
      // MARKUP WINS. A node carrying its own landmark tag or ARIA role has been
      // told what it is by the page author, and the model is not asked. "Model
      // primary, rules fallback" is about nodes where the markup is SILENT; it
      // never means overriding a correct declaration.
      //
      // This is not a style preference, it is a measured defect: with the model
      // consulted first, a <nav class="main-navigation"> came back content_block
      // at 0.74 on 66 of 68 pages of a stored site, contradicting a deterministic
      // answer that was right. See the package README.
      if (declaresOwnRegion(node)) {
        nodes.push({ nodeRef, ...withRules(node, byId) });
        continue;
      }
      // Checked every 32 nodes: Date.now() per node is itself measurable at the
      // scale this runs at (400 nodes x pages x rules).
      if ((nodes.length & 31) === 0 && Date.now() - started > budget) {
        budgetSpent = true;
        degraded = degraded || `time budget ${budget}ms exceeded`;
        nodes.push({ nodeRef, ...withRules(node, byId) });
        continue;
      }
      const regionTokens = usable.region.readsText
        ? mergeTokens(node.tokens, node.textTokens)
        : node.tokens;
      values = toVector(
        node.features,
        regionTokens,
        usable.nodeFeatureCount,
        values,
        previousTokens,
      );
      previousTokens = regionTokens;
      scoreRow(usable.region, values, scores);
      const { index, probability } = softmax(scores);
      // Per class, not global. One threshold cannot serve ten classes whose
      // precision curves differ by 40 points, and the single value the old rule
      // selected (0.95) left two thirds of nodes unnamed.
      const threshold = options.threshold ?? regionThresholds![index]!;
      const mass = probability >= threshold || chrome.length === 0 ? 0 : chromeMass(scores, chrome);
      if (probability >= threshold) {
        nodes.push({
          nodeRef,
          label: usable.region.classes[index] as RegionLabel,
          confidence: probability,
          source: "model",
        });
      } else if (mass >= SITE_CHROME_THRESHOLD) {
        nodes.push({ nodeRef, label: "site_chrome", confidence: mass, source: "model" });
      } else {
        // The model was asked and declined. That is a MODEL answer of "unknown",
        // not a rules answer: saying `source: "rules"` here would claim the
        // deterministic path had looked and found nothing, which it has not.
        nodes.push({
          nodeRef,
          label: "unknown",
          confidence: 0,
          source: "model",
          rawLabel: usable.region.classes[index],
          rawConfidence: probability,
        });
      }
    }
  }

  if (timings) timings.regionMs = lap();
  // Section purpose: a separate head over the SAME candidate vectors, for every
  // node (a declared <nav> can still hold the site's breadcrumbs). One entry is
  // pushed per featurized node above, so the arrays line up by position.
  const section = usable?.section ?? null;
  if (section && !budgetSpent) {
    const sectionScores = new Float32Array(section.numClass);
    const sectionThresholds = thresholdsFor(section, platform);
    if (matrix) {
      const k = section.numClass;
      const chunkScores = new Float32Array(batch * k);
      const all = featurized.nodes;
      for (let start = 0; start < all.length; start += batch) {
        if (Date.now() - started > budget) {
          degraded = degraded || `time budget ${budget}ms exceeded`;
          break;
        }
        const end = Math.min(start + batch, all.length);
        for (let i = start; i < end; i++) {
          writeRow(
            matrix,
            (i - start) * width,
            all[i]!,
            usable!.nodeFeatureCount,
            section.readsText,
          );
        }
        scoreRows(section, matrix, width, end - start, chunkScores);
        for (let i = start; i < end; i++) {
          const { index, probability } = softmax(
            chunkScores.subarray((i - start) * k, (i - start + 1) * k),
          );
          const label = section.classes[index]!;
          if (label !== "none" && probability >= sectionThresholds[index]!)
            nodes[i]!.section = { label, confidence: probability, source: "model" };
        }
      }
    } else {
      let sectionValues: Float32Array | null = null;
      let sectionTokens: number[] | null = null;
      for (let i = 0; i < featurized.nodes.length; i++) {
        if ((i & 31) === 0 && Date.now() - started > budget) {
          degraded = degraded || `time budget ${budget}ms exceeded`;
          break;
        }
        const node = featurized.nodes[i]!;
        // A head reads the streams it declares (`tokenStreams`): the class/id stream always, the v2.3.0 text/attribute stream when declared.
        const nodeTokens = section.readsText
          ? mergeTokens(node.tokens, node.textTokens)
          : node.tokens;
        sectionValues = toVector(
          node.features,
          nodeTokens,
          usable!.nodeFeatureCount,
          sectionValues,
          sectionTokens,
        );
        sectionTokens = nodeTokens;
        scoreRow(section, sectionValues, sectionScores);
        const { index, probability } = softmax(sectionScores);
        const label = section.classes[index]!;
        if (label !== "none" && probability >= sectionThresholds[index]!)
          nodes[i]!.section = { label, confidence: probability, source: "model" };
      }
    }
  }

  // Comment threads, from the markup. MARKUP WINS here as it does for regions:
  // on linking pages the head finds a small share of the comment links the
  // rule finds, at a lower precision. It
  // runs whatever the budget did: it is a scan of the walk, not a model pass.
  const rule = commentRule();
  const commentSections = rule.outermost(elements, attributes).map(
    ({ index, match }): CommentSectionRef => ({
      nodeId: index,
      label: match.label,
      evidence: match.token,
    }),
  );
  // Only a node inside a thread can match. Finding those is a pointer walk;
  // reading markup for all 400 nodes is what costs.
  if (commentSections.length > 0) {
    const threads = new Set(commentSections.map((thread) => elements[thread.nodeId]));
    for (const node of nodes) {
      const element = elements[node.nodeRef.nodeId] as Element;
      if (!insideAny(element, threads)) continue;
      const match = rule.sectionOf(element);
      if (match)
        node.section = {
          label: match.label,
          confidence: 1,
          source: "rules",
          evidence: match.token,
        };
    }
  }

  if (timings) timings.sectionMs = lap();
  return { pageType, nodes, degraded, platform, commentSections };
}

function insideAny(element: Element, containers: ReadonlySet<unknown>): boolean {
  for (let el: Element | null = element; el; el = el.parentElement)
    if (containers.has(el)) return true;
  return false;
}

function withRules(
  node: NodeFeatures,
  byId: ReadonlyMap<number, NodeFeatures>,
): Prediction<RegionLabel> {
  const label = ruleRegion(node, byId);
  return { label, confidence: label === "unknown" ? 0 : 1, source: "rules" };
}

/** `toVector`'s row, written into a batch matrix at `offset`. `withText` adds the text/attribute stream (v2.3.0) for a head that declares it. */
function writeRow(
  matrix: Float32Array,
  offset: number,
  node: NodeFeatures,
  numericCount: number,
  withText = false,
): void {
  matrix.fill(0, offset + numericCount, offset + numericCount + TOKEN_BUCKETS);
  for (let i = 0; i < numericCount; i++) matrix[offset + i] = node.features[i] ?? 0;
  for (const bucket of node.tokens) matrix[offset + numericCount + bucket] = 1;
  if (withText) for (const bucket of node.textTokens) matrix[offset + numericCount + bucket] = 1;
}

/**
 * Numeric features followed by the one-hot token buckets, as one float32 row.
 *
 * The buffer is reused across nodes, and the token half is cleared by UNSETTING
 * the handful of buckets the previous node set rather than zeroing all 512 of
 * them. A page's 400 nodes set about 8 buckets each, so the naive `fill(0)`
 * was doing ~200k redundant writes per page for ~3k useful ones. The numeric
 * half needs no clearing: every one of its slots is written every time.
 */
export function toVector(
  features: number[],
  tokens: number[],
  numericCount: number,
  reuse: Float32Array | null,
  previousTokens: number[] | null,
): Float32Array {
  const width = numericCount + TOKEN_BUCKETS;
  const out = reuse && reuse.length === width ? reuse : new Float32Array(width);
  if (previousTokens && out === reuse) {
    for (const bucket of previousTokens) out[numericCount + bucket] = 0;
  } else {
    out.fill(0);
  }
  for (let i = 0; i < numericCount; i++) out[i] = features[i] ?? 0;
  for (const bucket of tokens) out[numericCount + bucket] = 1;
  return out;
}

/**
 * The page vector, extended by a head's extra block: the caller's values when
 * they are complete, NaN (missing) otherwise. A head without an extra block
 * gets the vector back untouched.
 */
export function withExtraBlock(
  base: Float32Array,
  extraCount: number,
  extra: ArrayLike<number> | null,
): Float32Array {
  if (extraCount === 0) return base;
  const out = new Float32Array(base.length + extraCount);
  out.set(base);
  const complete = extra !== null && extra.length === extraCount;
  for (let i = 0; i < extraCount; i++) out[base.length + i] = complete ? extra[i]! : Number.NaN;
  return out;
}

/** The region head's raw class probabilities for one node, for evaluation and
 *  for the parity fixture. Returns a copy, not the reused buffer. */
export function regionProbabilities(model: Model, node: NodeFeatures): Float32Array {
  const values = toVector(node.features, node.tokens, model.nodeFeatureCount, null, null);
  const scores = new Float32Array(model.region.numClass);
  scoreRow(model.region, values, scores);
  softmax(scores);
  return scores;
}
