// The urls file of a batch audit (#1231): one URL per line, read as untrusted input.
//
// Only what is safe to hand to a child `squirrel audit` gets through: http and https (a bare `example.com` or
// `localhost:3000` is read as https), no userinfo (a credential in a listed URL would end up in a results file and in
// process arguments), no control character, no host that is not public unless the caller allows private hosts (the policy
// classifier, `isNonPublicHostnameForPolicy`: private, loopback, link-local, documentation, benchmarking, multicast and reserved ranges, and NAT64, 6to4,
// Teredo and site-local IPv6), and a length and a count that bound the work. A line that is refused is returned with its
// line number and a reason, never dropped silently, so the batch can record it; the text echoed back has userinfo, query
// values and fragment masked, so a credential in a refused line cannot reach a results file either. What is NOT masked: the
// path and the NAMES of query keys are echoed as written, and so are the path and query of an accepted URL, which land in the
// manifest and in child process arguments: a secret carried in a path or a query key is not protected here. The key of a URL,
// which names its report and its manifest record, is a hash of the URL: nothing the file says reaches a file name.
//
// A file over the byte cap, or listing more than `maxUrls` distinct URLs, is an error before any request is made, not a
// silent cut. The byte check runs on a string that is already decoded: a caller must stat the file, or read at most the cap
// plus one byte, before it decodes. Slice 2 note: a manifest that ends in a partial line (a crash mid-write) must have that
// line terminated before the next record is appended, or the new record joins it.

import { isNonPublicHostnameForPolicy } from "@squirrelscan/utils/non-public-host";
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

/** Mask query values and fragment of an already userinfo-free string. */
function maskQueryFragment(afterAuthority: string): string {
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
  return `${safe}${hash === -1 ? "" : "#***"}`;
}
/** Candidate as readLine builds it. */
function candidateOf(text: string): string {
  return SCHEME_SLASHES.test(text) ||
    BARE_SCHEME.test(text) ||
    text.startsWith("/")
    ? text
    : `https://${text}`;
}
/**
 * A line made safe to store. The WHATWG parser decides where the authority is (it reads any mix of `/` and `\` after the scheme),
 * so when it finds userinfo the echo is rebuilt from its parts and nothing of the original authority is kept. When it throws, the
 * fallback masks everything up to the last `@`, fullwidth or small `@`, or `%40` before the first `?` or `#`. Linear.
 */
function redactForEcho(line: string): string {
  const text = line
    .slice(0, BATCH_URL_MAX_LENGTH)
    .replace(/\p{Cc}/gu, "\uFFFD");
  // 1. the parser's own view: when it sees userinfo, rebuild from its parts, nothing of the original authority survives
  try {
    const u = new URL(candidateOf(line.trim()));
    if (u.username !== "" || u.password !== "") {
      return `${u.protocol}//***@${u.host}${u.pathname}${maskQueryFragment(`${u.search}${u.hash === "" ? "" : "#"}`)}`.slice(
        0,
        BATCH_URL_MAX_LENGTH
      );
    }
  } catch {
    /* fall through */
  }
  // 2. conservative fallback (parse failed, or the line was cut / has controls): cut at the first ? or #, then mask
  //    everything up to the LAST at-sign (ASCII, fullwidth, small, percent-encoded) in that head, slashes or not.
  const cut = text.search(/[?#]/);
  const head = cut === -1 ? text : text.slice(0, cut);
  const tail = cut === -1 ? "" : text.slice(cut);
  let at = Math.max(
    head.lastIndexOf("@"),
    head.lastIndexOf("\uFF20"),
    head.lastIndexOf("\uFE6B")
  );
  const pct = head.toLowerCase().lastIndexOf("%40");
  if (pct > at) at = pct + 2;
  // only a scheme that is one is kept: `token:secret@host` has a secret where a scheme would be
  const scheme = /^(?:https?|ftp|wss?|file):/i.exec(head)?.[0] ?? "";
  const safeHead = at === -1 ? head : `${scheme}***@${head.slice(at + 1)}`;
  return `${safeHead}${maskQueryFragment(tail)}`;
}

/** One line as a URL, or the reason it is refused. */
function readLine(
  text: string,
  options: ParseOptions
): { url: string } | { reason: UrlRejectionReason } {
  if (text.length > BATCH_URL_MAX_LENGTH) return { reason: "too-long" };
  if (CONTROL_CHARS.test(text)) return { reason: "control-char" };
  // A bare host (`example.com`, `localhost:3000`) is read as https; a scheme-less path or another scheme is not.
  const candidate = candidateOf(text);
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
    isNonPublicHostnameForPolicy(parsed.hostname.replace(/^\[|\]$/g, ""))
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
    const lineLength = end - start;
    const huge = lineLength > BATCH_URL_MAX_LENGTH * 2;
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
        // A line cut for length may have its `@` past the cut, so nothing of it is echoed but its size.
        const cut = huge || text.length > BATCH_URL_MAX_LENGTH;
        rejected.push({
          line: lineNumber,
          text: cut
            ? `[line of ${huge ? lineLength : text.length}+ characters]`
            : redactForEcho(text),
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
