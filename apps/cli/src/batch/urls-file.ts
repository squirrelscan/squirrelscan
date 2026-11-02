// The urls file of a batch audit (#1231): one URL per line, read as untrusted input.
//
// Only what is safe to hand to a child `squirrel audit` gets through: http and https (a bare `example.com` or
// `localhost:3000` is read as https), no userinfo (a credential in a listed URL would end up in a results file and in
// process arguments), no control character, no host that is not public unless the caller allows private hosts (the strict
// classifier: private, loopback, link-local, documentation, benchmarking, multicast and reserved ranges, and NAT64, 6to4,
// Teredo and site-local IPv6), and a length and a count that bound the work. A line that is refused is returned with its
// line number and a reason, never dropped silently, so the batch can record it; the text echoed back has userinfo, query
// values and fragment masked, so a credential in a refused line cannot reach a results file either. The key of a URL,
// which names its report and its manifest record, is a hash of the URL: nothing the file says reaches a file name.
//
// A file over the byte cap, or listing more than `maxUrls` distinct URLs, is an error before any request is made, not a
// silent cut. The byte check runs on a string that is already decoded: a caller must stat the file, or read at most the cap
// plus one byte, before it decodes. Slice 2 note: a manifest that ends in a partial line (a crash mid-write) must have that
// line terminated before the next record is appended, or the new record joins it.

import { isNonPublicHostnameStrict } from "@squirrelscan/utils/non-public-host";
import { createHash } from "node:crypto";

import {
  BATCH_MAX_REJECTED_KEPT,
  BATCH_MAX_URLS,
  BATCH_URL_MAX_LENGTH,
  BATCH_URLS_FILE_MAX_BYTES,
} from "../constants";

export type UrlRejectionReason =
  | "too-long"
  | "invalid"
  | "control-char"
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
  /**
   * The line as written, cut to {@link BATCH_URL_MAX_LENGTH} characters and with userinfo, query values and the fragment
   * masked (`***`) and control characters shown as U+FFFD: it is meant for a results file, which must never hold a credential.
   */
  text: string;
  reason: UrlRejectionReason;
}

export type UrlsFileResult =
  | {
      ok: true;
      urls: BatchUrl[];
      /** The first {@link ParseOptions.maxRejected} refused lines; {@link rejectedCount} counts them all. */
      rejected: RejectedUrl[];
      rejectedCount: number;
      /** Lines whose URL was already listed earlier (same URL once the fragment is removed). */
      duplicates: number;
    }
  | { ok: false; reason: "too-large"; bytes: number; max: number }
  | { ok: false; reason: "too-many-urls"; max: number };

export interface ParseOptions {
  /** Keep a URL whose host is not public (loopback, private networks, dotless names). Off by default. */
  allowPrivateHosts?: boolean;
  /** Most distinct URLs: more is an error, not a cut. Default {@link BATCH_MAX_URLS}. */
  maxUrls?: number;
  /** Most bytes of file. Default {@link BATCH_URLS_FILE_MAX_BYTES}; see the file header for who must check it first. */
  maxBytes?: number;
  /** Most refused lines kept with their text. Default {@link BATCH_MAX_REJECTED_KEPT}. */
  maxRejected?: number;
}

/** The key of a URL: see {@link BatchUrl.key}. */
export function urlKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** C0 and C1 controls and DEL (Unicode category Cc). */
const CONTROL_CHARS = /\p{Cc}/u;
const SCHEME_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i;
/** A scheme written without slashes (`javascript:`, `mailto:`): a colon not followed by a port. */
const BARE_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i;

/** A line made safe to store: userinfo, query values and fragment masked, control characters shown as U+FFFD. Linear. */
function redactForEcho(line: string): string {
  const text = line
    .slice(0, BATCH_URL_MAX_LENGTH)
    .replace(/\p{Cc}/gu, "\uFFFD");
  const scheme = SCHEME_SLASHES.exec(text)?.[0] ?? "";
  const rest = text.slice(scheme.length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const afterAuthority = authorityEnd === -1 ? "" : rest.slice(authorityEnd);
  const at = authority.lastIndexOf("@");
  const safeAuthority = at === -1 ? authority : `***${authority.slice(at)}`;
  const hash = afterAuthority.indexOf("#");
  const beforeHash =
    hash === -1 ? afterAuthority : afterAuthority.slice(0, hash);
  const question = beforeHash.indexOf("?");
  let safe = question === -1 ? beforeHash : beforeHash.slice(0, question + 1);
  if (question !== -1) {
    safe += beforeHash
      .slice(question + 1)
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        return eq === -1 ? "***" : `${pair.slice(0, eq)}=***`;
      })
      .join("&");
  }
  return `${scheme}${safeAuthority}${safe}${hash === -1 ? "" : "#***"}`;
}

/** One line as a URL, or the reason it is refused. */
function readLine(
  text: string,
  options: ParseOptions
): { url: string } | { reason: UrlRejectionReason } {
  if (text.length > BATCH_URL_MAX_LENGTH) return { reason: "too-long" };
  if (CONTROL_CHARS.test(text)) return { reason: "control-char" };
  // A bare host (`example.com`, `localhost:3000`) is read as https; a scheme-less path or another scheme is not.
  const candidate =
    SCHEME_SLASHES.test(text) || BARE_SCHEME.test(text) || text.startsWith("/")
      ? text
      : `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
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
    isNonPublicHostnameStrict(parsed.hostname.replace(/^\[|\]$/g, ""))
  ) {
    return { reason: "non-public-host" };
  }
  parsed.hash = "";
  // The parser can grow a URL (IDN to punycode, percent-encoding): the length cap applies to what is audited and echoed.
  if (parsed.href.length > BATCH_URL_MAX_LENGTH) return { reason: "too-long" };
  return { url: parsed.href };
}

/**
 * The URLs of a urls file. Blank lines and lines that start with `#` are ignored, a byte-order mark and a carriage return
 * are not part of a URL, and a file over the byte cap, or with more distinct URLs than `maxUrls`, is refused. Linear in the
 * size of the file; memory is bounded by the URL cap and the rejected cap, not by the size of the file.
 */
export function parseUrlsFile(
  content: string,
  options: ParseOptions = {}
): UrlsFileResult {
  const maxBytes = options.maxBytes ?? BATCH_URLS_FILE_MAX_BYTES;
  const maxUrls = options.maxUrls ?? BATCH_MAX_URLS;
  const maxRejected = options.maxRejected ?? BATCH_MAX_REJECTED_KEPT;
  const bytes = Buffer.byteLength(content);
  if (bytes > maxBytes)
    return { ok: false, reason: "too-large", bytes, max: maxBytes };
  const urls: BatchUrl[] = [];
  const rejected: RejectedUrl[] = [];
  let rejectedCount = 0;
  const seen = new Set<string>();
  let duplicates = 0;
  let lineNumber = 0;
  let start = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start <= content.length) {
    let end = content.indexOf("\n", start);
    if (end === -1) end = content.length;
    lineNumber++;
    // A line far past the cap is refused from its head alone: it is not copied, trimmed and scanned whole.
    const huge = end - start > BATCH_URL_MAX_LENGTH * 2;
    const text = (
      huge
        ? content.slice(start, start + BATCH_URL_MAX_LENGTH + 1)
        : content.slice(start, end)
    ).trim();
    start = end + 1;
    if (text === "" || text.startsWith("#")) continue;
    const read = huge
      ? { reason: "too-long" as const }
      : readLine(text, options);
    if ("reason" in read) {
      rejectedCount++;
      if (rejected.length < maxRejected) {
        rejected.push({
          line: lineNumber,
          text: redactForEcho(text),
          reason: read.reason,
        });
      }
      continue;
    }
    if (seen.has(read.url)) {
      duplicates++;
      continue;
    }
    if (urls.length >= maxUrls)
      return { ok: false, reason: "too-many-urls", max: maxUrls };
    seen.add(read.url);
    urls.push({ url: read.url, key: urlKey(read.url), line: lineNumber });
  }
  return { ok: true, urls, rejected, rejectedCount, duplicates };
}
