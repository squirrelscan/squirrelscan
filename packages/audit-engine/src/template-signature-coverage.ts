// Cluster-coverage measurement for the fan-out signature (#1373). TOOLING ONLY:
// nothing in the audit path imports this, and `fanoutInputSignature` is unchanged.
//
// Question it answers: if the fan-out key were derived from EVERY selector and
// attribute the declared rules read (SIGNATURE_SELECTORS / SIGNATURE_ATTRIBUTES),
// instead of the hand-kept subset in `fanoutInputSignature`, how many pages would
// still share a cluster? The derived signature is the current one PLUS every
// attribute of every element those selectors match, so it only ever refines the
// current clusters: coverage can fall, never rise.
//
// READ THE RESULT AS A CEILING, NOT AN ESTIMATE, when the input is an authored or
// synthetic corpus: such pages are generated from a handful of templates and vary
// only in the ways the author chose, so the coverage measured there is an upper
// bound for a real site. The numbers that matter come from real crawls
// (`apps/cli/scripts/template-fanout-bench.ts --coverage`).

import { fingerprintPage, SIGNATURE_ATTRIBUTES, SIGNATURE_SELECTORS } from "@squirrelscan/rules";

import { parseHtmlForRules } from "./adapter";
import { fanoutClusterKey, fanoutInputSignature } from "./template-fanout";
import { templateFingerprintKey } from "./template-key";
import { fnv1a64 } from "./fingerprint";

export type SignatureMode = "current" | "derived";

interface Queryable {
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }>;
}

/**
 * The current signature refined with every read attribute of every element the
 * declared selectors match, in document order per selector. `null` for a page
 * with no document, like `fanoutInputSignature`. A selector the DOM rejects
 * throws: a silent skip would understate fragmentation.
 */
export function derivedFanoutSignature(doc: Queryable | null): string | null {
  const current = fanoutInputSignature(doc);
  if (!doc || current === null) return null;
  const reads = SIGNATURE_SELECTORS.map((selector) => [
    selector,
    Array.from(doc.querySelectorAll(selector), (el) =>
      SIGNATURE_ATTRIBUTES.map((name) => el.getAttribute(name)),
    ),
  ]);
  return fnv1a64(new TextEncoder().encode(JSON.stringify([current, reads])), 0n);
}

export interface CoveragePage {
  readonly url: string;
  readonly html: string;
}

export interface SignatureCoverage {
  readonly mode: SignatureMode;
  readonly pages: number;
  /** Pages with a usable key (a document and a fingerprint). */
  readonly keyed: number;
  readonly clusters: number;
  readonly singletons: number;
  /** Pages that would inherit a verdict: keyed pages minus clusters. */
  readonly fannedPages: number;
  /** fannedPages / pages, 0 for an empty input. */
  readonly coverage: number;
}

/** Incremental form of `measureSignatureCoverage`: feed pages one at a time. */
export interface CoverageAccumulator {
  /** Parse one page, record its fan-out key, and keep nothing of the HTML. */
  add(page: CoveragePage): void;
  result(): SignatureCoverage;
}

/**
 * Same measurement as `measureSignatureCoverage`, for callers that cannot hold
 * every page's HTML at once (a real crawl is gigabytes of it). Only the key
 * counts are retained, so memory grows with the number of clusters.
 */
export function createCoverageAccumulator(mode: SignatureMode): CoverageAccumulator {
  const sizes = new Map<string, number>();
  let total = 0;
  let keyed = 0;
  return {
    add({ url, html }) {
      total++;
      const parsed = parseHtmlForRules(html, url);
      const signature =
        mode === "derived"
          ? derivedFanoutSignature(parsed.document)
          : fanoutInputSignature(parsed.document);
      const key = fanoutClusterKey(
        templateFingerprintKey(fingerprintPage(parsed, url)),
        url,
        signature,
      );
      if (key === null) return;
      keyed++;
      sizes.set(key, (sizes.get(key) ?? 0) + 1);
    },
    result() {
      const clusters = sizes.size;
      const singletons = [...sizes.values()].filter((n) => n === 1).length;
      const fannedPages = keyed - clusters;
      return {
        mode,
        pages: total,
        keyed,
        clusters,
        singletons,
        fannedPages,
        coverage: total === 0 ? 0 : fannedPages / total,
      };
    },
  };
}

/**
 * Group pages by the fan-out key under `mode` and count what would fan out. Pure
 * over its input: parses each page once, no storage, no rule run.
 */
export function measureSignatureCoverage(
  pages: Iterable<CoveragePage>,
  mode: SignatureMode,
): SignatureCoverage {
  const acc = createCoverageAccumulator(mode);
  for (const page of pages) acc.add(page);
  return acc.result();
}
