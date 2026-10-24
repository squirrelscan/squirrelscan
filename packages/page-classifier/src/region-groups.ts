// The site-chrome fallback for region nodes the class thresholds leave unknown.
//
// The strict per-class thresholds answer 44% of nodes (precision 0.957 against the training labels) and
// leave 56% `unknown`, including every link in a page's furniture the model could see but not NAME:
// "header, footer, nav or sidebar" is often certain when "which of the four" is not. This module
// answers that coarser question: when the SUM of the four chrome classes' probabilities reaches
// `SITE_CHROME_THRESHOLD`, the node is `site_chrome`.
//
// Measured on the region head's 5-fold out-of-fold probabilities (5.4M evaluated nodes,
// domain-grouped folds):
//
//   threshold   nodes the fallback answers   precision   worst fold
//   0.70        31.9% of all nodes           0.954       0.945
//   0.80        29.4%                        0.965       0.961      <- adopted
//   0.90        25.0%                        0.977       0.974
//
// At 0.70 every major platform is at 0.94 or better (0.950 on the older slice, 0.966 on the newer); 0.80 keeps a margin.
// With it the answered share goes from 44% to 73%. Two siblings were measured and rejected:
//   - a content group (main_content, content_block, article_chrome): never reaches 0.95 (0.856 at 0.90);
//   - a form/search/dialog group: 0.956 overall at 0.90, but 0.87 on custom sites and 0.28 on Nuxt.
// What stays `unknown` is mostly page content, which is the useful signal for "this link is not in the
// furniture", but the runtime does not claim it.

export const SITE_CHROME_CLASSES = ["site_header", "footer", "navigation", "sidebar"] as const;
export const SITE_CHROME_THRESHOLD = 0.8;

/**
 * Indices of the chrome classes in a head's class list (empty when it lacks any). With the head's
 * thresholds for this page, a class the guard abstains (a threshold above 1: the platform guard says
 * the model is unreliable for it here) does not count towards the group, so the fallback never
 * overrides a deliberate abstention.
 */
export function chromeIndices(
  classes: readonly string[],
  thresholds?: ArrayLike<number>,
): number[] {
  return SITE_CHROME_CLASSES.map((name) => classes.indexOf(name)).filter(
    (i) => i >= 0 && (thresholds === undefined || thresholds[i]! <= 1),
  );
}

/** The probability mass on the chrome classes, from softmaxed probabilities. */
export function chromeMass(probabilities: ArrayLike<number>, indices: readonly number[]): number {
  let mass = 0;
  for (const i of indices) mass += probabilities[i]!;
  return mass;
}
