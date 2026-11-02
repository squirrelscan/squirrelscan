// The urls file of a batch audit (#1231): one URL per line, read as untrusted input.
//
// Only what is safe to hand to a child `squirrel audit` gets through: http and https, no userinfo (a credential in a
// listed URL would end up in a results file and in process arguments), no host that is not public unless the caller
// allows private hosts, and a length and a count that bound the work. A line that is refused is returned with its line
// number and a reason, never dropped silently, so the batch can record it. The key of a URL, which names its report and
// its manifest record, is a hash of the URL: nothing the file says reaches a file name.

import { isNonPublicHostname } from "@squirrelscan/utils/non-public-host";
import { createHash } from "node:crypto";

import {
  BATCH_MAX_URLS,
  BATCH_URL_MAX_LENGTH,
  BATCH_URLS_FILE_MAX_BYTES,
} from "../constants";

export type UrlRejectionReason =
  | "too-long"
  | "invalid"
  | "not-http"
  | "userinfo"
  | "non-public-host";

export interface BatchUrl {
  /** The URL as audited: absolute, fragment removed. */
  url: string;
  /** A stable name for the URL's report and record: the first 16 hex characters of the SHA-256 of {@link url}. */
  key: string;
  /** 1-based line of the file the URL was first listed on. */
  line: number;
}

export interface RejectedUrl {
  line: number;
  /** The line as written, cut to {@link BATCH_URL_MAX_LENGTH} characters so a huge line is not echoed back whole. */
  text: string;
  reason: UrlRejectionReason;
}

export type UrlsFileResult =
  | {
      ok: true;
      urls: BatchUrl[];
      rejected: RejectedUrl[];
      /** Lines whose URL was already listed earlier (same URL once the fragment is removed). */
      duplicates: number;
      /** More URLs than {@link BATCH_MAX_URLS} were listed: the first ones are kept and the rest are not read. */
      truncated: boolean;
    }
  | { ok: false; reason: "too-large"; bytes: number };

export interface ParseOptions {
  /** Keep a URL whose host is not public (loopback, private networks, dotless names). Off by default. */
  allowPrivateHosts?: boolean;
}

/** The key of a URL: see {@link BatchUrl.key}. */
export function urlKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** One line as a URL, or the reason it is refused. */
function readLine(
  text: string,
  options: ParseOptions
): { url: string } | { reason: UrlRejectionReason } {
  if (text.length > BATCH_URL_MAX_LENGTH) return { reason: "too-long" };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { reason: "not-http" };
  if (parsed.username !== "" || parsed.password !== "")
    return { reason: "userinfo" };
  if (parsed.hostname === "") return { reason: "invalid" };
  if (
    options.allowPrivateHosts !== true &&
    isNonPublicHostname(parsed.hostname.replace(/^\[|\]$/g, ""))
  ) {
    return { reason: "non-public-host" };
  }
  parsed.hash = "";
  return { url: parsed.href };
}

/**
 * The URLs of a urls file. Blank lines and lines that start with `#` are ignored, a byte-order mark and a carriage return
 * are not part of a URL, and a file over {@link BATCH_URLS_FILE_MAX_BYTES} is refused. Linear in the size of the file.
 */
export function parseUrlsFile(
  content: string,
  options: ParseOptions = {}
): UrlsFileResult {
  const bytes = Buffer.byteLength(content);
  if (bytes > BATCH_URLS_FILE_MAX_BYTES)
    return { ok: false, reason: "too-large", bytes };
  const urls: BatchUrl[] = [];
  const rejected: RejectedUrl[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let truncated = false;
  let lineNumber = 0;
  let start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start <= content.length) {
    let end = content.indexOf("\n", start);
    if (end === -1) end = content.length;
    lineNumber++;
    const text = content.slice(start, end).trim();
    start = end + 1;
    if (text === "" || text.startsWith("#")) continue;
    const read = readLine(text, options);
    if ("reason" in read) {
      rejected.push({
        line: lineNumber,
        text: text.slice(0, BATCH_URL_MAX_LENGTH),
        reason: read.reason,
      });
      continue;
    }
    if (seen.has(read.url)) {
      duplicates++;
      continue;
    }
    if (urls.length >= BATCH_MAX_URLS) {
      truncated = true;
      break;
    }
    seen.add(read.url);
    urls.push({ url: read.url, key: urlKey(read.url), line: lineNumber });
  }
  return { ok: true, urls, rejected, duplicates, truncated };
}
