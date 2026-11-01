// What a browser render saw beyond the HTML (#425): the browser's own `securitypolicyviolation` events,
// the requests it could not make and the errors the page threw, including those that fired a few seconds
// after `load`. Collected by the renderer, carried on the rendered page result, stored with the page and
// read by `security/csp-violations`.
//
// The data comes from the audited page, so it is untrusted by the time it is read: every string is
// stripped of control characters and bounded, every URL is cut to an origin and path (a query string or a
// fragment can carry a token), and every list is capped. `readBrowserEvents` is the one place that does it.

import { stripUnsafeLineText } from "./control-chars";

/** One `securitypolicyviolation` event the browser raised. */
export interface BrowserCspViolation {
  /** The directive the browser says was violated (`script-src-elem`). */
  violatedDirective: string;
  /** The directive that applied after fallback (`script-src`), when it differs. */
  effectiveDirective?: string;
  /** What was blocked: an origin and path, or a keyword (`inline`, `eval`, `data`). */
  blockedUri: string;
  /** The script that triggered it, as an origin and path. */
  sourceFile?: string;
  lineNumber?: number;
  /** `enforce` (blocked) or `report` (a report-only policy: nothing was blocked). */
  disposition?: "enforce" | "report";
}

/** A request the browser could not complete. */
export interface BrowserFailedRequest {
  /** The request URL as an origin and path. */
  url: string;
  method?: string;
  resourceType?: string;
  /** The browser's failure text (`net::ERR_BLOCKED_BY_CSP`). */
  failure?: string;
  /** The status, when a response arrived but was an error. */
  status?: number;
}

export interface BrowserEvents {
  cspViolations: BrowserCspViolation[];
  failedRequests: BrowserFailedRequest[];
  /** Uncaught page errors and unhandled rejections, as text. */
  pageErrors: string[];
  /**
   * True when the renderer listened for a few seconds past `load` (the whole window the rule can rely on);
   * absent or false when it stopped at `load`, so a violation that fires after hydration could be missed.
   */
  listenedAfterLoad?: boolean;
}

export const BROWSER_EVENT_LIMITS = {
  cspViolations: 100,
  failedRequests: 200,
  pageErrors: 50,
  text: 500,
} as const;

/**
 * Characters that render as nothing or change how text reads: zero-width spaces and joiners, the BOM, the soft
 * hyphen, the TAG block, variation selectors and the Hangul fillers (all Default_Ignorable_Code_Point). A page
 * controls these strings, so none of them is kept.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/** One line of untrusted text: invisible characters gone, C0/C1 controls (tab and newline too), bidi controls and line separators replaced by a space, runs of space collapsed. */
export const eventLine = (value: string): string => stripUnsafeLineText(value.replace(INVISIBLE, "")).replace(/ {2,}/g, " ");

const clean = (value: unknown, max: number = BROWSER_EVENT_LIMITS.text): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = eventLine(value.slice(0, max * 4)).trim().slice(0, max);
  return text === "" ? undefined : text;
};

/**
 * A URL as origin and path: no userinfo, query or fragment. A value that is not an absolute http(s) URL
 * (a CSP keyword such as `inline`, `eval`, `data`, `blob`, or garbage) is kept only when it is a short plain word.
 */
export function eventUrl(value: unknown): string | undefined {
  const text = clean(value, 2048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "wss:" || url.protocol === "ws:") {
      return `${url.origin}${url.pathname}`.slice(0, 300);
    }
    // The schemes CSP reports by name; a `javascript:` or any other URL is not evidence worth keeping.
    return KEYWORD_SCHEMES.has(url.protocol) ? url.protocol : undefined;
  } catch {
    return /^[a-z-]{1,20}$/i.test(text) ? text.toLowerCase() : undefined;
  }
}

/**
 * A `blockedUri` that is a URL of a scheme `eventUrl` does not keep (`ftp:`, `chrome-extension:`, `javascript:`...): its
 * scheme and host only, never userinfo, port, path, query or fragment. Page script can dispatch a synthetic violation
 * event with any string, so no part of such a value is kept raw. A string that is not a URL is kept only when it is plain
 * words of at most 40 characters (the keywords CSP names), or as a scheme and path with userinfo, query and fragment removed
 * when it only looks like a URL; anything else is undefined.
 */
function otherSchemeOrigin(value: unknown): string | undefined {
  const text = clean(value, 2048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    const scheme = url.protocol.slice(0, 30).toLowerCase();
    return url.hostname ? `${scheme}//${url.hostname.slice(0, 120).toLowerCase()}` : scheme;
  } catch {
    // Not a URL: a CSP keyword (`inline`, `eval`) or what a hostile event made of one. Only plain words are kept, never
    // anything with a scheme, a path, a query or an assignment in it.
    if (/^[\w .-]{1,40}$/.test(text)) return text;
    // A URL the parser rejects (a hostile run made a space in the host): userinfo, query and fragment still never survive.
    const m = /^([a-z][a-z0-9+.-]{0,29}:\/\/)(?:[^/?#]*@)?([^?#]*)/i.exec(text);
    return m ? `${m[1]!.toLowerCase()}${m[2]!}`.slice(0, 200) : undefined;
  }
}

const KEYWORD_SCHEMES = new Set(["data:", "blob:", "filesystem:", "about:"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The browser events of a render result, made safe to store and show, or undefined when there is none.
 * Anything malformed is dropped rather than failing the page.
 */
export function readBrowserEvents(raw: unknown): BrowserEvents | undefined {
  if (!isRecord(raw)) return undefined;
  const violations: BrowserCspViolation[] = [];
  for (const item of Array.isArray(raw.cspViolations) ? raw.cspViolations : []) {
    if (violations.length >= BROWSER_EVENT_LIMITS.cspViolations) break;
    if (!isRecord(item)) continue;
    const violatedDirective = clean(item.violatedDirective, 60);
    const blockedUri = eventUrl(item.blockedUri) ?? otherSchemeOrigin(item.blockedUri);
    if (!violatedDirective || !blockedUri) continue;
    const effectiveDirective = clean(item.effectiveDirective, 60);
    const sourceFile = eventUrl(item.sourceFile);
    const line = typeof item.lineNumber === "number" && Number.isInteger(item.lineNumber) && item.lineNumber >= 0 ? item.lineNumber : undefined;
    violations.push({
      violatedDirective: violatedDirective.toLowerCase(),
      ...(effectiveDirective ? { effectiveDirective: effectiveDirective.toLowerCase() } : {}),
      blockedUri,
      ...(sourceFile ? { sourceFile } : {}),
      ...(line !== undefined ? { lineNumber: line } : {}),
      ...(item.disposition === "enforce" || item.disposition === "report" ? { disposition: item.disposition } : {}),
    });
  }
  const failed: BrowserFailedRequest[] = [];
  for (const item of Array.isArray(raw.failedRequests) ? raw.failedRequests : []) {
    if (failed.length >= BROWSER_EVENT_LIMITS.failedRequests) break;
    if (!isRecord(item)) continue;
    const url = eventUrl(item.url);
    if (!url) continue;
    const method = clean(item.method, 10);
    const resourceType = clean(item.resourceType, 30);
    const failure = clean(item.failure, 120);
    failed.push({
      url,
      ...(method ? { method: method.toUpperCase() } : {}),
      ...(resourceType ? { resourceType: resourceType.toLowerCase() } : {}),
      ...(failure ? { failure } : {}),
      ...(typeof item.status === "number" && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599 ? { status: item.status } : {}),
    });
  }
  const errors: string[] = [];
  for (const item of Array.isArray(raw.pageErrors) ? raw.pageErrors : []) {
    if (errors.length >= BROWSER_EVENT_LIMITS.pageErrors) break;
    const text = clean(item);
    if (text) errors.push(text);
  }
  if (violations.length === 0 && failed.length === 0 && errors.length === 0 && raw.listenedAfterLoad !== true) return undefined;
  return {
    cspViolations: violations,
    failedRequests: failed,
    pageErrors: errors,
    ...(raw.listenedAfterLoad === true ? { listenedAfterLoad: true } : {}),
  };
}
