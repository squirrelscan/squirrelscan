// local/nap-consistency - NAP (Name, Address, Phone) consistency
//
// Two families of check:
//   1. Presence - LocalBusiness/Organization schema, contact-page tel:/mailto:.
//   2. Cross-page drift (#1373) - the same phone/address rendered inconsistently
//      across the site, or a genuinely different primary contact on some pages.
//
// The drift half only fires behind a normalisation guard (NAP_DRIFT_MIN_PAGES /
// NAP_MODAL_MIN_AGREEMENT): a site legitimately listing several branch numbers
// must not be accused of inconsistency, so we need both enough samples AND a clear
// modal norm before calling anything a deviation.
//
// Dual path: `ctx.siteQuery` streams the per-page NAP scalars out of page_features;
// the legacy path re-derives them from `ctx.site.pages`. Both feed ONE accumulator
// and ONE check builder, and both read the SAME extractor (`extractNapSignal`), so
// the two paths are byte-identical by construction.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { CheckItem, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";
import type { NapSignal } from "@squirrelscan/utils";

import { extractNapSignal, getPathname, NAP_BUSINESS_SCHEMA_TYPES } from "@squirrelscan/utils";

/**
 * Minimum number of pages that must DECLARE a signal before drift is judged. The
 * floor is on samples, not on crawl size: a 500-page site where three pages carry
 * a phone number cannot support a "this site is inconsistent" claim. It is also
 * the count both paths agree on exactly, since the crawl-wide page count differs
 * by the error pages v1 appends to `site.pages`.
 */
export const NAP_DRIFT_MIN_PAGES = 10;

/**
 * Share of samples that must agree before the majority value is treated as the
 * site's norm. Below this the site is genuinely heterogeneous (multi-location,
 * franchise directory) and no page is a "deviant", so the check skips.
 */
export const NAP_MODAL_MIN_AGREEMENT = 0.7;

/** Caps on reported items / example URLs, so one rule cannot bloat a report. */
const NAP_MAX_ITEMS = 10;
const NAP_MAX_SAMPLE_URLS = 10;

/** One page's contribution, from either path. */
interface NapPageRecord {
  url: string;
  schemaTypes: string[];
  nap: NapSignal;
}

/** Per-value rollup for one signal (phone or address). */
interface NapKeyBucket {
  count: number;
  urls: string[];
  /** Display form -> how many pages rendered it that way (url list capped). */
  formats: Map<string, { count: number; urls: string[] }>;
}

/**
 * Rollup of one signal across the crawl. Only DISTINCT values and renderings are
 * held, and every url list is capped at {@link NAP_MAX_SAMPLE_URLS}, so a 100k-page
 * site with one phone number costs one entry — the resident size tracks how varied
 * the site's contact data is, not how many pages it has.
 */
interface NapSignalRollup {
  sampleCount: number;
  byKey: Map<string, NapKeyBucket>;
}

interface NapRollup {
  pageCount: number;
  hasLocalBusiness: boolean;
  businessName: string | null;
  /** First contact-ish page in crawl order, and whether it carries contact links. */
  contactPageSeen: boolean;
  contactPageHasContact: boolean;
  phone: NapSignalRollup;
  address: NapSignalRollup;
}

function emptySignalRollup(): NapSignalRollup {
  return { sampleCount: 0, byKey: new Map() };
}

function emptyRollup(): NapRollup {
  return {
    pageCount: 0,
    hasLocalBusiness: false,
    businessName: null,
    contactPageSeen: false,
    contactPageHasContact: false,
    phone: emptySignalRollup(),
    address: emptySignalRollup(),
  };
}

/** Record one page's primary value for a signal; `key`/`display` come in pairs. */
function accumulateSignal(
  rollup: NapSignalRollup,
  key: string | null,
  display: string | null,
  url: string
): void {
  if (!key || !display) return;
  rollup.sampleCount += 1;
  let bucket = rollup.byKey.get(key);
  if (!bucket) {
    bucket = { count: 0, urls: [], formats: new Map() };
    rollup.byKey.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.urls.length < NAP_MAX_SAMPLE_URLS) bucket.urls.push(url);
  const format = bucket.formats.get(display);
  if (format) {
    format.count += 1;
    if (format.urls.length < NAP_MAX_SAMPLE_URLS) format.urls.push(url);
  } else {
    bucket.formats.set(display, { count: 1, urls: [url] });
  }
}

/**
 * Fold one page into the rollup. Both paths call this in crawl order (normalized
 * url ascending), so every "first page that ..." decision below matches.
 */
function accumulatePage(rollup: NapRollup, record: NapPageRecord): void {
  rollup.pageCount += 1;

  if (
    !rollup.hasLocalBusiness &&
    record.schemaTypes.some((type) => NAP_BUSINESS_SCHEMA_TYPES.includes(type))
  ) {
    rollup.hasLocalBusiness = true;
    rollup.businessName = record.nap.name;
  }

  if (!rollup.contactPageSeen && /\/contact/i.test(getPathname(record.url))) {
    rollup.contactPageSeen = true;
    rollup.contactPageHasContact = record.nap.telLink || record.nap.mailtoLink;
  }

  // A page's FIRST phone is its primary contact number. Counting every number on
  // every page would make any site carrying a branch list look inconsistent.
  accumulateSignal(
    rollup.phone,
    record.nap.phones[0] ?? null,
    record.nap.phoneFormats[0] ?? null,
    record.url
  );
  accumulateSignal(rollup.address, record.nap.address, record.nap.addressFormat, record.url);
}

/** Highest count wins; ties break on the key, so the pick never depends on order. */
function modalEntry(byKey: Map<string, NapKeyBucket>): { key: string; bucket: NapKeyBucket } | null {
  let best: { key: string; bucket: NapKeyBucket } | null = null;
  for (const [key, bucket] of byKey) {
    if (
      !best ||
      bucket.count > best.bucket.count ||
      (bucket.count === best.bucket.count && key < best.key)
    ) {
      best = { key, bucket };
    }
  }
  return best;
}

/** The most-used rendering of one value; ties break on the text. */
function modalFormat(bucket: NapKeyBucket): string {
  let best: { text: string; count: number } | null = null;
  for (const [text, format] of bucket.formats) {
    if (!best || format.count > best.count || (format.count === best.count && text < best.text)) {
      best = { text, count: format.count };
    }
  }
  return best?.text ?? "";
}

function skip(name: string, message: string): CheckResult {
  return { name, status: "skipped", message };
}

/** Turn one signal's rollup into its check. `label` names the thing in prose. */
function buildSignalCheck(name: string, label: string, rollup: NapSignalRollup): CheckResult {
  if (rollup.sampleCount === 0) {
    return skip(name, `No ${label} declared on any page`);
  }
  if (rollup.sampleCount < NAP_DRIFT_MIN_PAGES) {
    return skip(
      name,
      `Only ${rollup.sampleCount} page(s) declare a ${label}; ${NAP_DRIFT_MIN_PAGES} needed to judge consistency`
    );
  }

  const modal = modalEntry(rollup.byKey);
  if (!modal) return skip(name, `No ${label} declared on any page`);

  const agreement = modal.bucket.count / rollup.sampleCount;
  const agreementPct = Math.round(agreement * 100);
  if (agreement < NAP_MODAL_MIN_AGREEMENT) {
    return skip(
      name,
      `No dominant ${label} across ${rollup.sampleCount} pages (the most common appears on ${agreementPct}%), so the site is too varied to judge`
    );
  }

  const modalText = modalFormat(modal.bucket);

  // A different value on some pages is a real NAP conflict, not a formatting nit.
  const deviants = [...rollup.byKey.entries()]
    .filter(([key]) => key !== modal.key)
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1));
  if (deviants.length > 0) {
    const deviantPages = deviants.reduce((sum, [, bucket]) => sum + bucket.count, 0);
    const items: CheckItem[] = deviants.slice(0, NAP_MAX_ITEMS).map(([key, bucket]) => ({
      id: key,
      label: `"${modalFormat(bucket)}" on ${bucket.count} page(s)`,
      sourcePages: bucket.urls,
      meta: { pageCount: bucket.count },
    }));
    return {
      name,
      status: "fail",
      message: `${deviantPages} page(s) show a different ${label} to the site norm "${modalText}"`,
      value: modalText,
      items,
      details: {
        norm: modalText,
        normPages: modal.bucket.count,
        deviantValues: deviants.length,
        deviantPages,
        samplePages: rollup.sampleCount,
      },
    };
  }

  // One value, several renderings: the classic citation-hurting NAP drift.
  if (modal.bucket.formats.size > 1) {
    const variants = [...modal.bucket.formats.entries()].sort(
      (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1)
    );
    const items: CheckItem[] = variants.slice(0, NAP_MAX_ITEMS).map(([text, format]) => ({
      id: text,
      label: `"${text}" on ${format.count} page(s)`,
      sourcePages: format.urls,
      meta: { pageCount: format.count },
    }));
    return {
      name,
      status: "warn",
      message: `The same ${label} is formatted ${variants.length} different ways across ${rollup.sampleCount} pages`,
      value: modalText,
      items,
      details: {
        norm: modalText,
        formats: variants.length,
        samplePages: rollup.sampleCount,
      },
    };
  }

  return {
    name,
    status: "pass",
    message: `The same ${label} is used consistently across ${rollup.sampleCount} pages`,
    value: modalText,
  };
}

/** The rule's full output for a non-empty crawl. ONE builder, both paths. */
function buildChecks(rollup: NapRollup): CheckResult[] {
  const checks: CheckResult[] = [];

  if (rollup.hasLocalBusiness) {
    checks.push({
      name: "local-business-schema",
      status: "pass",
      message: "LocalBusiness/Organization schema found",
      value: rollup.businessName || undefined,
    });
  } else {
    checks.push({
      name: "local-business-schema",
      status: "info",
      message: "No LocalBusiness schema found",
      value: "Add schema if this is a local business",
    });
  }

  if (rollup.contactPageSeen && rollup.contactPageHasContact) {
    checks.push({
      name: "contact-info",
      status: "pass",
      message: "Contact page has contact information",
    });
  }

  checks.push(buildSignalCheck("phone-consistency", "phone number", rollup.phone));
  checks.push(buildSignalCheck("address-consistency", "postal address", rollup.address));

  return checks;
}

const EMPTY_CRAWL_CHECK: CheckResult = {
  name: "nap-consistency",
  status: "skipped",
  message: "No pages available for analysis",
};

/** Rebuild a page's NapSignal from its stored page_features scalars. */
function napFromRow(row: PageFeatureRow): NapSignal {
  return {
    name: row.napName,
    phones: row.napPhones,
    phoneFormats: row.napPhoneFormats,
    address: row.napAddress,
    addressFormat: row.napAddressFormat,
    telLink: row.napTelLink,
    mailtoLink: row.napMailtoLink,
  };
}

/**
 * Streaming path (#1373): fold the per-page NAP scalars straight off the
 * page_features cursor, in normalized_url order (== the legacy `site.pages`
 * order). Only the bounded rollup stays resident; no parsed page is held.
 */
async function runViaSiteQuery(siteQuery: SiteQuery): Promise<RuleResult> {
  const rollup = emptyRollup();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    accumulatePage(rollup, {
      url: row.normalizedUrl,
      schemaTypes: row.schemaTypes,
      nap: napFromRow(row),
    });
  }

  if (rollup.pageCount === 0) return { checks: [EMPTY_CRAWL_CHECK] };
  return { checks: buildChecks(rollup) };
}

export const napConsistencyRule: Rule = {
  meta: {
    id: "local/nap-consistency",
    name: "NAP Consistency",
    description: "Checks for consistent Name, Address, Phone across site",
    solution:
      "NAP consistency is critical for local SEO. Your business name, address, and phone number should be identical everywhere - on your site and across all listings. Use schema.org LocalBusiness markup. Avoid abbreviations inconsistencies (St. vs Street). Include NAP in footer for site-wide visibility.",
    category: "local",
    scope: "site",
    severity: "warning",
    weight: 6,
    // NAP consistency only matters for real-world local businesses. Skip with a
    // visible reason for global SaaS / blogs. Offline / no-metadata runs as today.
    appliesWhen: { requiresLocalBusiness: true },
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery) {
      return runViaSiteQuery(ctx.siteQuery);
    }

    const pages = ctx.site?.pages;
    if (!pages || pages.length === 0) {
      return { checks: [EMPTY_CRAWL_CHECK] };
    }

    const rollup = emptyRollup();
    for (const page of pages) {
      accumulatePage(rollup, {
        url: page.url,
        schemaTypes: page.parsed?.schema?.types ?? [],
        nap: extractNapSignal(page.parsed),
      });
    }

    return { checks: buildChecks(rollup) };
  },
};
