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

import { hasJavaScriptDetections } from "@squirrelscan/utils/cdn";

import type { PageMisspellings } from "./content/common-misspellings";
import type { HreflangPageSignal } from "./i18n/hreflang-signal";
import type { PageFingerprint } from "./integrity/fingerprint";
import type { IntegritySignal, PageSignalContext } from "./integrity/signals";
import type { PageAnchorSignal } from "./links/page-anchors";
import type { LeakedSecret } from "./security/leaked-secrets";
import type { NextDataInfo } from "./security/next-data-exposure";
import type { InPageSectionSignal } from "./shared/inpage-section";
import type { ParsedPage } from "./types";

import { pageScriptSrcs } from "./adblock/blocked-links";
import {
  extractColorUsage,
  type ColorUsageSignal,
} from "./content/color-sprawl";
import { scanPageForMisspellings } from "./content/common-misspellings";
import {
  fingerprintForPage,
  type ContentFingerprint,
} from "./content/duplicate-content";
import {
  extractFontUsage,
  type FontUsageSignal,
} from "./content/font-consistency";
import { buildHreflangSignal } from "./i18n/hreflang-signal";
import { fingerprintPage } from "./integrity/fingerprint";
import { detectPageSignals } from "./integrity/signals";
import {
  hasCommercialOfferLink,
  matchSubprocessorLink,
} from "./legal/subprocessor-disclosure";
import { buildPageAnchorSignal } from "./links/page-anchors";
import { logger, profileRules } from "./logger";
import { extractPageByteSignal } from "./performance/total-byte-weight";
import {
  RULE_TIME_BUDGET_MS,
  RuleTimeoutError,
  runWithinBudget,
} from "./rule-budget";
import {
  startPageScan,
  type SiteFindingBudget,
} from "./security/leaked-secrets";
import { readNextDataFromDocument } from "./security/next-data-exposure";
import { extractContentSentences } from "./shared/content-in-script";
import { detached, detachedList, detachedSet } from "./shared/detach";
import { buildInPageSectionSignal } from "./shared/inpage-section";

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
  /** leaked-secrets: findings past the per-page cap that were not kept (#1554); absent when none. */
  secretsOmitted?: number;
  /** Whether any omitted finding was more serious than public or informational; absent reads as true (unknown). */
  secretsOmittedSerious?: boolean;
  /** total-byte-weight: summed inline `<style>` / inline `<script>` text lengths. */
  inlineCssLen: number;
  inlineJsLen: number;
  /** total-byte-weight: the stored HTML response size. Absent on a snapshot
   *  cached before it was collected, which reads as 0 bytes. */
  htmlBytes?: number;
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
  /** content/common-misspellings: the page's English-text scan (absent on a
   *  snapshot cached before it was collected, which reads as no findings). */
  misspellings?: PageMisspellings;
  /** subprocessor-disclosure: whether this page links to a commercial offer
   *  (pricing, plans, enterprise, trust center, contact sales, book a demo). */
  commercialOffer: boolean;
  /**
   * links/broken-anchors: the page's distinct ids and `<a name>` values, and its
   * skip-link fragments (page-anchors.ts). Null when the page has no document.
   * Absent on a record cached before the field existed, which reads as unjudged.
   */
  anchors?: PageAnchorSignal | null;
  /**
   * eeat/about-page + eeat/contact-page: the page's in-page About and Contact sections
   * (an id matching the page slugs plus a same-page link to it). Null when the page has
   * no document. Absent on a record cached before the field existed, which reads as none (#1236).
   */
  inPageSections?: InPageSectionSignal | null;
  /**
   * perf/content-in-js-bundle: a few distinctive sentences of the page's main content
   * (single text nodes of ten or more words), searched for in the site's JS chunks.
   * Absent on a record cached before the field existed, which reads as not judged.
   */
  contentSentences?: string[];
  /**
   * The page was browser-rendered, so `contentSentences` is empty by design (its copy is in the script that
   * rendered it), not because the page has none. Lets perf/content-in-js-bundle tell "nothing to search for"
   * from "not searched" on an audit where every page was rendered. Absent otherwise.
   */
  contentRendered?: true;
  /**
   * Edge-network markers found in the page (perf/bad-caching, #605): `"cf-jsd"` when Cloudflare
   * JavaScript Detections is injected. Absent on a record cached before the field existed, which
   * reads as none found.
   */
  edgeMarkers?: string[];
  /**
   * i18n/hreflang-targets: the page's hreflang alternates, noindex source and resolved canonical,
   * read from the parsed page and headers (no DOM). Absent on a record cached before the field
   * existed, which reads as not judged.
   */
  hreflang?: HreflangPageSignal;
  /**
   * content/duplicate-content: hash and word count of the page's rendered body text. Null when the
   * page has no body or is a redirect. Absent on a record cached before the field existed, which
   * reads as not judged.
   */
  contentFingerprint?: ContentFingerprint | null;
  /**
   * content/font-consistency: the font families and @font-face rules the page's inline styles
   * declare. Absent on a record cached before the field existed, which reads as nothing declared.
   */
  fontUsage?: FontUsageSignal;
  /**
   * content/color-sprawl: the color literals the page's inline styles use, with token definitions
   * counted apart. Absent on a record cached before the field existed, which reads as none declared.
   */
  colorUsage?: ColorUsageSignal;
  /**
   * security/next-data-exposure: the buildId and locale of the page's `__NEXT_DATA__` script when its
   * props are server-rendered, else null. Absent on a record cached before the field existed, which
   * the rule reads from the page's own document instead.
   */
  nextData?: NextDataInfo | null;
  /**
   * Rules whose page-time extractor ran past its time budget on this page and was
   * abandoned (its field holds the empty value). The site pass records each as a
   * rule error for this page. Absent when nothing timed out.
   */
  timedOut?: {
    budgetMs: number;
    ruleIds: string[];
    /** Observed ms per rule id before it was stopped (pub#960). */ elapsedMs?: Record<
      string,
      number
    >;
  };
}

/** The collected per-page signals for one crawl, in page-stream (crawl) order. */
export interface CollectedSiteSignals {
  pages: CollectedPageSignal[];
  /** The crawl's one budget of kept leaked-secrets findings (#1568); the rule shares it for external scripts. */
  secretsBudget?: SiteFindingBudget;
}

/** The fingerprint with every string copied out of the page (a new object: the caller's own is left as it is). */
export function detachFingerprint(
  fp: PageFingerprint | null
): PageFingerprint | null {
  if (!fp) return fp;
  return {
    ...fp,
    assetHosts: detachedSet(fp.assetHosts),
    resourceHosts: detachedSet(fp.resourceHosts),
    codeHosts: detachedSet(fp.codeHosts),
    bodyClasses: detachedSet(fp.bodyClasses),
    cssVars: detachedSet(fp.cssVars),
    stylesheetHrefs: detachedSet(fp.stylesheetHrefs),
  };
}

/** The anchor signal with every string copied out of the page. */
export function detachAnchors(
  a: PageAnchorSignal | null
): PageAnchorSignal | null {
  if (!a) return a;
  return {
    ...a,
    ids: detachedList(a.ids),
    skipFragments: detachedList(a.skipFragments),
    selfFragments: detachedList(a.selfFragments),
    ...(a.scriptIds ? { scriptIds: detachedList(a.scriptIds) } : {}),
  };
}

/** The font signal with every string copied out of the page. */
export function detachFontUsage(f: FontUsageSignal): FontUsageSignal {
  return {
    families: detachedList(f.families),
    referenced: detachedList(f.referenced),
    faces: f.faces.map((x) => ({
      family: detached(x.family),
      weight: detached(x.weight),
      style: detached(x.style),
    })),
    linkedStylesheets: f.linkedStylesheets,
  };
}

/** The color signal with every string copied out of the page. */
export function detachColorUsage(c: ColorUsageSignal): ColorUsageSignal {
  return {
    colors: detachedList(c.colors),
    tokenColors: c.tokenColors,
    varRefs: c.varRefs,
    linkedStylesheets: c.linkedStylesheets,
  };
}

/** The Next.js build info with every string copied out of the page. */
export function detachNextData(n: NextDataInfo | null): NextDataInfo | null {
  if (!n) return n;
  return {
    buildId: detached(n.buildId),
    locale: n.locale === null ? null : detached(n.locale),
  };
}

/** The hreflang signal with every string copied out of the page. */
export function detachHreflang(h: HreflangPageSignal): HreflangPageSignal {
  return {
    alternates: h.alternates.map((a) => ({
      hreflang: detached(a.hreflang),
      href: detached(a.href),
    })),
    noindex: h.noindex,
    canonical: h.canonical === null ? null : detached(h.canonical),
  };
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
  /**
   * The page's already-computed chrome fingerprint, when the caller built one.
   * The streamed loop needs the SAME fingerprint for `page_features`' template
   * cluster key (#1949), and `fingerprintPage` is five `querySelectorAll` passes
   * over the live DOM — computing it in both places would put a second DOM walk
   * per page back into the pipeline #1913 exists to keep flat. Passing
   * `undefined` (or omitting it) computes it here, as before.
   */
  fingerprint?: PageFingerprint | null;
  /** Time budget (ms) per extractor; defaults to {@link RULE_TIME_BUDGET_MS}. */
  budgetMs?: number;
  /** The page's stored HTML response size in bytes, when the crawler recorded it. */
  htmlBytes?: number | null;
  /** The page's HTML came from a browser render (links/broken-anchors reads it). */
  rendered?: boolean;
  /** The page's response headers, for the X-Robots-Tag noindex read by i18n/hreflang-targets. */
  headers?: Record<string, string>;
}): CollectedPageSignal {
  const { url, finalUrl, parsed } = input;
  const htmlBytes = input.htmlBytes ?? 0;
  const doc = parsed.document;

  if (!doc) {
    return {
      url,
      secrets: [],
      inlineCssLen: 0,
      inlineJsLen: 0,
      htmlBytes,
      externalCssCount: 0,
      externalJsCount: 0,
      imageCount: 0,
      fingerprint: null,
      signals: [],
      scriptSrcs: [],
      subprocessorMatch: null,
      commercialOffer: false,
      anchors: null,
      inPageSections: null,
      misspellings: { english: false, occurrences: [] },
      contentSentences: [],
      edgeMarkers: [],
      hreflang: buildHreflangSignal(parsed, input.headers, url),
      contentFingerprint: null,
      nextData: null,
      fontUsage: {
        families: [],
        referenced: [],
        faces: [],
        linkedStylesheets: false,
      },
      colorUsage: {
        colors: [],
        tokenColors: 0,
        varRefs: 0,
        linkedStylesheets: false,
      },
    };
  }

  // detectPageSignals reads only ctx.parsed + ctx.page.url/finalUrl — the collector
  // builds exactly that subset (PageSignalContext), so there is no cast and a future
  // detector that reaches for another ctx field is a compile error here, not a
  // silent golden-only divergence between the collector and the legacy site pass.
  const signalCtx: PageSignalContext = { parsed, page: { url, finalUrl } };

  // The collector moved six site rules' per-page DOM work OUT of the site pass,
  // which also moved it out of the per-rule profile: leaked-secrets' ~100 ms/page
  // scan stopped showing up anywhere (#1864). Time each extractor under
  // SQUIRREL_RULE_PROFILE and report it against the rule that owns it, so the
  // profile still accounts for the page's whole rules-phase cost.
  //
  // Each extractor is a rule's per-page work over untrusted content, so it runs
  // under the same per-rule time budget the runner applies (rule-budget.ts). One
  // that runs past it yields its empty value and is listed in `timedOut`.
  const budgetMs = input.budgetMs ?? RULE_TIME_BUDGET_MS;
  const timedOutRuleIds: string[] = [];
  const timedOutElapsedMs: Record<string, number> = {};
  const timed = <T>(ruleId: string, fallback: T, fn: () => T): T => {
    const started = profileRules ? performance.now() : 0;
    let out: T;
    try {
      out = runWithinBudget(fn, budgetMs);
    } catch (e) {
      if (!(e instanceof RuleTimeoutError)) throw e;
      logger.warn("rule timed out", {
        ruleId,
        scope: "collect",
        pageUrl: url,
        budgetMs,
        elapsedMs: e.elapsedMs,
      });
      if (!timedOutRuleIds.includes(ruleId)) timedOutRuleIds.push(ruleId);
      if (e.elapsedMs !== undefined) timedOutElapsedMs[ruleId] = e.elapsedMs;
      out = fallback;
    }
    if (profileRules) {
      const elapsedMs = performance.now() - started;
      logger.debug("rule", {
        ruleId,
        scope: "collect",
        pageUrl: url,
        checks: 0,
        passed: 0,
        failed: 0,
        warned: 0,
        durationMs: Math.round(elapsedMs),
        durationUs: Math.round(elapsedMs * 1000),
      });
    }
    return out;
  };

  const byteSignal = timed(
    "perf/total-byte-weight",
    {
      inlineCssLen: 0,
      inlineJsLen: 0,
      externalCssCount: 0,
      externalJsCount: 0,
      imageCount: 0,
    },
    () => extractPageByteSignal(doc)
  );

  // The scan's findings live outside the budgeted call: a scan stopped at the budget keeps what it found before the stop
  // (the page is still listed in `timedOut`, so the rest of it reads as unscanned, not clean) (#1556).
  const secretScan = startPageScan(doc, url);
  timed("security/leaked-secrets", undefined, () => secretScan.run());
  const scanned = secretScan.result();
  const signal: CollectedPageSignal = {
    url,
    secrets: scanned.secrets,
    ...(scanned.omitted > 0
      ? {
          secretsOmitted: scanned.omitted,
          secretsOmittedSerious: scanned.omittedSerious,
        }
      : {}),
    inlineCssLen: byteSignal.inlineCssLen,
    inlineJsLen: byteSignal.inlineJsLen,
    htmlBytes,
    externalCssCount: byteSignal.externalCssCount,
    externalJsCount: byteSignal.externalJsCount,
    imageCount: byteSignal.imageCount,
    // Only the branch that actually computes is timed: a caller that hands in a
    // fingerprint (#1949) does no work here and should not be charged for one.
    // Fingerprint, script sources and anchors hold attribute and text slices of the page: copied so the record does not keep it (#1565).
    // A supplied fingerprint is the caller's own (the streaming loop shares one per page and detaches it where it builds it, #1565):
    // it is kept as handed in. One computed here is copied out of the page.
    fingerprint:
      input.fingerprint !== undefined
        ? input.fingerprint
        : detachFingerprint(
            timed("integrity/template-discontinuity", null, () =>
              fingerprintPage(parsed, url)
            )
          ),
    signals: timed("integrity/orphan-page", [], () => [
      ...detectPageSignals(signalCtx),
    ]),
    scriptSrcs: detachedList(
      timed("adblock/blocked-links", [] as string[], () => pageScriptSrcs(doc))
    ),
    subprocessorMatch: timed("legal/subprocessor-disclosure", null, () =>
      matchSubprocessorLink(doc, url)
    ),
    commercialOffer: timed("legal/subprocessor-disclosure", false, () =>
      hasCommercialOfferLink(doc)
    ),
    anchors: detachAnchors(
      timed("links/broken-anchors", null, () =>
        buildPageAnchorSignal({ parsed, rendered: input.rendered === true })
      )
    ),
    inPageSections: timed("eeat/about-page", null, () =>
      buildInPageSectionSignal(doc)
    ),
    misspellings: timed(
      "content/common-misspellings",
      { english: false, occurrences: [] },
      () => scanPageForMisspellings(doc)
    ),
    // A browser-rendered page has its copy in the script that rendered it, by necessity: no sentences.
    contentSentences:
      input.rendered === true
        ? []
        : timed("perf/content-in-js-bundle", [] as string[], () =>
            extractContentSentences(doc)
          ),
    ...(input.rendered === true ? { contentRendered: true as const } : {}),
    edgeMarkers: timed("perf/bad-caching", [] as string[], () =>
      hasJavaScriptDetections(doc) ? ["cf-jsd"] : []
    ),
    // Strings cut from the page are copied so the record does not keep it (#1565).
    hreflang: detachHreflang(buildHreflangSignal(parsed, input.headers, url)),
    contentFingerprint: timed(
      "content/duplicate-content",
      null as ContentFingerprint | null,
      () => fingerprintForPage(doc, url, finalUrl)
    ),
    nextData: detachNextData(
      timed("security/next-data-exposure", null, () =>
        readNextDataFromDocument(doc)
      )
    ),
    fontUsage: detachFontUsage(
      timed("content/font-consistency", extractFontUsage(null), () =>
        extractFontUsage(doc)
      )
    ),
    colorUsage: detachColorUsage(
      timed("content/color-sprawl", extractColorUsage(null), () =>
        extractColorUsage(doc)
      )
    ),
  };
  // The one record serves both rules: a timeout is reported against both.
  if (timedOutRuleIds.includes("eeat/about-page"))
    timedOutRuleIds.push("eeat/contact-page");
  if (timedOutRuleIds.length > 0) {
    signal.timedOut = { budgetMs, ruleIds: timedOutRuleIds };
    if (Object.keys(timedOutElapsedMs).length > 0)
      signal.timedOut.elapsedMs = timedOutElapsedMs;
  }
  return signal;
}

/**
 * The page's record as the crawl's list keeps it: its findings pass through the crawl's site budget (#1568), and the ones
 * the site had no room for are counted in `secretsOmitted`. The record the rule cache stores is the page's own, untouched:
 * the decision depends on the pages before it, so it belongs to this crawl and not to the page.
 */
export function applySiteFindingBudget(
  signal: CollectedPageSignal,
  budget: SiteFindingBudget
): CollectedPageSignal {
  if (signal.secrets.length === 0) return signal;
  const admitted = budget.admit(signal.secrets);
  if (
    admitted.omitted === 0 &&
    admitted.secrets.length === signal.secrets.length
  )
    return signal;
  const omitted = (signal.secretsOmitted ?? 0) + admitted.omitted;
  const { secretsOmitted: _a, secretsOmittedSerious: _b, ...rest } = signal;
  void [_a, _b];
  const serious =
    admitted.omittedSerious ||
    (signal.secretsOmitted ? (signal.secretsOmittedSerious ?? true) : false);
  return {
    ...rest,
    secrets: admitted.secrets,
    ...(omitted > 0
      ? { secretsOmitted: omitted, secretsOmittedSerious: serious }
      : {}),
  };
}

export {
  createSiteFindingBudget,
  SITE_FINDINGS_CAP,
  type SiteFindingBudget,
} from "./security/leaked-secrets";
