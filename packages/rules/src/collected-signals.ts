// Page-time DOM-signal collection (#1021 E-E2) — the in-stream replacement for
// the `materializeDomSitePages` re-parse seam. The streaming engine (audit-engine
// streamPageRules) runs `buildCollectedPageSignal` once per page while that page's
// DOM is LIVE, accumulating a small per-page record; the six all-pages DOM-scanner
// site rules (leaked-secrets, total-byte-weight, template-discontinuity,
// integrity/orphan-page, adblock/blocked-links, legal/subprocessor-disclosure)
// then aggregate over the collected records via `ctx.collectedSignals` INSTEAD of
// re-materializing every DOM in the site pass.
//
// v1 (runRulesOnStorage) never sets `ctx.collectedSignals`, so each rule keeps its
// legacy `ctx.site.pages[].parsed.document` fallback and stays byte-identical.
// Each rule's page-time extractor lives with the rule it feeds (scanPageForSecrets,
// extractPageByteSignal, fingerprintPage/detectPageSignals, pageScriptSrcs,
// matchSubprocessorLink) so the collected value and the legacy value are produced
// by the SAME code — the per-rule byte-identical golden gate.

import type { IntegritySignal, PageSignalContext } from "./integrity/signals";
import type { LeakedSecret } from "./security/leaked-secrets";
import type { PageFingerprint } from "./integrity/fingerprint";
import type { ParsedPage } from "./types";

import { detectPageSignals } from "./integrity/signals";
import { extractPageByteSignal } from "./performance/total-byte-weight";
import { fingerprintPage } from "./integrity/fingerprint";
import { matchSubprocessorLink } from "./legal/subprocessor-disclosure";
import { pageScriptSrcs } from "./adblock/blocked-links";
import { scanPageForSecrets } from "./security/leaked-secrets";

/**
 * The per-page DOM-derived signal for the six all-pages site rules, captured while
 * the page's DOM is live. Every field is bounded (no live `Document` retained), so
 * a 25k-page stream holds these records instead of 25k DOMs.
 */
export interface CollectedPageSignal {
  /** The page's stored identity URL — `PageRecord.normalizedUrl`, the same value
   *  the legacy site rules read as `site.pages[].url`. */
  url: string;
  /** leaked-secrets: HTML + inline-script scan results, in the legacy scan order. */
  secrets: LeakedSecret[];
  /** total-byte-weight: summed inline `<style>` / inline `<script>` text lengths. */
  inlineCssLen: number;
  inlineJsLen: number;
  /** total-byte-weight estimate branch (used only for the first collected page). */
  externalCssCount: number;
  externalJsCount: number;
  imageCount: number;
  /** template-discontinuity: per-page template fingerprint (null if no document). */
  fingerprint: PageFingerprint | null;
  /** integrity signals shared by orphan-page + template-discontinuity escalation. */
  signals: IntegritySignal[];
  /** adblock: raw `<script src>` attribute values, for findSourcePages attribution. */
  scriptSrcs: string[];
  /** subprocessor-disclosure: the first sub-processor/DPA link match on this page
   *  (`href || url`), or null — mirrors the legacy break-on-first-match. */
  subprocessorMatch: string | null;
}

/** The collected per-page signals for one crawl, in page-stream (crawl) order. */
export interface CollectedSiteSignals {
  pages: CollectedPageSignal[];
}

/**
 * Build the per-page signal from a live parsed page. Called once per auditable
 * page during the stream (DOM live). Delegates every extraction to the owning
 * rule's exported helper so the collected value equals the legacy site-pass value.
 */
export function buildCollectedPageSignal(input: {
  url: string;
  finalUrl?: string;
  parsed: ParsedPage;
}): CollectedPageSignal {
  const { url, finalUrl, parsed } = input;
  const doc = parsed.document;

  if (!doc) {
    return {
      url,
      secrets: [],
      inlineCssLen: 0,
      inlineJsLen: 0,
      externalCssCount: 0,
      externalJsCount: 0,
      imageCount: 0,
      fingerprint: null,
      signals: [],
      scriptSrcs: [],
      subprocessorMatch: null,
    };
  }

  // detectPageSignals reads only ctx.parsed + ctx.page.url/finalUrl — the collector
  // builds exactly that subset (PageSignalContext), so there is no cast and a future
  // detector that reaches for another ctx field is a compile error here, not a
  // silent golden-only divergence between the collector and the legacy site pass.
  const signalCtx: PageSignalContext = { parsed, page: { url, finalUrl } };

  const byteSignal = extractPageByteSignal(doc);

  return {
    url,
    secrets: scanPageForSecrets(doc, url),
    inlineCssLen: byteSignal.inlineCssLen,
    inlineJsLen: byteSignal.inlineJsLen,
    externalCssCount: byteSignal.externalCssCount,
    externalJsCount: byteSignal.externalJsCount,
    imageCount: byteSignal.imageCount,
    fingerprint: fingerprintPage(parsed, url),
    signals: [...detectPageSignals(signalCtx)],
    scriptSrcs: pageScriptSrcs(doc),
    subprocessorMatch: matchSubprocessorLink(doc, url),
  };
}
