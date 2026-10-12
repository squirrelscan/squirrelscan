import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";

import { Effect } from "effect";
import { XMLParser } from "fast-xml-parser";

import type {
  RobotsTxtData,
  SitemapData,
  SitemapFetchFailure,
  SitemapUrl,
} from "@squirrelscan/core-contracts";
import { resolveRobotsSitemapUrl } from "@squirrelscan/utils/robots-txt";

import { SITEMAP_NOT_CHECKED_ERROR } from "@squirrelscan/core-contracts/storage";

import { safeFetchWithDeadline } from "./deadline";
import { noteRefusal, type RefusalLog } from "./refusals";

/**
 * Recorded against a sitemap the walk gave up on before reaching it. Shared
 * with the rules package via core-contracts, so `crawl/sitemap-valid` can tell
 * it apart from a real fetch failure rather than reporting a defect for work
 * that was never attempted.
 */
export const SITEMAP_NOT_REACHED_ERROR = SITEMAP_NOT_CHECKED_ERROR;

const logger = {
  debug: (_message: string, ..._args: unknown[]) => {},
};

/**
 * The sitemap protocol's limit for one file, uncompressed: 50 MB, which
 * sitemaps.org spells out as 52,428,800 bytes. It bounds every body the walk
 * holds: the bytes on the wire, the body once its `Content-Encoding` is undone,
 * and a gzip FILE decompressed after that, so a gzip bomb or an endless body is
 * refused at the limit instead of exhausting memory (#662).
 */
export const SITEMAP_MAX_BYTES = 52_428_800;

/** Recorded against a sitemap whose uncompressed body is over SITEMAP_MAX_BYTES. */
export const SITEMAP_TOO_LARGE_ERROR = "Sitemap exceeds the 50 MB uncompressed size limit";

/** Prefix for a body that carries the gzip signature but does not decompress. */
export const SITEMAP_CORRUPT_GZIP_ERROR = "Corrupt gzip body";

/** Prefix for a response whose `Content-Encoding` the walk cannot undo. */
export const SITEMAP_UNSUPPORTED_ENCODING_ERROR = "Unsupported Content-Encoding";

/** Recorded against a sitemap URL that answered with a web page instead (#670). */
export const SITEMAP_HTML_PAGE_ERROR = "Not a sitemap: the URL returned an HTML page";

/** The shape a sitemap takes when its body could not be read as one. */
function unreadableSitemap(url: string, error: string): SitemapData {
  return { url, type: "urlset", urls: [], childSitemaps: [], errors: [error], urlCount: 0 };
}

/**
 * Decode the five XML predefined escapes.
 *
 * The parser runs with `processEntities: false` to block declared-entity
 * substitution (billion-laughs / XXE, pinned by sitemap-entity-expansion.test.ts).
 * That flag also suppresses the predefined five, which are not declarations and
 * are the spec-mandated way to encode `&` in a sitemap URL — without this a
 * `?q=1&amp;page=2` loc is fetched literally, hitting a different URL than the
 * sitemap advertised.
 *
 * `&amp;` is decoded LAST so `&amp;lt;` yields the literal `&lt;` rather than
 * double-decoding to `<`.
 */
function decodeXmlEscapes(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseSitemap(content: string, url: string): SitemapData {
  const errors: string[] = [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
    processEntities: false,
  });

  const ensureArray = <T>(value: T | T[] | undefined): T[] => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  };

  try {
    const parsed = parser.parse(content) as Record<string, unknown>;

    if (parsed.sitemapindex) {
      const sitemapIndex = parsed.sitemapindex as {
        sitemap?: { loc?: string } | { loc?: string }[];
      };
      const sitemapEntries = ensureArray(sitemapIndex.sitemap);
      const childSitemaps = sitemapEntries
        .map((entry) => entry.loc?.trim())
        .filter((loc): loc is string => Boolean(loc))
        .map(decodeXmlEscapes);

      return {
        url,
        type: "index",
        urls: [],
        childSitemaps,
        errors,
        urlCount: 0,
      };
    }

    if (parsed.urlset) {
      const urlset = parsed.urlset as {
        "@_xmlns:news"?: string;
        url?:
          | {
              loc?: string;
              lastmod?: string;
              changefreq?: string;
              priority?: string | number;
            }
          | {
              loc?: string;
              lastmod?: string;
              changefreq?: string;
              priority?: string | number;
            }[];
      };
      const urlEntries = ensureArray(urlset.url);
      const urls: SitemapUrl[] = [];

      for (const entry of urlEntries) {
        const rawLoc = entry.loc?.trim();
        if (!rawLoc) continue;
        const loc = decodeXmlEscapes(rawLoc);

        const priorityRaw = entry.priority;
        const priority =
          typeof priorityRaw === "number"
            ? priorityRaw
            : priorityRaw
              ? Number.parseFloat(priorityRaw)
              : undefined;

        urls.push({
          loc,
          lastmod: entry.lastmod?.trim(),
          changefreq: entry.changefreq?.trim(),
          priority: Number.isNaN(priority ?? Number.NaN) ? undefined : priority,
        });
      }

      return {
        url,
        type: "urlset",
        urls,
        childSitemaps: [],
        errors,
        urlCount: urls.length,
        // Namespace, not filename: `google-news-sitemap.xml` is convention, and a news sitemap served
        // from any path still declares xmlns:news. See SitemapData.isNewsSitemap for why it matters.
        isNewsSitemap: typeof urlset["@_xmlns:news"] === "string",
      };
    }

    return unreadableSitemap(url, "Unknown sitemap format");
  } catch (error) {
    return unreadableSitemap(url, `Parse error: ${(error as Error).message}`);
  }
}

function isHtmlContentType(contentType: string | null): boolean {
  const essence = contentType?.split(";")[0]?.trim().toLowerCase();
  return essence === "text/html" || essence === "application/xhtml+xml";
}

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * The index just past a `<!DOCTYPE ...>` that starts at `start`, or -1 when it
 * never closes. Quotes, comments, processing instructions and an internal
 * `[...]` subset may hold a `>`.
 */
function doctypeEnd(text: string, start: number): number {
  let quote: string | null = null;
  let subset = false;
  for (let i = start + 2; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (text.startsWith("<!--", i) || text.startsWith("<?", i)) {
      const close = text[i + 1] === "?" ? "?>" : "-->";
      const end = text.indexOf(close, i + 2);
      if (end === -1) return -1;
      i = end + close.length - 1;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "[") {
      subset = true;
    } else if (c === "]") {
      subset = false;
    } else if (c === ">" && !subset) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * What a body opens with, past whitespace, XML declarations, processing
 * instructions, comments and a non-HTML doctype: a web page (an HTML doctype or
 * `<html>` root), a sitemap root (`<urlset>`, `<sitemapindex>`, any prefix),
 * other markup, or no markup at all. A scan rather than a regex: each skipped
 * construct is passed over once, so the cost is linear however the opening is
 * built.
 */
function bodyOpening(text: string): "html" | "sitemap" | "xml" | "not-xml" {
  let i = 0;
  for (;;) {
    while (i < text.length && isXmlSpace(text.charCodeAt(i))) i++;
    let end: number;
    if (text.startsWith("<?", i)) {
      end = text.indexOf("?>", i + 2);
      end = end === -1 ? -1 : end + 2;
    } else if (text.startsWith("<!--", i)) {
      end = text.indexOf("-->", i + 4);
      end = end === -1 ? -1 : end + 3;
    } else if (text.slice(i, i + 9).toLowerCase() === "<!doctype") {
      if (/^<!doctype\s+html\b/i.test(text.slice(i, i + 32))) return "html";
      end = doctypeEnd(text, i);
    } else {
      break;
    }
    // Unterminated: markup, but nothing more can be said about it.
    if (end === -1) return "xml";
    i = end;
  }
  if (text.charCodeAt(i) !== 0x3c) return "not-xml";
  const tag = /^<([a-z_][\w.:-]*)/i.exec(text.slice(i, i + 256))?.[1];
  if (!tag) return "xml";
  const name = (tag.split(":").pop() ?? "").toLowerCase();
  if (name === "html") return "html";
  return name === "urlset" || name === "sitemapindex" ? "sitemap" : "xml";
}

export interface DecodedSitemapBody {
  data: SitemapData;
  /**
   * The body was not sitemap content at all: an HTML page, or text that is not
   * XML. A catch-all server answers 200 with a page for every path, so at a
   * location the walk only GUESSED this means no sitemap lives there; it is a
   * defect only where the site claimed one (#670). Never set for a body that
   * opens with a sitemap root, however broken the rest of it is.
   */
  notASitemap?: true;
}

function hasGzipSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

type Inflate = (bytes: Uint8Array, options: { maxOutputLength: number }) => Uint8Array;

/** HTTP's `deflate` is zlib-wrapped, but servers that send it raw are common enough to accept. */
const inflateEither: Inflate = (bytes, options) => {
  try {
    return inflateSync(bytes, options);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    return inflateRawSync(bytes, options);
  }
};

const INFLATERS = new Map<string, Inflate>([
  ["gzip", gunzipSync],
  ["x-gzip", gunzipSync],
  ["deflate", inflateEither],
  ["br", brotliDecompressSync],
]);

/** Undo one coding, bounded by SITEMAP_MAX_BYTES; a string is the error to record. */
function inflateWithin(coding: string, bytes: Uint8Array): Uint8Array | string {
  const inflate = INFLATERS.get(coding);
  if (!inflate) return `${SITEMAP_UNSUPPORTED_ENCODING_ERROR}: ${coding}`;
  try {
    return inflate(bytes, { maxOutputLength: SITEMAP_MAX_BYTES });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      return SITEMAP_TOO_LARGE_ERROR;
    }
    const prefix = inflate === gunzipSync ? SITEMAP_CORRUPT_GZIP_ERROR : `Corrupt ${coding} body`;
    return `${prefix}: ${(error as Error).message}`;
  }
}

/**
 * Whether this runtime's fetch hands back the raw bytes when asked to
 * (`decompress: false`). Bun does, and it is what runs the crawl (the CLI and
 * the cloud containers). Elsewhere fetch has already decoded the body and the
 * Content-Encoding header is history, not an instruction.
 */
const FETCH_RETURNS_RAW_BODY = "Bun" in globalThis;

/**
 * Decode a fetched sitemap body and parse it.
 *
 * `contentEncoding` is the coding still on `bytes`: the walk fetches with the
 * runtime's decoding off, so it is undone here, within SITEMAP_MAX_BYTES. A body
 * that still starts with the gzip signature after that is a gzip FILE
 * (`sitemap.xml.gz` served as `application/gzip`), which the protocol allows.
 * It is decompressed once, within the same bound, and the result parsed as
 * XML (#662).
 */
export function decodeSitemapBody(
  bytes: Uint8Array,
  url: string,
  contentType: string | null,
  contentEncoding: string | null = null,
): DecodedSitemapBody {
  let body = bytes;

  const codings = (contentEncoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
  // One coding at most: each layer can inflate to the full limit, and nothing
  // a real server sends stacks them.
  if (codings.length > 1) {
    return { data: unreadableSitemap(url, `${SITEMAP_UNSUPPORTED_ENCODING_ERROR}: ${codings.join(", ")}`) };
  }
  const coding = codings[0];
  if (coding) {
    const inflated = inflateWithin(coding, body);
    if (typeof inflated === "string") return { data: unreadableSitemap(url, inflated) };
    body = inflated;
  }

  if (hasGzipSignature(body)) {
    const inflated = inflateWithin("gzip", body);
    if (typeof inflated === "string") return { data: unreadableSitemap(url, inflated) };
    body = inflated;
  }

  const text = new TextDecoder().decode(body);
  const opening = bodyOpening(text);
  if (opening === "html") {
    return { data: unreadableSitemap(url, SITEMAP_HTML_PAGE_ERROR), notASitemap: true };
  }

  const data = parseSitemap(text, url);
  if (opening === "sitemap" || data.errors.length === 0) return { data };
  // A page that opens with something other than a doctype (a fragment, a
  // script) still says what it is in its Content-Type.
  if (isHtmlContentType(contentType)) {
    return { data: unreadableSitemap(url, SITEMAP_HTML_PAGE_ERROR), notASitemap: true };
  }
  if (opening === "not-xml") return { data, notASitemap: true };
  return { data };
}

/**
 * The body as bytes, or null once it passes `maxBytes`. Metered chunk by chunk
 * and cancelled at the limit, so an oversized or endless body is never held in
 * full. Chunks are copied into one buffer as they arrive rather than kept, so a
 * body dribbled out a byte at a time costs bytes, not an object per chunk. A
 * read that fails (a stalled body aborted at the deadline) rejects.
 */
async function readBodyWithin(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  // A null body is a bodyless response, never a large one.
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  let buffer = new Uint8Array(64 * 1024);
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const needed = total + value.byteLength;
    if (needed > maxBytes) {
      // Not awaited: the answer is already known, and nothing should wait on
      // how a misbehaving origin's stream winds down.
      reader.cancel().catch(() => {});
      return null;
    }
    if (needed > buffer.byteLength) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(buffer.byteLength * 2, needed)));
      grown.set(buffer.subarray(0, total));
      buffer = grown;
    }
    buffer.set(value, total);
    total = needed;
  }
  return buffer.subarray(0, total);
}

export type SitemapFetchResult =
  | ({ success: true } & DecodedSitemapBody)
  | {
      success: false;
      url: string;
      error: string;
      /**
       * The origin answered and the request finished — a 404, a 500, an empty
       * body. False when nothing came back: a stall aborted at the deadline, a
       * connection error, or a fetch the walk never attempted.
       *
       * The walk's progress window keys off this rather than off `success`. A
       * fast 404 is real progress: the origin is responsive and the walk is
       * getting through its candidates, it just is not finding sitemaps
       * (squirrelscan/repo#1733).
       */
      settled: boolean;
    };

const SITEMAP_FETCH_TIMEOUT_MS = 30_000;

/**
 * How long the sitemap walk may go without completing a single fetch
 * (squirrelscan/repo#1733).
 *
 * The walk is the one preamble stage whose truncation costs PAGES, not just AX
 * metadata: cutting it short on a healthy site silently drops URLs the crawl
 * would have visited. So it is not governed by the root probes' shared ceiling,
 * which a site with many legitimate sitemaps would blow through honestly (60
 * one-URL sitemaps at ~4s a chunk is ~48s of perfectly good work).
 *
 * What separates that from the failure this issue is about is PROGRESS. A
 * stalled origin completes nothing, so the window expires after one dead chunk
 * and the walk stops; a slow-but-healthy origin keeps finishing chunks and
 * keeps earning a fresh window. Worst case for a stalled origin is therefore
 * roughly one chunk, not the whole walk.
 */
export const SITEMAP_WALK_WINDOW_MS = 20_000;
/** …and no more than this many full request timeouts, so a config asking for
 *  snappy requests gets a proportionally snappy walk. */
const WALK_WINDOW_REQUESTS = 3;

/** The walk's progress window for a given per-request timeout. */
export function sitemapWalkWindowMs(timeoutMs: number): number {
  return Math.min(SITEMAP_WALK_WINDOW_MS, Math.max(1, timeoutMs) * WALK_WINDOW_REQUESTS);
}

/**
 * Absolute ceiling on the whole walk, on top of the progress window.
 *
 * The window alone is gameable: an origin that answers ONE request per chunk
 * instantly and stalls the other four spends a full window per chunk and
 * re-arms it every time, so "makes progress" stays true forever and the walk
 * runs for as long as the origin cares to keep it up. Progress tells a stall
 * from honest slowness; it cannot tell honest slowness from a slow-drip attack,
 * and only a hard stop can.
 *
 * Truncating here is safe in a way it would not have been before: the walk
 * reports `truncated`, so consumers say "we did not finish looking" rather than
 * "this site has no sitemap". The cost of the cap is an honest gap in coverage,
 * not a false finding.
 */
export const SITEMAP_WALK_TOTAL_MS = 60_000;

/** Mutable walk state shared across the recursion. */
interface WalkWindow {
  /** Progress window; re-armed after each chunk that completes work. */
  deadlineAt: number;
  /** Length of a fresh window. */
  windowMs: number;
  /** Hard stop for the walk as a whole, never extended. */
  hardDeadlineAt: number;
  /** Set whenever the walk abandons candidates it had not visited. */
  stoppedEarly: boolean;
}

function newWalkWindow(
  windowMs: number = SITEMAP_WALK_WINDOW_MS,
  totalMs: number = SITEMAP_WALK_TOTAL_MS,
): WalkWindow {
  const now = Date.now();
  return {
    deadlineAt: now + windowMs,
    windowMs,
    // NOT max(): a caller asking for a hard stop shorter than the window means
    // it, and silently widening a configured bound is how a cap stops being one.
    // `walkRemainingMs` takes whichever of the two is nearer.
    hardDeadlineAt: now + totalMs,
    stoppedEarly: false,
  };
}

/** ms the walk may still spend: the progress window or the hard stop, whichever is nearer. */
function walkRemainingMs(walkWindow: WalkWindow): number {
  return Math.min(walkWindow.deadlineAt, walkWindow.hardDeadlineAt) - Date.now();
}

export function fetchSitemap(
  url: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
  baseHost?: string,
  // squirrelscan/repo#1733: deadline for this one fetch, tightened by the
  // caller when the walk's progress window has less than a full timeout left.
  timeoutMs: number = SITEMAP_FETCH_TIMEOUT_MS,
  // Where a refusal (401/403/429, a bot wall) is noted, so the report can
  // say the sitemap request was refused rather than that no sitemap exists.
  refusals?: RefusalLog,
): Effect.Effect<SitemapFetchResult, never, never> {
  // #1393: the caller's secret customHeaders are scoped to the audited origin. A
  // `Sitemap:` directive (robots.txt) or child-sitemap reference can point at an
  // off-origin host, so only forward them when the target host matches baseHost.
  // When baseHost is unset (direct callers/tests), preserve prior behavior.
  const originScopedHeaders =
    baseHost !== undefined && new URL(url).host !== baseHost ? undefined : customHeaders;
  return Effect.promise(async (): Promise<SitemapFetchResult> => {
    if (timeoutMs <= 0) {
      return { success: false, url, error: SITEMAP_NOT_REACHED_ERROR, settled: false };
    }
    try {
      // #1395: manual redirects — per-hop scheme allowlist + strip secret
      // customHeaders on cross-origin redirects (native redirect:"follow" leaks them).
      // The deadline covers the body read too: a sitemap index that answers 200
      // and then stalls its body would otherwise park the crawl forever (#1699).
      return await safeFetchWithDeadline(
        url,
        {
          headers: {
            "User-Agent": userAgent,
            Accept: "application/xml, text/xml, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip",
            ...originScopedHeaders,
          },
          redirect: "follow",
          // #662: a Bun fetch option. Bun's own decoding inflates a whole
          // response before a reader can stop it (a 1 MB gzip bomb cost 1.9 GB
          // that way), so the walk takes the raw bytes and decodeSitemapBody
          // undoes the Content-Encoding within SITEMAP_MAX_BYTES.
          decompress: false,
        } as RequestInit,
        timeoutMs,
        async (response): Promise<SitemapFetchResult> => {
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            noteRefusal(refusals, url, "sitemap", response);
            // The origin answered; the status IS the answer.
            return { success: false, url, error: `HTTP ${response.status}`, settled: true };
          }
          // A body that never arrives (including a deadline abort) classifies
          // as "Empty response", the same as one that arrives empty. This text
          // reaches persisted sitemap-failure records, so it stays what it was
          // before the read moved inside the deadline.
          let body: Uint8Array | null;
          try {
            body = await readBodyWithin(response, SITEMAP_MAX_BYTES);
          } catch {
            // The read never finished — a stalled or aborted body.
            return { success: false, url, error: "Empty response", settled: false };
          }
          if (body === null) {
            return { success: true, data: unreadableSitemap(url, SITEMAP_TOO_LARGE_ERROR) };
          }
          // Arrived, just empty.
          if (body.byteLength === 0) {
            return { success: false, url, error: "Empty response", settled: true };
          }
          return {
            success: true,
            ...decodeSitemapBody(
              body,
              url,
              response.headers.get("content-type"),
              FETCH_RETURNS_RAW_BODY ? response.headers.get("content-encoding") : null,
            ),
          };
        },
      );
    } catch (error) {
      return {
        success: false,
        url,
        error: error instanceof Error ? error.message : "Network error",
        settled: false,
      };
    }
  });
}

const SITEMAP_FETCH_CONCURRENCY = 5;

/**
 * Mutable URL budget shared across the recursive sitemap fetch.
 * Once `remaining` drops to 0 no further sitemaps (including
 * sitemap-index children) are fetched. Prevents huge sites
 * (news sites with 400k+ sitemap URLs across thousands of child
 * sitemaps) from being ingested wholesale when we only crawl maxPages.
 */
export interface SitemapUrlBudget {
  remaining: number;
}

/**
 * Compute the sitemap URL ingestion cap for a crawl budget.
 * We keep ~10x the page budget so coverage modes still have a diverse
 * pool to prioritize from, with a floor of 1000.
 */
export function computeSitemapUrlCap(maxPages: number): number {
  return Math.max(maxPages * 10, 1000);
}

export function fetchSitemapsRecursive(
  urls: string[],
  userAgent: string,
  maxDepth = 3,
  currentDepth = 0,
  seen: Set<string> = new Set(),
  urlBudget?: SitemapUrlBudget,
  customHeaders?: Record<string, string>,
  // #1393: host of the audited origin; customHeaders are only forwarded to
  // matching-host sitemap fetches. Threaded through the recursion.
  baseHost?: string,
  // squirrelscan/repo#1733: progress window shared across the whole walk, so a
  // stalled origin ends the descent after one dead chunk while a slow-but-
  // healthy one keeps going. Created on the first call and threaded down.
  walkWindow: WalkWindow = newWalkWindow(),
  refusals?: RefusalLog,
): Effect.Effect<SitemapFetchResult[], never, never> {
  if (urls.length === 0) return Effect.succeed([]);
  // Candidates exist but the walk will not visit them: that is a gap in
  // coverage, and absence must not be inferred from it downstream.
  if (currentDepth >= maxDepth || (urlBudget && urlBudget.remaining <= 0)) {
    walkWindow.stoppedEarly = true;
    return Effect.succeed([]);
  }
  return Effect.gen(function* () {
    const unseenUrls = urls.filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });

    if (unseenUrls.length === 0) {
      return [];
    }

    const fetchResults: SitemapFetchResult[] = [];
    const childUrls: string[] = [];

    // Fetch in chunks so we can stop early once the URL budget is exhausted
    // instead of fetching every child of a huge sitemap index.
    for (let i = 0; i < unseenUrls.length; i += SITEMAP_FETCH_CONCURRENCY) {
      if (urlBudget && urlBudget.remaining <= 0) {
        logger.debug(
          "sitemap URL budget exhausted, skipping remaining sitemaps",
          `${unseenUrls.length - i} skipped at depth ${currentDepth}`,
        );
        walkWindow.stoppedEarly = true;
        break;
      }
      // Checked per chunk, not once per level: a level can hold thousands of an
      // index's children, and without this every remaining one is still chunked
      // and awaited just to record a skip after the walk has given up.
      const remainingMs = walkRemainingMs(walkWindow);
      if (remainingMs <= 0) {
        logger.debug(
          "sitemap walk stopped, skipping remaining sitemaps",
          `${unseenUrls.length - i} skipped at depth ${currentDepth}`,
        );
        walkWindow.stoppedEarly = true;
        break;
      }

      const chunk = unseenUrls.slice(i, i + SITEMAP_FETCH_CONCURRENCY);
      const chunkTimeoutMs = Math.min(SITEMAP_FETCH_TIMEOUT_MS, remainingMs);
      const chunkResults = yield* Effect.all(
        chunk.map((url) =>
          fetchSitemap(url, userAgent, customHeaders, baseHost, chunkTimeoutMs, refusals),
        ),
        { concurrency: SITEMAP_FETCH_CONCURRENCY },
      );
      fetchResults.push(...chunkResults);
      // Any chunk where the origin ANSWERED earns a fresh window — a fast 404
      // is progress, not a stall. Keying this off `success` instead punished a
      // real shape: one quick 404 alongside four stalled bodies is a responsive
      // origin the walk is getting through, yet the chunk found no sitemap and
      // the window died after one round. Only a chunk where nothing came back
      // at all burns it.
      if (chunkResults.some((result) => result.success || result.settled)) {
        walkWindow.deadlineAt = Math.min(
          Date.now() + walkWindow.windowMs,
          walkWindow.hardDeadlineAt,
        );
      }

      for (const result of chunkResults) {
        if (!result.success) continue;
        const sitemap = result.data;

        if (urlBudget) {
          urlBudget.remaining -= sitemap.urlCount;
        }

        if (sitemap.type !== "index") continue;

        const parentHost = new URL(sitemap.url).host;
        for (const childUrl of sitemap.childSitemaps) {
          try {
            const childHost = new URL(childUrl).host;
            if (childHost !== parentHost) {
              logger.debug(
                "cross-domain sitemap reference skipped",
                `${sitemap.url} -> ${childUrl}`,
              );
              continue;
            }
            childUrls.push(childUrl);
          } catch {
            logger.debug("invalid child sitemap URL", childUrl);
          }
        }
      }
    }

    const childResults = yield* fetchSitemapsRecursive(
      childUrls,
      userAgent,
      maxDepth,
      currentDepth + 1,
      seen,
      urlBudget,
      customHeaders,
      baseHost,
      walkWindow,
      refusals,
    );

    return [...fetchResults, ...childResults];
  });
}

const COMMON_SITEMAP_LOCATIONS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemaps.xml",
  "/sitemap1.xml",
  "/post-sitemap.xml",
  "/page-sitemap.xml",
  "/news-sitemap.xml",
];

export interface SitemapDiscoveryResult {
  discovered: SitemapData[];
  all: SitemapData[];
  failed: SitemapFetchFailure[];
  /**
   * The walk gave up before visiting every entry point, so `discovered` being
   * empty is NOT evidence that the site has no sitemap (squirrelscan/repo#1733).
   * Consumers must report unknown rather than missing when this is set.
   */
  truncated: boolean;
}

export interface DiscoverSitemapsOptions {
  /** Stop fetching further sitemaps once this many URLs have been parsed */
  maxUrls?: number;
  /** Custom HTTP headers attached to every sitemap fetch (e.g. Web Bot Auth signatures). */
  customHeaders?: Record<string, string>;
  /**
   * How long the walk may go without completing a fetch before it gives up.
   * Defaults to SITEMAP_WALK_WINDOW_MS; pass `sitemapWalkWindowMs(timeoutMs)` to
   * scale it with a crawl's per-request timeout (squirrelscan/repo#1733).
   */
  walkWindowMs?: number;
  /** Hard stop for the whole walk. Defaults to SITEMAP_WALK_TOTAL_MS. */
  walkTotalMs?: number;
  /** Notes sitemap requests the site refused. */
  refusals?: RefusalLog;
}

export function discoverSitemaps(
  baseUrl: string,
  robotsTxt: RobotsTxtData | null,
  userAgent: string,
  options: DiscoverSitemapsOptions = {},
): Effect.Effect<SitemapDiscoveryResult, never, never> {
  return Effect.gen(function* () {
    const sitemapUrls = new Set<string>();
    const robotsSitemaps = new Set<string>();

    // #1393: robots.txt is untrusted page content. A `Sitemap:` directive can
    // carry any scheme/host, so `resolveRobotsSitemapUrl` rejects non-http(s)
    // targets (a `file://` sitemap would otherwise be fetched and its body
    // parsed/stored). Off-origin http(s) sitemaps are still fetched (legit CDN
    // case) but without customHeaders, enforced by the baseHost gate passed to
    // fetchSitemapsRecursive below. #2316: the same resolver reads a scheme-less
    // line as a HOST, so the URL fetched here is the one the report stores.
    const baseHost = new URL(baseUrl).host;
    if (robotsTxt?.sitemaps) {
      for (const sitemap of robotsTxt.sitemaps) {
        const resolvedUrl = resolveRobotsSitemapUrl(sitemap, baseUrl).url;
        if (resolvedUrl === null) {
          logger.debug(`Unusable sitemap URL in robots.txt skipped: ${sitemap}`);
          continue;
        }
        sitemapUrls.add(resolvedUrl);
        robotsSitemaps.add(resolvedUrl);
      }
    }

    for (const path of COMMON_SITEMAP_LOCATIONS) {
      sitemapUrls.add(new URL(path, baseUrl).toString());
    }

    const entryPoints = Array.from(sitemapUrls);
    const urlBudget: SitemapUrlBudget | undefined =
      options.maxUrls !== undefined ? { remaining: options.maxUrls } : undefined;
    // Shared with the recursion so a level abandoned DEEP in the walk still
    // reports truncation. Counting only unvisited entry points would miss it:
    // every common location can be visited while an index's children are
    // dropped, which is a real gap in the URLs the crawl will see.
    const walkWindow = newWalkWindow(options.walkWindowMs, options.walkTotalMs);
    const walked = yield* fetchSitemapsRecursive(
      entryPoints,
      userAgent,
      undefined,
      undefined,
      undefined,
      urlBudget,
      options.customHeaders,
      baseHost,
      walkWindow,
      options.refusals,
    );

    // #670: a server that answers 200 with a page for every path makes each
    // guessed location look like a broken sitemap. A web page at a location the
    // walk only guessed means no sitemap lives there; it stays a defect where the
    // site claimed a sitemap, in a robots.txt `Sitemap:` line or an index entry.
    const claimed = new Set(robotsSitemaps);
    for (const result of walked) {
      if (!result.success) continue;
      for (const childUrl of result.data.childSitemaps) claimed.add(childUrl);
    }
    const allResults = walked.map(
      (result): SitemapFetchResult =>
        result.success && result.notASitemap && !claimed.has(result.data.url)
          ? {
              success: false,
              url: result.data.url,
              error: result.data.errors[0] ?? SITEMAP_HTML_PAGE_ERROR,
              settled: true,
            }
          : result,
    );

    const allSitemaps = allResults.filter((result) => result.success).map((result) => result.data);
    const entryPointSet = new Set(entryPoints);
    const discovered = allSitemaps.filter((sitemap) => entryPointSet.has(sitemap.url));

    const sourceOf = (url: string) =>
      robotsSitemaps.has(url) ? ("robots.txt" as const) : ("common" as const);

    const failed: SitemapFetchFailure[] = allResults
      .filter(
        (result): result is { success: false; url: string; error: string; settled: boolean } =>
          !result.success && entryPointSet.has(result.url),
      )
      .map((result) => ({ url: result.url, source: sourceOf(result.url), error: result.error }));

    // An entry point with NO result at all was never visited — the walk stopped
    // first. Record each one rather than letting it vanish, so "we did not look"
    // is never silently indistinguishable from "there was nothing there".
    const attempted = new Set(
      allResults.map((result) => (result.success ? result.data.url : result.url)),
    );
    const unvisited = entryPoints.filter((url) => !attempted.has(url));
    for (const url of unvisited) {
      failed.push({ url, source: sourceOf(url), error: SITEMAP_NOT_REACHED_ERROR });
    }

    return {
      discovered,
      all: allSitemaps,
      failed,
      truncated: walkWindow.stoppedEarly || unvisited.length > 0,
    };
  });
}

/**
 * Select up to `cap` URLs for enqueueing, round-robin across sitemaps so
 * coverage modes sample every section (child sitemaps usually map to
 * sections/post types/date archives) instead of exhausting the first
 * sitemap file before the cap is hit. Deduplicates by loc.
 */
export function selectSitemapUrls(sitemaps: SitemapData[], cap: number): SitemapUrl[] {
  const lists = sitemaps.filter((sitemap) => sitemap.urls.length > 0).map((sitemap) => sitemap.urls);
  const selected: SitemapUrl[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let anyLeft = true;

  while (anyLeft && selected.length < cap) {
    anyLeft = false;
    for (const urls of lists) {
      if (selected.length >= cap) break;
      const url = urls[offset];
      if (!url) continue;
      anyLeft = true;
      if (seen.has(url.loc)) continue;
      seen.add(url.loc);
      selected.push(url);
    }
    offset++;
  }

  return selected;
}

export function getUrlsFromSitemaps(sitemaps: SitemapData[]): string[] {
  const urls: string[] = [];
  for (const sitemap of sitemaps) {
    for (const url of sitemap.urls) {
      urls.push(url.loc);
    }
  }
  return urls;
}
