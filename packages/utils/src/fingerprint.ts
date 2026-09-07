// Source-fingerprint normalization for render-reuse (#839).
//
// Some origins emit per-request volatility inside the raw HTML on every fetch,
// so the source bytes rotate even when the real content is byte-identical. Two
// known classes, both confined to <script> blocks:
//   1. Cloudflare challenge-platform snippet (#836): a ~919-byte <script>
//      carrying a rotating ray id + timestamp in `window.__CF$cv$params`. We
//      strip the whole block.
//   2. Framework hydration timestamps (#991): SSR frameworks embed epoch-ms
//      state in inline hydration scripts (TanStack Start's `$_TSR` `u:<Date.now()>`
//      observed; every squirrelscan-built site is in this class). We can't strip
//      the block — CSR payloads carry real content — so we neutralize just the
//      13-digit epoch-ms tokens to a fixed placeholder.
//   3. Shopify page-cache regeneration (#1899): a Shopify storefront serves one
//      cached body for a while, then regenerates it. The regenerated body is the
//      same page, but it carries fresh request identity AND emits its app blocks
//      and app-extension asset tags in a DIFFERENT ORDER. Measured on
//      drscholls.com from the hosted probe vantage: fetches six seconds apart
//      are byte-identical, fetches two minutes apart never are, so the render
//      cache missed on essentially every page (4,889 stored hashes for 456
//      paths, and a 500-page audit paid 468 render debits for 1 cached hit).
// All three yield a stable hash across fetches while keeping the fingerprint
// sensitive to real payload changes.
//
// ORDER-INSENSITIVITY IS DELIBERATE AND NARROW. Sorting is applied to exactly
// two things: Shopify app blocks, and asset tags pointing at
// `cdn.shopify.com/extensions/`. A page whose ONLY change is the order of those
// is a page the audit reports identically, so reusing its render is right.
// Anything else — the order of ordinary stylesheets or scripts, which decides
// the CSS cascade and execution order — still rotates the hash, because we have
// NOT established that reordering those is immaterial. The narrowing is the
// safety argument; widening it later needs its own evidence.
//
// The scan is a forward-only tokenizer (fingerprint-scan.ts), not a regex.
// Regexes here were both slow (cubic on hostile input, 523 ms on 14 KB against
// a 2 MB ceiling) and wrong (they match inside `<textarea>` and script
// payloads, where markup-looking text is data).
//
// This normalizes for FINGERPRINTING ONLY. Never feed its output back into
// stored/served content — it deletes/rewrites markup.
//
// SHARED CONTRACT: the CLI (via the conditional-render fetcher) and the api
// server (#840, server-side hash) MUST run this exact function over the raw
// source before hashing, or client and server fingerprints will disagree and no
// render will ever be reused. Keep both callers on this one implementation.

import { scanSource, type SourceRegion } from "./fingerprint-scan";

// Anchors that identify a Cloudflare challenge-platform script: the inline
// snippet sets `window.__CF$cv$params`; both the inline and external forms
// reference `/cdn-cgi/challenge-platform/`.
const CF_CHALLENGE = /__CF\$cv\$params|\/cdn-cgi\/challenge-platform\//i;

// A standalone 13-digit integer: epoch-milliseconds (Sep 2001 – Nov 2286). The
// \b anchors deliberately exclude digits embedded in longer numbers, so 14+-digit
// ids stay fingerprint-significant. Applied ONLY to script BODIES — a 13-digit
// number in visible HTML is real content, and one in a script's opening tag is a
// deploy-version cache-buster; both must stay fingerprint-significant.
const EPOCH_MS_TOKEN = /\b\d{13}\b/g;

/**
 * Shopify's analytics bootstrap: `<script id="__st">var __st={…}` carrying a
 * per-request `reqid` and a per-visitor `u` token. Matched on the open tag's
 * attributes, and only as a whole attribute so `data-id="__st"` does not
 * qualify.
 */
const ST_ID_ATTR = /(?:^|\s)id\s*=\s*["']?__st["']?(?:\s|$|>)/i;

/**
 * Request-identity fields inside an analytics payload. Anchored on the FIELD
 * NAME, not on the uuid shape: a bare uuid is not evidence of request identity,
 * and neutralizing every uuid in every script body would collapse two pages
 * whose only difference is the resource a script fetches.
 */
const IDENTITY_FIELD = /"(reqid|requestId|eventMetadataId|u)"\s*:\s*"[^"]*"/g;

/** `<!-- BEGIN app block: shopify://apps/… -->` opens a Shopify app block. */
const APP_BLOCK_BEGIN = /^\s*BEGIN app block:\s*shopify:\/\//i;
/** `<!-- END app block -->` closes one. */
const APP_BLOCK_END = /^\s*END app block\s*$/i;
/** An asset tag pointing at the theme-app-extension CDN. */
const EXTENSION_ASSET = /\bcdn\.shopify\.com\/extensions\//i;

/** A located run of sibling regions that may be reordered among themselves. */
interface Run {
  items: SourceRegion[];
}

/**
 * Group regions into runs of ADJACENT siblings — regions separated by nothing
 * but whitespace.
 *
 * Adjacency is the safety boundary. Sorting a run of siblings cannot move
 * markup past unrelated content, so a real change anywhere else still changes
 * the hash. Sorting every match in the document, or the whole span from the
 * first match to the last, would silently relocate everything in between.
 */
function groupAdjacent(html: string, regions: SourceRegion[]): Run[] {
  const runs: Run[] = [];
  let current: SourceRegion[] = [];
  for (const region of regions) {
    const prev = current[current.length - 1];
    if (prev && html.slice(prev.end, region.start).trim() !== "") {
      if (current.length > 1) runs.push({ items: current });
      current = [];
    }
    current.push(region);
  }
  if (current.length > 1) runs.push({ items: current });
  return runs;
}

/** Rewrite `html`, replacing each region's text via `replace`, in order. */
function spliceRegions(
  html: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  if (edits.length === 0) return html;
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue; // overlapping edit: keep the first
    out += html.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + html.slice(cursor);
}

/**
 * Neutralize well-anchored per-request volatility so two fetches of an
 * otherwise-identical page normalize to the same string: strip the Cloudflare
 * challenge-platform block, blank Shopify's `__st` request-identity bootstrap,
 * replace epoch-ms tokens and named identity fields inside every other
 * `<script>`, and sort each contiguous run of Shopify app blocks and
 * app-extension asset tags. A page carrying none of these passes through
 * unchanged.
 */
export function normalizeHtmlForFingerprint(html: string): string {
  return sortShopifyRuns(neutralizeScripts(html));
}

/**
 * Pass 1: rewrite script bodies. Strips the Cloudflare challenge block, blanks
 * Shopify's `__st` request-identity bootstrap, and neutralizes epoch-ms tokens
 * and named identity fields everywhere else.
 */
function neutralizeScripts(html: string): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  scanSource(html, {
    onScript: (region) => {
      const openTag = html.slice(region.start, region.openTagEnd);
      const body = html.slice(region.openTagEnd, region.bodyEnd);
      if (CF_CHALLENGE.test(openTag) || CF_CHALLENGE.test(body)) {
        edits.push({ start: region.start, end: region.end, text: "" });
        return;
      }
      // JSON-LD bodies are deliberately in scope: a payload differing only in a
      // 13-digit numeric field reuses a stale render — accepted narrowing,
      // bounded by the render cache's 7-day TTL (#991).
      const rewritten = ST_ID_ATTR.test(openTag)
        ? ""
        : body.replace(EPOCH_MS_TOKEN, "0").replace(IDENTITY_FIELD, '"$1":""');
      if (rewritten !== body) {
        edits.push({ start: region.openTagEnd, end: region.bodyEnd, text: rewritten });
      }
    },
  });
  return spliceRegions(html, edits);
}

/**
 * Pass 2: sort each contiguous run of Shopify app blocks and app-extension
 * asset tags.
 *
 * Deliberately a SECOND pass over the already-rewritten string rather than more
 * edits in the first. An app block can contain a script, so the two edit sets
 * overlap, and one has to win: sorting raw text would carry an un-neutralized
 * identity token back into the output for exactly the pages whose blocks needed
 * reordering, and leave it neutralized for the ones that did not. Two fetches
 * of the same page would then normalize differently — the failure this whole
 * function exists to prevent. Sorting text that is already neutralized cannot
 * do that.
 */
function sortShopifyRuns(html: string): string {
  const appBlocks: SourceRegion[] = [];
  const assetTags: SourceRegion[] = [];
  let blockStart: number | null = null;

  scanSource(html, {
    onScript: (region) => {
      const openTag = html.slice(region.start, region.openTagEnd);
      if (EXTENSION_ASSET.test(openTag)) assetTags.push({ start: region.start, end: region.end });
    },
    onComment: (region, text) => {
      if (APP_BLOCK_BEGIN.test(text)) {
        // A nested BEGIN keeps the OUTERMOST start, so a block and the block it
        // contains are never emitted as two overlapping regions.
        if (blockStart === null) blockStart = region.start;
        return;
      }
      if (APP_BLOCK_END.test(text) && blockStart !== null) {
        appBlocks.push({ start: blockStart, end: region.end });
        blockStart = null;
      }
    },
    onTag: (region, name) => {
      if (name !== "link") return;
      if (EXTENSION_ASSET.test(html.slice(region.start, region.end))) assetTags.push(region);
    },
  });

  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const regions of [appBlocks, assetTags]) {
    for (const run of groupAdjacent(html, regions)) {
      const texts = run.items.map((r) => html.slice(r.start, r.end));
      const sorted = [...texts].sort();
      if (sorted.every((t, i) => t === texts[i])) continue;
      run.items.forEach((region, i) => {
        edits.push({ start: region.start, end: region.end, text: sorted[i]! });
      });
    }
  }
  return spliceRegions(html, edits);
}
