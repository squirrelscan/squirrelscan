// content/near-duplicate - indexable pages whose main text is nearly identical (repo#1369)
//
// content/duplicate-content finds EXACT body matches. The same page with a city, a date or one
// short paragraph swapped (location pages, programmatic SEO, templated landing pages) escapes it
// and is exactly the shape search engines treat as doorway content. This rule groups those.
//
// Per page a 64-bit simhash of the MAIN text is computed once: `page_features.content_simhash` on
// the streaming path (audit-engine calls `pageContentSimhash`), and inline by the rule on the
// legacy path with the SAME function. Chrome (nav, header, footer, aside, forms, hidden
// subtrees) is dropped before hashing, so pages that share only a template do not cluster.
//
// Both paths feed ONE async builder with the same per-page record, so output is byte-identical.
// The pair loop and the legacy hashing loop yield to the event loop on a time budget, so a large
// crawl cannot starve the timer-based rule deadline.

import { SCAN_TRUNCATED_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import type {
  CheckItem,
  CheckResult,
  HreflangAlternate,
  PageFeatureRow,
  SiteQuery,
} from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult } from "../types";
import { noindexSource } from "../shared/noindex";
import { identity } from "../shared/region-variants";
import {
  countComponents,
  fingerprintForPage,
  isPaginatedUrl,
  isRedirectedPage,
  isSpaceCode,
  type PageMeta,
} from "./duplicate-content";
import { getRenderedProseTextWhere } from "./text-content";

/** Main-text words below which a page is not hashed (empty shells, login walls). */
export const NEAR_DUP_MIN_WORDS = 100;
/** Tokens read per page: bounds the CPU a huge page can cost. */
export const NEAR_DUP_MAX_TOKENS = 20000;
/**
 * Largest Hamming distance between two simhashes that counts as nearly identical. Two unrelated
 * 64-bit simhashes differ in Binomial(64, 0.5) bits, so P(d <= 5) is 4.5e-13: negligible even for
 * a 10,000-page crawl (5e7 pairs). A city or date swap in a 300 to 400 word page measures 0 to 6
 * bits (about 90% of single-edit pairs are within 5), and a cluster of many location pages links
 * transitively, so cluster detection is more robust than any one pair. A whole paragraph
 * rewritten out of five measures 11 to 20 bits and is not reported.
 */
export const NEAR_DUP_MAX_DISTANCE = 5;
/** Crawl-wide page floor: below this the rule skips. */
export const NEAR_DUP_MIN_PAGES = 10;
/** Distinct texts in one cluster at which the finding becomes a failure (doorway scale). */
export const NEAR_DUP_FAIL_CLUSTER = 10;
/** Distinct texts compared; the rest are counted in `unjudgedPages`. Bounds the pair loop. */
export const NEAR_DUP_MAX_NODES = 10000;
/** URLs listed per cluster; the rest are counted in `omittedUrls`. */
export const MAX_URLS_PER_CLUSTER = 20;
/** Clusters reported as items; the rest are counted in `omittedClusters`. */
export const MAX_CLUSTERS = 50;

const CHECK_NAME = "near-duplicate";
const YIELD_MS = 8;

const CHROME_TAGS: ReadonlySet<string> = new Set([
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "menu",
]);
const CHROME_ROLES: ReadonlySet<string> = new Set([
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
]);

function isChrome(el: Element): boolean {
  if (CHROME_TAGS.has(el.tagName.toLowerCase())) return true;
  const role = el.getAttribute("role");
  if (role && CHROME_ROLES.has(role.trim().toLowerCase())) return true;
  return el.getAttribute("aria-hidden") === "true";
}

function isLetterCode(c: number): boolean {
  if (c < 0x80) return (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
  // Non-ASCII: a letter unless it is whitespace or general punctuation.
  return !isSpaceCode(c) && !(c >= 0x2000 && c <= 0x206f);
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

/** The element whose text is "the page": first main / role=main inside body, else body. */
function mainRoot(doc: Document): Element | null {
  let body: Element | null = null;
  try {
    body = doc.body;
  } catch {
    return null;
  }
  if (!body) return null;
  for (const selector of ["main", '[role="main"]']) {
    const el = doc.querySelector(selector);
    if (el && body.contains(el)) return el;
  }
  return body;
}

/**
 * 64-bit simhash of the page's main text over word 3-shingles, as 16 lowercase hex chars.
 * Null for a page without a document or body, a redirect, or main text under
 * NEAR_DUP_MIN_WORDS words. One plain loop over the text (no regex over page text).
 */
export function pageContentSimhash(
  doc: Document | null | undefined,
  url: string,
  finalUrl: string | null | undefined,
): string | null {
  if (!doc || isRedirectedPage(url, finalUrl)) return null;
  const root = mainRoot(doc);
  if (!root) return null;

  const text = getRenderedProseTextWhere(root, isChrome).toLowerCase();
  const starts = new Int32Array(NEAR_DUP_MAX_TOKENS);
  const ends = new Int32Array(NEAR_DUP_MAX_TOKENS);
  let tokens = 0;
  let start = -1;
  for (let i = 0; i <= text.length && tokens < NEAR_DUP_MAX_TOKENS; i++) {
    const letter = i < text.length && isLetterCode(text.charCodeAt(i));
    if (letter) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      starts[tokens] = start;
      ends[tokens] = i;
      tokens++;
      start = -1;
    }
  }
  if (tokens < NEAR_DUP_MIN_WORDS) return null;

  const votes = new Int32Array(64);
  // Shingle-set semantics: each DISTINCT shingle votes once. A repeated phrase (a sentence
  // template, a boilerplate line) would otherwise out-vote the page's distinct text and pull
  // unrelated pages of one template together. The key is exact within 53 bits.
  const seen = new Set<number>();
  for (let t = 0; t + 2 < tokens; t++) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let k = 0; k < 3; k++) {
      if (k > 0) {
        h1 = Math.imul(h1 ^ 32, 2654435761);
        h2 = Math.imul(h2 ^ 32, 1597334677);
      }
      const end = ends[t + k]!;
      for (let i = starts[t + k]!; i < end; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
      }
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const key = (h1 >>> 0) * 2097152 + (h2 >>> 11);
    if (seen.has(key)) continue;
    seen.add(key);
    for (let j = 0; j < 32; j++) {
      votes[j]! += (h1 >>> j) & 1 ? 1 : -1;
      votes[32 + j]! += (h2 >>> j) & 1 ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let j = 0; j < 32; j++) {
    if (votes[j]! > 0) lo |= 1 << j;
    if (votes[32 + j]! > 0) hi |= 1 << j;
  }
  return hex32(hi) + hex32(lo);
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** Hamming distance between two 16-char hex simhashes. */
export function simhashDistance(a: string, b: string): number {
  return (
    popcount32(parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) +
    popcount32(parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16))
  );
}

/** One page, identical whichever path supplies it. */
export interface NearDupPage {
  url: string;
  status: number;
  noindex: boolean;
  canonical: string | null | undefined;
  alternates: readonly HreflangAlternate[] | null | undefined;
  simhash: string | null;
  /** Exact-duplicate fingerprint hash (content/duplicate-content's), null when absent. */
  exactKey: string | null;
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A coded gap skip, never a pass: the rule did not compare every page, so the resolution signal
 * lists the pages as not evaluated and a stored finding carries instead of resolving. A free-text
 * skip would read as "does not apply" and let an absent key resolve priors.
 */
function skip(message: string, details?: Record<string, unknown>): CheckResult {
  return {
    name: CHECK_NAME,
    status: "skipped",
    message,
    skipReason: SCAN_TRUNCATED_SKIP_REASON,
    ...(details ? { details } : {}),
  };
}

interface Node {
  urls: string[];
  simhash: string;
}

/** The one builder both paths feed. */
export async function buildNearDuplicate(
  pages: readonly NearDupPage[],
  pageCount: number,
): Promise<CheckResult> {
  if (pageCount < NEAR_DUP_MIN_PAGES) {
    return skip(
      `Only ${pageCount} page(s) crawled; ${NEAR_DUP_MIN_PAGES} needed to compare pages for near-duplicate content`,
    );
  }

  const excluded = { noindex: 0, notOk: 0, pagination: 0, unhashed: 0, hreflang: 0 };
  const candidates: NearDupPage[] = [];
  for (const p of pages) {
    if (p.status < 200 || p.status > 299) excluded.notOk++;
    else if (p.noindex) excluded.noindex++;
    else if (isPaginatedUrl(p.url)) excluded.pagination++;
    else if (p.simhash === null) excluded.unhashed++;
    else candidates.push(p);
  }
  if (candidates.length < 2) return skip("Fewer than 2 pages have enough main text to compare");

  candidates.sort((a, b) => cmp(a.url, b.url));
  const metas = new Map<string, PageMeta>();
  const nodes: Node[] = [];
  const byKey = new Map<string, Node>();
  for (const p of candidates) {
    metas.set(p.url, {
      status: p.status,
      noindex: p.noindex,
      canonical: p.canonical,
      alternates: p.alternates,
    });
    const existing = p.exactKey === null ? undefined : byKey.get(p.exactKey);
    if (existing) {
      existing.urls.push(p.url);
      continue;
    }
    const node: Node = { urls: [p.url], simhash: p.simhash! };
    nodes.push(node);
    if (p.exactKey !== null) byKey.set(p.exactKey, node);
  }
  const judged = Math.min(nodes.length, NEAR_DUP_MAX_NODES);
  let unjudgedPages = 0;
  for (let i = judged; i < nodes.length; i++) unjudgedPages += nodes[i]!.urls.length;

  // Pairwise Hamming over the judged nodes, union-find on pairs within the threshold.
  const lo = new Uint32Array(judged);
  const hi = new Uint32Array(judged);
  for (let i = 0; i < judged; i++) {
    hi[i] = parseInt(nodes[i]!.simhash.slice(0, 8), 16) >>> 0;
    lo[i] = parseInt(nodes[i]!.simhash.slice(8), 16) >>> 0;
  }
  const parent = new Int32Array(judged);
  const widest = new Uint8Array(judged);
  for (let i = 0; i < judged; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  let lastYield = performance.now();
  let ops = 0;
  for (let i = 0; i < judged; i++) {
    const hiI = hi[i]!;
    const loI = lo[i]!;
    for (let j = i + 1; j < judged; j++) {
      if ((++ops & 2047) === 0 && performance.now() - lastYield > YIELD_MS) {
        await yieldToLoop();
        lastYield = performance.now();
      }
      const d = popcount32(hiI ^ hi[j]!) + popcount32(loI ^ lo[j]!);
      if (d > NEAR_DUP_MAX_DISTANCE) continue;
      const a = find(i);
      const b = find(j);
      if (a === b) continue;
      // The smaller index stays the root, so the shape never depends on timing.
      const root = a < b ? a : b;
      const other = a < b ? b : a;
      parent[other] = root;
      widest[root] = Math.max(widest[root]!, widest[other]!, d);
    }
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < judged; i++) {
    const r = find(i);
    const list = members.get(r);
    if (list) list.push(i);
    else members.set(r, [i]);
  }

  interface Cluster {
    urls: string[];
    nodes: number;
    exact: number;
    widest: number;
  }
  const found: Cluster[] = [];
  let canonicalised = 0;
  for (const [root, idxs] of members) {
    // A component of one text is either a lone page or exact copies: content/duplicate-content's.
    if (idxs.length < 2) continue;
    const urls = idxs.flatMap((i) => nodes[i]!.urls).sort(cmp);

    const canonicals = new Set<string>();
    for (const url of urls) {
      const self = identity(url) ?? url;
      const declared = metas.get(url)?.canonical?.trim();
      canonicals.add((declared ? identity(declared, url) : null) ?? self);
    }
    if (canonicals.size < 2) {
      canonicalised++;
      continue;
    }
    if (countComponents(urls, metas) < 2) {
      excluded.hreflang += urls.length;
      continue;
    }
    let exact = 0;
    for (const i of idxs) if (nodes[i]!.urls.length > 1) exact += nodes[i]!.urls.length;
    found.push({ urls, nodes: idxs.length, exact, widest: widest[root]! });
  }

  const common = {
    canonicalisedClusters: canonicalised,
    excluded,
    comparedPages: candidates.length,
    ...(unjudgedPages > 0 ? { unjudgedPages } : {}),
    minWords: NEAR_DUP_MIN_WORDS,
    maxDistance: NEAR_DUP_MAX_DISTANCE,
  };

  if (found.length === 0 && unjudgedPages > 0) {
    // Pages past the compare cap were never compared, so "no clusters" is not a verdict on them.
    return skip(
      `${unjudgedPages} page(s) past the ${NEAR_DUP_MAX_NODES} distinct texts compared were not checked for near-duplicates`,
      common,
    );
  }

  if (found.length === 0) {
    return {
      name: CHECK_NAME,
      status: "pass",
      message: "No pages have nearly identical main text",
      details: common,
    };
  }

  found.sort((a, b) => b.urls.length - a.urls.length || cmp(a.urls[0]!, b.urls[0]!));
  const totalPages = found.reduce((sum, c) => sum + c.urls.length, 0);
  const shown = found.slice(0, MAX_CLUSTERS);
  const items: CheckItem[] = shown.map((c) => {
    const listed = c.urls.slice(0, MAX_URLS_PER_CLUSTER);
    const exactNote =
      c.exact > 0
        ? ` (${c.exact} are exact copies, also reported by content/duplicate-content)`
        : "";
    return {
      id: c.urls[0]!,
      label: `${c.urls.length} pages have nearly identical main text${exactNote}`,
      sourcePages: listed,
      meta: {
        pageCount: c.urls.length,
        distinctTexts: c.nodes,
        exactCopies: c.exact,
        widestLinkBits: c.widest,
        listedUrls: listed.length,
        omittedUrls: c.urls.length - listed.length,
      },
    };
  });
  const doorwayScale = found.some((c) => c.nodes >= NEAR_DUP_FAIL_CLUSTER);
  return {
    name: CHECK_NAME,
    status: doorwayScale ? "fail" : "warn",
    message: `${found.length} near-duplicate cluster(s) found across ${totalPages} pages`,
    items,
    details: {
      totalClusters: found.length,
      totalPages,
      reportedClusters: shown.length,
      omittedClusters: found.length - shown.length,
      ...common,
    },
  };
}

async function runStreaming(ctx: RuleContext, siteQuery: SiteQuery): Promise<RuleResult> {
  const exact = new Map<string, string>();
  for (const page of ctx.collectedSignals?.pages ?? []) {
    if (page.contentFingerprint) exact.set(page.url, page.contentFingerprint.hash);
  }
  const pages: NearDupPage[] = [];
  for await (const row of siteQuery.pagesMatching(() => true) as AsyncIterable<PageFeatureRow>) {
    pages.push({
      url: row.normalizedUrl,
      status: row.status,
      noindex: row.robotsNoindex,
      canonical: row.canonical,
      alternates: row.hreflangAlternates,
      simhash: row.contentSimhash ?? null,
      exactKey: exact.get(row.normalizedUrl) ?? null,
    });
  }
  return { checks: [await buildNearDuplicate(pages, siteQuery.pageCount())] };
}

async function runLegacy(ctx: RuleContext): Promise<RuleResult> {
  const source = ctx.site?.pages ?? [];
  const pages: NearDupPage[] = [];
  // Below the page floor the builder skips on the count alone, so nothing is hashed.
  if (source.length >= NEAR_DUP_MIN_PAGES) {
    let lastYield = performance.now();
    for (const page of source) {
      if (performance.now() - lastYield > YIELD_MS) {
        await yieldToLoop();
        lastYield = performance.now();
      }
      const noindex = noindexSource(page.parsed, page.headers) !== null;
      const ok = page.statusCode >= 200 && page.statusCode <= 299;
      // Hashing is the expensive part and the builder never reads the hash of a page it excludes
      // first (non-2xx, noindex, paginated), so those are left null here.
      const hashed = ok && !noindex && !isPaginatedUrl(page.url);
      const simhash = hashed
        ? pageContentSimhash(page.parsed?.document, page.url, page.finalUrl)
        : null;
      pages.push({
        url: page.url,
        status: page.statusCode,
        noindex,
        canonical: page.parsed.meta?.canonical,
        alternates: page.parsed.hreflangAlternates,
        simhash,
        // Only a page that is compared needs its exact-copy key.
        exactKey:
          simhash === null
            ? null
            : (fingerprintForPage(page.parsed?.document, page.url, page.finalUrl)?.hash ?? null),
      });
    }
  }
  return { checks: [await buildNearDuplicate(pages, source.length)] };
}

export const nearDuplicateRule: Rule = {
  meta: {
    id: "content/near-duplicate",
    name: "Near-Duplicate Content",
    description:
      "Finds indexable pages whose main text is nearly identical, beyond exact duplicates",
    solution:
      "Pages whose main text differs only by a place name, a date or a paragraph compete with each other in search and, in numbers, look like doorway pages. Give each page content specific to its own topic, or merge the pages and redirect the extra URLs to one, or point the copies at a single canonical URL with a rel=canonical tag.",
    category: "content",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 4,
    // Check names by outcome class (#1741).
    checks: [
      { name: CHECK_NAME, outcome: "problem" },
      { name: CHECK_NAME, outcome: "clean", clears: [CHECK_NAME] },
      { name: CHECK_NAME, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): Promise<RuleResult> {
    if (ctx.siteQuery) return runStreaming(ctx, ctx.siteQuery);
    return runLegacy(ctx);
  },
};
