// What a browser render saw beyond the HTML (#425): the browser's own `securitypolicyviolation` events,
// and the requests it could not make, including those that fired a few seconds after `load`. Carried on the
// rendered page result, stored with the page and read by `security/csp-violations`. This module is the
// ingestion side only: no renderer in this repo collects the events yet.
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
  /** The status, when a response arrived but was an error. */
  status?: number;
}

export interface BrowserEvents {
  cspViolations: BrowserCspViolation[];
  failedRequests: BrowserFailedRequest[];
  /** Distinct violations (by directive and host) past the cap that were not recorded. */
  droppedViolations?: number;
  /**
   * True when the renderer listened for a few seconds past `load` (the whole window the rule can rely on);
   * absent or false when it stopped at `load`, so a violation that fires after hydration could be missed.
   */
  listenedAfterLoad?: boolean;
}

export const BROWSER_EVENT_LIMITS = {
  cspViolations: 100,
  failedRequests: 200,
  /** Raw entries looked at, so a page that raises thousands of events costs a bounded scan. */
  scan: 2000,
  text: 500,
} as const;

/** A CSP directive name: lowercase letters, digits and hyphens, nothing free-form. */
const DIRECTIVE = /^[a-z][a-z0-9-]{0,59}$/;

/** What a rejected URL's authority may hold: a host name, an IPv6 literal or a port, never free text. */
const HOSTISH = /^[a-z0-9.\-[\]:]{1,120}$/i;

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
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}${url.pathname}`.slice(0, 300);
    // A WebSocket path is as page-chosen as a query (`/socket/<token>`): origin only.
    if (url.protocol === "wss:" || url.protocol === "ws:") return url.origin.slice(0, 300);
    // The schemes CSP reports by name; a `javascript:` or any other URL is not evidence worth keeping.
    return KEYWORD_SCHEMES.has(url.protocol) ? url.protocol : undefined;
  } catch {
    return /^[a-z-]{1,20}$/i.test(text) ? text.toLowerCase() : undefined;
  }
}

/**
 * A `blockedUri` that is a URL of a scheme `eventUrl` does not keep (`ftp:`, `chrome-extension:`, `javascript:`...): its
 * scheme and host only, never userinfo, port, path, query or fragment. Page script can dispatch a synthetic violation
 * event with any string, so no part of such a value is kept raw. A URL the parser rejects (a hostile run made a space in
 * the host) is cut the same way, at its first `/`, `?`, `#` or `\`, after the userinfo; anything that is not a URL is
 * undefined (CSP's own keywords, `inline` and `eval`, are `eventUrl`'s). The scheme is at most 30 characters, colon
 * included, so what is stored survives a reload through this reader unchanged.
 */
function otherSchemeOrigin(value: unknown): string | undefined {
  const text = clean(value, 2048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol.length > 30) return undefined;
    const scheme = url.protocol.toLowerCase();
    return url.hostname ? `${scheme}//${url.hostname.slice(0, 120).toLowerCase()}` : scheme;
  } catch {
    const m = /^([a-z][a-z0-9+.-]{0,28}:\/\/)(?:[^/?#\\]*@)?([^/?#\\]*)/i.exec(text);
    return m && m[2] && HOSTISH.test(m[2]) ? `${m[1]!.toLowerCase()}${m[2].toLowerCase()}` : undefined;
  }
}

/** The host of an already-sanitised blocked URI, or its keyword (`inline`, `data:`) when it has none. */
function blockedHost(blockedUri: string): string {
  try {
    const url = new URL(blockedUri);
    return url.hostname ? url.hostname.toLowerCase() : url.protocol;
  } catch {
    return blockedUri.toLowerCase();
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
  const seen = new Set<string>();
  let dropped = 0;
  const rawViolations = Array.isArray(raw.cspViolations) ? raw.cspViolations.slice(0, BROWSER_EVENT_LIMITS.scan) : [];
  for (const item of rawViolations) {
    if (!isRecord(item)) continue;
    const violatedDirective = clean(item.violatedDirective, 60)?.toLowerCase();
    const blockedUri = eventUrl(item.blockedUri) ?? otherSchemeOrigin(item.blockedUri);
    if (!violatedDirective || !DIRECTIVE.test(violatedDirective) || !blockedUri) continue;
    const effective = clean(item.effectiveDirective, 60)?.toLowerCase();
    const effectiveDirective = effective && DIRECTIVE.test(effective) ? effective : undefined;
    const disposition = item.disposition === "enforce" || item.disposition === "report" ? item.disposition : undefined;
    // One entry per directive, host and disposition: a page that blocks the same host a thousand times must not
    // push the other hosts past the cap.
    const key = `${violatedDirective}\u0000${blockedHost(blockedUri)}\u0000${disposition ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (violations.length >= BROWSER_EVENT_LIMITS.cspViolations) {
      dropped++;
      continue;
    }
    const sourceFile = eventUrl(item.sourceFile);
    const line = typeof item.lineNumber === "number" && Number.isInteger(item.lineNumber) && item.lineNumber >= 0 ? item.lineNumber : undefined;
    violations.push({
      violatedDirective,
      ...(effectiveDirective ? { effectiveDirective } : {}),
      blockedUri,
      ...(sourceFile ? { sourceFile } : {}),
      ...(line !== undefined ? { lineNumber: line } : {}),
      ...(disposition ? { disposition } : {}),
    });
  }
  // A stored count survives a reload; a fresh read only counts what it dropped itself.
  const storedDropped = typeof raw.droppedViolations === "number" && Number.isInteger(raw.droppedViolations) && raw.droppedViolations > 0 ? Math.min(raw.droppedViolations, 1_000_000) : 0;
  dropped = Math.min(dropped + storedDropped, 1_000_000);
  const failed: BrowserFailedRequest[] = [];
  for (const item of Array.isArray(raw.failedRequests) ? raw.failedRequests.slice(0, BROWSER_EVENT_LIMITS.scan) : []) {
    if (failed.length >= BROWSER_EVENT_LIMITS.failedRequests) break;
    if (!isRecord(item)) continue;
    const url = eventUrl(item.url);
    if (!url) continue;
    const method = clean(item.method, 10);
    const resourceType = clean(item.resourceType, 30);
    failed.push({
      url,
      ...(method ? { method: method.toUpperCase() } : {}),
      ...(resourceType ? { resourceType: resourceType.toLowerCase() } : {}),
      ...(typeof item.status === "number" && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599 ? { status: item.status } : {}),
    });
  }
  if (violations.length === 0 && failed.length === 0 && dropped === 0 && raw.listenedAfterLoad !== true) return undefined;
  return {
    cspViolations: violations,
    failedRequests: failed,
    ...(dropped > 0 ? { droppedViolations: dropped } : {}),
    ...(raw.listenedAfterLoad === true ? { listenedAfterLoad: true } : {}),
  };
}
