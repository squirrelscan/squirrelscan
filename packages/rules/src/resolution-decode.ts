// The server side of the compact resolution signal (#2658): inflate, bound and
// validate a `CompactResolutionSignal` back into the `ResolutionSignal` the
// smart-audits merge reads (the API's side; the producers' builder is
// ./resolution). Inflates with node:zlib: Workers `nodejs_compat`, or Bun.
//
// node:zlib rather than DecompressionStream: workerd inflates a whole input
// chunk before the first read, so a stream reader's byte cap comes too late (a
// 258 KB body of deflated zeros raised a local workerd's RSS by ~215 MiB).
// `inflateRawSync`'s `maxOutputLength` stops inside the inflate.

import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";

import type { ResolutionSignal } from "@squirrelscan/core-contracts";
import {
  REPORT_LIMITS,
  RESOLUTION_PUBLISH_LIMITS,
  RESOLUTION_SIGNAL_LIMITS,
} from "@squirrelscan/core-contracts/limits";
import {
  type CompactResolutionPayload,
  type CompactResolutionSignal,
  resolutionUrlHash,
} from "@squirrelscan/core-contracts/resolution";

const isStringArray = (value: unknown, max: number, maxLength: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((s) => typeof s === "string" && s.length <= maxLength);

/**
 * Inflate a {@link CompactResolutionSignal} back into the {@link ResolutionSignal}
 * the merge reads: `crawledUrls` are the listed pages, and every index becomes
 * the `resolutionUrlHash` of its URL, the value the original producer would
 * have sent. Validates as strictly as the publish schema validates the original
 * shape and THROWS on anything out of bounds; a caller that catches it should
 * drop the signal, which only ever costs resolutions (findings carry), never
 * causes one.
 *
 * Inflates at most RESOLUTION_PUBLISH_LIMITS.maxInflatedBytes, and parses only
 * JSON whose containers and separators fit what a valid payload can hold, so a
 * small hostile body cannot cost the API isolate (128 MB) more than a few MiB.
 */
export async function decodeResolutionSignal(
  compact: CompactResolutionSignal,
): Promise<ResolutionSignal> {
  if (compact.v !== 1) throw new Error(`unknown compact resolution signal version ${compact.v}`);
  // The publish schema bounds this too; the decoder does not rely on it.
  if (typeof compact.data !== "string" || compact.data.length > RESOLUTION_PUBLISH_LIMITS.maxBytes) {
    throw new Error("compact resolution signal: data past the signal's byte budget");
  }
  const json = inflateCapped(compact.data, RESOLUTION_PUBLISH_LIMITS.maxInflatedBytes);
  assertParseBounded(json);
  const payload = JSON.parse(json) as Partial<CompactResolutionPayload>;
  const maxKey = REPORT_LIMITS.maxMediumString;
  if (payload.v !== 1) throw new Error("compact resolution payload: bad version");
  if (!isStringArray(payload.urls, limits.maxCrawledUrls, REPORT_LIMITS.maxUrlLength)) {
    throw new Error("compact resolution payload: bad urls");
  }
  const other = payload.other ?? [];
  if (!isStringArray(other, limits.maxHashesTotal, REPORT_LIMITS.maxUrlLength)) {
    throw new Error("compact resolution payload: bad other");
  }
  if (typeof payload.complete !== "boolean") {
    throw new Error("compact resolution payload: bad complete");
  }
  const urls = payload.urls;
  const pages = payload.pages;
  // Bounded by the crawl ceiling: the merge counts it as audited pages, and
  // billing reads that count.
  if (
    typeof pages !== "number" ||
    !Number.isSafeInteger(pages) ||
    pages < urls.length ||
    pages > REPORT_LIMITS.maxPages ||
    // A complete list is every crawled page, deduped; `other` only rides with one.
    (payload.complete && pages !== urls.length)
  ) {
    throw new Error("compact resolution payload: bad pages");
  }
  if (!payload.complete && other.length > 0) {
    throw new Error("compact resolution payload: other with a partial list");
  }
  const truncated = payload.truncated ?? [];
  if (!isStringArray(truncated, limits.maxChecks, maxKey)) {
    throw new Error("compact resolution payload: bad truncated");
  }

  const hashes: string[] = [];
  const hashAt = (index: number): string =>
    (hashes[index] ??= resolutionUrlHash(
      index < urls.length ? urls[index]! : other[index - urls.length]!,
    ));
  const decodeMap = <T>(
    field: string,
    record: Record<string, number[]> | undefined,
    indexLimit: number,
    value: (index: number) => T,
  ): Record<string, T[]> => {
    if (record === undefined) return {};
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error(`compact resolution payload: bad ${field}`);
    }
    const entries = Object.entries(record);
    if (entries.length > limits.maxChecks)
      throw new Error(`compact resolution payload: ${field} keys`);
    const out: Record<string, T[]> = {};
    let total = 0;
    for (const [key, gaps] of entries) {
      if (key.length > maxKey || !Array.isArray(gaps) || gaps.length > limits.maxHashesPerCheck) {
        throw new Error(`compact resolution payload: bad ${field} entry`);
      }
      total += gaps.length;
      if (total > limits.maxHashesTotal)
        throw new Error(`compact resolution payload: ${field} size`);
      const set: T[] = [];
      let index = -1;
      for (const gap of gaps) {
        if (typeof gap !== "number" || !Number.isSafeInteger(gap) || gap < 0) {
          throw new Error(`compact resolution payload: bad ${field} index`);
        }
        index += gap + 1;
        if (index >= indexLimit)
          throw new Error(`compact resolution payload: ${field} index range`);
        set.push(value(index));
      }
      out[key] = set;
    }
    return out;
  };
  if (payload.failing === undefined) throw new Error("compact resolution payload: no failing");
  const failing = decodeMap("failing", payload.failing, urls.length + other.length, hashAt);
  const notEvaluated = decodeMap("notEvaluated", payload.notEvaluated, urls.length, hashAt);

  const removedByStatus = decodeMap("removed", payload.removed, urls.length, (i) => urls[i]!);
  const removedPages: Array<{ url: string; status: number }> = [];
  for (const [status, removedUrls] of Object.entries(removedByStatus)) {
    if (status !== "404" && status !== "410") {
      throw new Error("compact resolution payload: bad removed status");
    }
    for (const url of removedUrls) removedPages.push({ url, status: Number(status) });
  }
  const removedCount = payload.removedCount ?? 0;
  if (
    typeof removedCount !== "number" ||
    !Number.isSafeInteger(removedCount) ||
    removedCount < removedPages.length ||
    removedCount > pages ||
    (payload.complete && removedCount !== removedPages.length)
  ) {
    throw new Error("compact resolution payload: bad removedCount");
  }

  return {
    crawledUrls: urls,
    failing,
    ...(Object.keys(notEvaluated).length > 0 ? { notEvaluated } : {}),
    ...(truncated.length > 0 ? { truncated } : {}),
    ...(payload.complete ? {} : { crawledComplete: false, crawledCount: pages }),
    ...(removedPages.length > 0 ? { removedPages } : {}),
    ...(removedCount > 0 ? { removedCount } : {}),
  };
}

/**
 * base64 → raw inflate → UTF-8, never more than `maxBytes` of output: past it
 * the inflate itself stops and this throws.
 */
function inflateCapped(base64: string, maxBytes: number): string {
  let out: Buffer;
  try {
    out = inflateRawSync(Buffer.from(base64, "base64"), { maxOutputLength: maxBytes });
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`compact resolution signal inflates past ${maxBytes} bytes`);
    }
    throw err;
  }
  return out.toString("utf8");
}

// What a valid payload can hold, from the limits the decoder checks it against:
// the root, its five lists, and one array per key of `failing`, `notEvaluated`
// and `removed` (containers); one separator per list element, key and field.
const limits = RESOLUTION_SIGNAL_LIMITS;
const MAX_CONTAINERS = 3 * limits.maxChecks + 16;
const MAX_SEPARATORS =
  limits.maxCrawledUrls + 4 * limits.maxHashesTotal + 3 * limits.maxChecks + 16;
/** Root, a map, its arrays. */
const MAX_DEPTH = 3;

/**
 * Refuse JSON whose shape no valid payload has, before `JSON.parse` builds it:
 * a few KB of deflated `{},` under an unknown key would otherwise allocate
 * millions of objects. One pass, strings skipped.
 */
function assertParseBounded(json: string): void {
  let containers = 0;
  let separators = 0;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (inString) {
      if (c === 92 /* \ */) i++;
      else if (c === 34 /* " */) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 123 /* { */ || c === 91 /* [ */) {
      if (++containers > MAX_CONTAINERS || ++depth > MAX_DEPTH) {
        throw new Error("compact resolution payload: shape past the signal's bounds");
      }
    } else if (c === 125 /* } */ || c === 93 /* ] */) depth--;
    else if (c === 44 /* , */ && ++separators > MAX_SEPARATORS) {
      throw new Error("compact resolution payload: shape past the signal's bounds");
    }
  }
}
