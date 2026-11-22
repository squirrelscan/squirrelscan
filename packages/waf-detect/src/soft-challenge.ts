import { CHALLENGE_INTERSTITIAL_MAX_TEXT } from "./providers";
import { signatureViews } from "./views";
import { visibleTextLength } from "./visible-text";

/**
 * Generic "prove you are a browser" wording on interstitials no provider
 * signature names (#2250). Matched only on a tiny-text document, so a page that
 * merely quotes a phrase in real content is never read as a challenge.
 */
const SOFT_CHALLENGE_WORDING = [
  /checking (?:your|if you are|that you are)\b[^<]{0,40}\b(?:browser|human)/i,
  /verify(?:ing)? (?:that )?you are (?:a )?human/i,
  /(?:enable|turn on) javascript (?:and cookies )?to (?:continue|proceed|view)/i,
  /please (?:wait|stand by) while we (?:check|verify|confirm)/i,
  /just a moment/i,
];

export interface SoftChallengeResult {
  detected: boolean;
  /** From a fixed vocabulary, never a slice of the page. */
  signal: string | null;
}

/**
 * Whether the ONLY page a crawl fetched, served with a 2xx, reads as a bot
 * challenge or empty shell instead of the site (#2250). Deliberately narrower
 * than a signature match: the caller applies it only to a one-page crawl, and it
 * needs a tiny visible-text body plus either no document structure at all (no
 * doctype and no html element) or generic challenge wording.
 */
export function detectSoftChallengeEntry(
  status: number,
  html: string | null
): SoftChallengeResult {
  const none: SoftChallengeResult = { detected: false, signal: null };
  if (status < 200 || status > 299 || !html) return none;
  if (visibleTextLength(html) > CHALLENGE_INTERSTITIAL_MAX_TEXT) return none;
  const head = html.slice(0, 20480);
  const views = signatureViews(head);
  if (SOFT_CHALLENGE_WORDING.some((p) => p.test(views.text))) {
    return {
      detected: true,
      signal: "challenge wording on the only page fetched",
    };
  }
  const hasDoctype = /<!doctype\s+html/i.test(head);
  const hasHtml = /<html[\s>]/i.test(head);
  if (!hasDoctype && !hasHtml) {
    return {
      detected: true,
      signal: "the only page fetched has no doctype or html element",
    };
  }
  return none;
}
