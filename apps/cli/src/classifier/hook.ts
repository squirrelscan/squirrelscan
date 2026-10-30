// The parser hook for the bundled page classifier (#2307).

import type { PageClassifierHook } from "@squirrelscan/parser";

import {
  CLASSIFIER_RULES_VERSION,
  FEATURIZER_VERSION,
  classifyDocument,
  elementPlacer,
} from "@squirrelscan/page-classifier";

import { logger } from "@/utils/logger";

import { BUNDLED_ARTIFACT_MANIFEST } from "./artifact";
import { loadBundledClassifier } from "./index";

/** What identifies the bundled classifier: model hash, featurizer and rules version. Needs no model load. */
export function bundledClassifierVersion(): string {
  return `${BUNDLED_ARTIFACT_MANIFEST.sha256.slice(0, 12)}:${FEATURIZER_VERSION}:r${CLASSIFIER_RULES_VERSION}`;
}

export interface ClassifierHookOptions {
  /** Per-page wall-clock budget in ms; the classifier's own default (500) when omitted. */
  budgetMs?: number;
}

/**
 * The parser hook: classify one parsed page with the bundled model.
 *
 * Returns null (the page is left to the markup rules alone) when the model is unavailable. A page
 * the model could only partly answer still returns its answers, with the reason on
 * `classification.degraded`.
 */
export function createPageClassifierHook(
  options: ClassifierHookOptions = {}
): PageClassifierHook {
  const version = bundledClassifierVersion();
  const classify = ({
    document,
    url,
    html,
  }: Parameters<PageClassifierHook>[0]): ReturnType<PageClassifierHook> => {
    const { model } = loadBundledClassifier();
    if (!model) return null;
    const elements: unknown[] = [];
    const result = classifyDocument(document, url, {
      model,
      html,
      elementsOut: elements,
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    });
    if (result.degraded)
      logger.debug("page classifier degraded", url, result.degraded);
    const place = elementPlacer(result, elements);
    return {
      classification: {
        pageType: {
          label: result.pageType.label,
          confidence: Math.round(result.pageType.confidence * 1000) / 1000,
          source: result.pageType.source,
        },
        degraded: result.degraded,
        model: version,
      },
      placeLink: (element) => place(element),
    };
  };
  return Object.assign(classify, { version });
}
