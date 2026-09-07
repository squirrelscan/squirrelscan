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
// ORDER-INSENSITIVITY IS AN ACCEPTED NARROWING, approved by the team lead on
// 2026-09-07, in these words: "order-insensitivity for Shopify app blocks and
// cdn.shopify.com/extensions asset tags is an accepted narrowing: the miss case
// is a page whose only change is block order, which an audit does not read."
//
// It is deliberately not general. The order of ordinary stylesheets and scripts
// decides the CSS cascade and execution order and still rotates the hash,
// because nobody has established that reordering THOSE is immaterial. Widening
// it needs its own evidence.
//
// The scan uses htmlparser2's tokenizer — not a regex, and not a hand-rolled
// one. Regexes here were both slow (cubic on hostile input, 523 ms on 14 KB
// against a 2 MB ceiling) and wrong (matching inside `<textarea>` and script
// payloads, where markup-looking text is data). A hand-rolled scanner fixed the
// speed and kept the wrongness in nine new shapes: `</textareaX>` ended a
// textarea, an apostrophe in an unquoted attribute let a script region swallow
// visible markup, `<scripté>` aliased to `script`, and `xmp`, CDATA and SVG
// were all missing. HTML-correct answers need an HTML tokenizer.
//
// This normalizes for FINGERPRINTING ONLY. Never feed its output back into
// stored/served content — it deletes/rewrites markup.
//
// SHARED CONTRACT: the CLI (via the conditional-render fetcher) and the api
// server (#840, server-side hash) MUST run this exact function over the raw
// source before hashing, or client and server fingerprints will disagree and no
// render will ever be reused. Keep both callers on this one implementation.

import { Parser } from "htmlparser2";

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


const SHOPIFY_EXTENSION_HOST = "cdn.shopify.com";
const SHOPIFY_EXTENSION_PATH = "/extensions/";

/** `<!-- BEGIN app block: shopify://apps/… -->` opens a Shopify app block. */
const APP_BLOCK_BEGIN = /^\s*BEGIN app block:\s*shopify:\/\//i;
/** `<!-- END app block -->` closes one. */
const APP_BLOCK_END = /^\s*END app block\s*$/i;

/**
 * Recognizes a Shopify analytics payload — the only place identity fields are
 * neutralized.
 *
 * Anchored on the payload, not on the field name alone and not on the uuid
 * shape. `"u"` in an arbitrary script can be content: the script
 * `document.body.textContent=({"u":"Alice"}).u` renders "Alice", and blanking
 * that field would collide it with "Bob". Inside Shopify's analytics bootstrap
 * the same field is a per-visitor token that rotates with every cache entry.
 */
const SHOPIFY_ANALYTICS = /\b(?:__st\b|ShopifyAnalytics|Shopify\.shop\b)/;

/** Request/visitor identity fields, neutralized only inside the above. */
const IDENTITY_FIELD = /"(reqid|requestId|eventMetadataId|u)"\s*:\s*"[^"]*"/g;

interface Region {
  start: number;
  end: number;
}

/**
 * Is this the URL of a Shopify theme-app-extension asset?
 *
 * Parsed, not substring-matched: `data-note="cdn.shopify.com/extensions/"` on an
 * ordinary script must not make it order-insensitive, and neither must
 * `https://not-cdn.shopify.com/extensions/` or another origin carrying the
 * string somewhere in its path.
 */
function isExtensionAsset(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url, "https://placeholder.invalid");
    return (
      parsed.hostname === SHOPIFY_EXTENSION_HOST &&
      parsed.pathname.startsWith(SHOPIFY_EXTENSION_PATH)
    );
  } catch {
    return false;
  }
}

/** Rewrite `html` by replacing disjoint regions, left to right. */
function spliceRegions(html: string, edits: Array<Region & { text: string }>): string {
  if (edits.length === 0) return html;
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += html.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + html.slice(cursor);
}

/**
 * Group regions into runs of ADJACENT siblings — separated by nothing but
 * whitespace.
 *
 * Adjacency is the safety boundary. Sorting a run of siblings cannot move markup
 * past unrelated content, so a real change anywhere else still changes the hash.
 * Sorting every match in the document, or the span from the first match to the
 * last, would silently relocate everything in between.
 */
function groupAdjacent(html: string, regions: Region[]): Region[][] {
  const runs: Region[][] = [];
  let current: Region[] = [];
  for (const region of regions) {
    const prev = current[current.length - 1];
    if (prev && html.slice(prev.end, region.start).trim() !== "") {
      if (current.length > 1) runs.push(current);
      current = [];
    }
    current.push(region);
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

/**
 * Neutralize well-anchored per-request volatility so two fetches of an
 * otherwise-identical page normalize to the same string.
 *
 * Two passes, and the order matters: an app block can CONTAIN a script, so the
 * regions overlap and one edit would win. Sorting raw text carried an
 * un-neutralized identity token into the output for exactly the pages whose
 * blocks needed reordering, and left it neutralized for the pages that did not —
 * so two fetches of the same page normalized differently, which is the failure
 * this function exists to prevent. Sorting text that is already neutralized
 * cannot do that.
 */
export function normalizeHtmlForFingerprint(html: string): string {
  return sortShopifyRuns(neutralizeScripts(html));
}

/** Pass 1: strip the CF challenge block and neutralize script-borne identity. */
function neutralizeScripts(html: string): string {
  const edits: Array<Region & { text: string }> = [];
  let openEnd: number | null = null;
  let start = 0;
  let isSt = false;

  const parser: Parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name !== "script") return;
        start = parser.startIndex;
        openEnd = parser.endIndex + 1;
        // An EXACT attribute value. `id="__st suffix"` is a different id, and a
        // `data-note` whose value merely contains `id="__st"` is not an id at
        // all — both were false positives when this was matched with a regex
        // over the raw open tag.
        isSt = attribs.id === "__st";
      },
      onclosetag(name) {
        if (name !== "script" || openEnd === null) return;
        const bodyStart = openEnd;
        const bodyEnd = parser.startIndex;
        openEnd = null;
        if (bodyEnd < bodyStart) return;
        const body = html.slice(bodyStart, bodyEnd);
        // The open tag too: the challenge platform ships in two forms, an inline
        // snippet setting `window.__CF$cv$params` and an EXTERNAL script whose
        // body is empty and whose src is the giveaway.
        const openTag = html.slice(start, bodyStart);
        if (CF_CHALLENGE.test(openTag) || CF_CHALLENGE.test(body)) {
          edits.push({ start, end: parser.endIndex + 1, text: "" });
          return;
        }
        // JSON-LD bodies are deliberately in scope for the epoch pass: a payload
        // differing only in a 13-digit numeric field reuses a stale render —
        // accepted narrowing, bounded by the 7-day TTL (#991).
        let rewritten = body.replace(EPOCH_MS_TOKEN, "0");
        if (isSt || SHOPIFY_ANALYTICS.test(body)) {
          rewritten = rewritten.replace(IDENTITY_FIELD, '"$1":""');
        }
        if (rewritten !== body) edits.push({ start: bodyStart, end: bodyEnd, text: rewritten });
      },
    },
    { lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return spliceRegions(html, edits);
}

/** Pass 2: sort each contiguous run of app blocks and extension asset tags. */
function sortShopifyRuns(html: string): string {
  const appBlocks: Region[] = [];
  const assetTags: Region[] = [];
  let blockStart: number | null = null;
  let blockDepth = 0;
  let pendingAsset: number | null = null;

  const parser: Parser = new Parser(
    {
      oncomment(text) {
        if (APP_BLOCK_BEGIN.test(text)) {
          // Nesting is COUNTED, not ignored. An inner END closing an outer block
          // would emit a region that is not a sibling of the ones beside it, and
          // sorting could then move markup across a boundary.
          if (blockDepth === 0) blockStart = parser.startIndex;
          blockDepth++;
          return;
        }
        if (APP_BLOCK_END.test(text) && blockDepth > 0) {
          blockDepth--;
          if (blockDepth === 0 && blockStart !== null) {
            appBlocks.push({ start: blockStart, end: parser.endIndex + 1 });
            blockStart = null;
          }
        }
      },
      onopentag(name, attribs) {
        if (name === "script" && isExtensionAsset(attribs.src)) {
          pendingAsset = parser.startIndex;
          return;
        }
        if (name === "link" && isExtensionAsset(attribs.href)) {
          assetTags.push({ start: parser.startIndex, end: parser.endIndex + 1 });
        }
      },
      onclosetag(name) {
        if (name === "script" && pendingAsset !== null) {
          assetTags.push({ start: pendingAsset, end: parser.endIndex + 1 });
          pendingAsset = null;
        }
      },
    },
    { lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const edits: Array<Region & { text: string }> = [];
  for (const regions of [appBlocks, assetTags]) {
    for (const run of groupAdjacent(html, regions)) {
      const texts = run.map((r) => html.slice(r.start, r.end));
      const sorted = [...texts].sort();
      if (sorted.every((t, i) => t === texts[i])) continue;
      run.forEach((region, i) => {
        edits.push({ start: region.start, end: region.end, text: sorted[i]! });
      });
    }
  }
  return spliceRegions(html, edits);
}
