// Count plus sample for checks whose items are page URLs and can run to the
// length of a sitemap (repo#2320): one 250,000-URL list made a single check
// most of an 80 MB report.

import type { CheckItem } from "@squirrelscan/core-contracts";
import { PUBLISH_LIMITS } from "@squirrelscan/core-contracts/limits";

/** The sample a capped check keeps: what a published report shows anyway. */
export const URL_ITEM_SAMPLE = PUBLISH_LIMITS.maxItems;

export interface SampledUrlItems {
  items: CheckItem[];
  /**
   * Spread into the check's `details`. Empty when nothing was dropped;
   * otherwise `additional` (items dropped) and, when the sample leaves pages
   * out, `pagesTruncated` (the true number of distinct URLs), which every
   * renderer reads as the affected-page count and the reason
   * `affectedPagesHasMore` is set.
   */
  truncation: { additional?: number; pagesTruncated?: number };
}

/**
 * The first {@link URL_ITEM_SAMPLE} of `items`. `total` is the real item count
 * when `items` arrived already cut short upstream, and `distinctTotal` the
 * number of distinct URLs among them when an id can repeat (a sitemap can
 * list one URL twice); both default to what `items` holds.
 */
export function sampleUrlItems(
  items: readonly CheckItem[],
  total: number = items.length,
  distinctTotal: number = total
): SampledUrlItems {
  const count = Math.max(total, items.length);
  const sample = items.slice(0, URL_ITEM_SAMPLE);
  if (count <= sample.length) return { items: sample, truncation: {} };
  const sampledPages = new Set(sample.map((item) => item.id)).size;
  return {
    items: sample,
    truncation: {
      additional: count - sample.length,
      ...(distinctTotal > sampledPages ? { pagesTruncated: distinctTotal } : {}),
    },
  };
}
