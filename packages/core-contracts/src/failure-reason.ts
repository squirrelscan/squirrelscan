/**
 * Audit failure classification (#1822).
 *
 * A crawl that fetched nothing used to end with one string, "No pages were
 * crawled", on every surface: `agent_runs.error`, the in-app notification, the
 * failure email, Sentry grouping and the MCP status. The crawler already knew
 * WHY the root fetch died, so this module gives that knowledge a small
 * user-facing vocabulary shared by the engine, the renderers, the CLI and the
 * cloud/email surfaces.
 *
 * Leaf module by design: no imports outside this package's own control-char
 * helper, so the API Worker, the email templates and the crawler can all pull
 * it without dragging anything else in.
 */
import { stripControlChars } from "./control-chars";

/**
 * The classes a zero-page audit can fail in. `unknown` is the honest fallback
 * for a failure we could not attribute; it must NEVER read as "nothing went
 * wrong" (see the renderers, which still print a failure notice for it).
 */
export const AUDIT_FAILURE_REASON_CODES = [
  "dns",
  "tls",
  "connection",
  "timeout",
  "http_4xx",
  "http_5xx",
  "redirect",
  "robots",
  "unknown",
] as const;

export type AuditFailureReasonCode = (typeof AUDIT_FAILURE_REASON_CODES)[number];

export function isAuditFailureReasonCode(value: unknown): value is AuditFailureReasonCode {
  return (
    typeof value === "string" &&
    (AUDIT_FAILURE_REASON_CODES as readonly string[]).includes(value)
  );
}

/**
 * Which URL the failure came from. `entry` is the audited URL itself and always
 * outranks `sitemap` when both are known: the seed is what the user asked for.
 *
 * Only these two are produced today. A robots.txt or llms.txt probe failure has
 * no source of its own because it never ends a crawl on its own; add one here
 * alongside the code that records it, not ahead of it.
 */
export type AuditFailureSource = "entry" | "sitemap";

/**
 * Structured detail about the fetch failure that ended a crawl with no
 * auditable content. Recorded by the crawler on `CrawlStats.rootFailure`, read
 * by `deriveAuditStatus` to build the report's `statusReason` +
 * `statusReasonCode`. Every field past `code` is optional so an older
 * persisted stats blob (or a fetcher that told us nothing) still classifies.
 */
export interface AuditFailureDetail {
  code: AuditFailureReasonCode;
  /** Hostname of the URL that failed. Never a full URL: reasons are quoted in
   *  emails and markdown, and a host cannot carry a path/query payload. */
  host?: string;
  /** HTTP status when the origin actually answered. */
  status?: number;
  /** One short extra fact (certificate expired, NXDOMAIN, the redirect target).
   *  Origin-influenced text, so it is stripped and length-capped here. */
  detail?: string;
  /** Which fetch failed; absent reads as `entry`. */
  source?: AuditFailureSource;
}

/** Keeps a reason inside `agent_runs.error`'s 500-char bound with room to spare. */
const MAX_DETAIL_LENGTH = 120;
const MAX_HOST_LENGTH = 80;

/**
 * Absolute URLs inside a runtime error message. Reduced to their host below:
 * a reason sentence is quoted in an email, a markdown report and a log line,
 * and the path and query of a site-chosen URL have no business in any of them.
 * Bounded character classes only, and no adjacent quantifiers, so this cannot
 * backtrack catastrophically on a hostile message.
 */
const ABSOLUTE_URL = /\bhttps?:\/\/([^\s/?#"'<>]{1,253})[^\s"'<>]*/gi;

/**
 * Characters that would give an origin-influenced fragment STRUCTURE once the
 * reason is printed: markdown links and code spans, an HTML tag, a table cell
 * break. Emphasis markers (`*`, `_`) are deliberately left alone: they are
 * inert inside a one-line fragment, and stripping them mangles ordinary
 * identifiers (squirrelscan/repo#1798).
 */
const STRUCTURAL_CHARS = /[`[\]<>|]/g;

/**
 * Normalize an origin-influenced fragment before it is embedded in a reason
 * sentence: strip control characters (so a reason can't break a log line, a
 * markdown table or an email body), reduce any absolute URL to its host, drop
 * the characters that would turn text into markup, collapse whitespace, and cap
 * the length.
 */
function sanitizeFragment(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const cleaned = stripControlChars(value)
    .replace(ABSOLUTE_URL, (_match, host: string) => host)
    .replace(STRUCTURAL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return undefined;
  // The ellipsis counts toward the cap: `max` is a hard ceiling because these
  // fragments are concatenated into a reason bounded by a 500-char DB column.
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

/** Build a detail with every origin-influenced field already sanitized. */
export function auditFailureDetail(input: AuditFailureDetail): AuditFailureDetail {
  const status =
    typeof input.status === "number" && Number.isInteger(input.status) ? input.status : undefined;
  return {
    code: input.code,
    ...(sanitizeFragment(input.host, MAX_HOST_LENGTH)
      ? { host: sanitizeFragment(input.host, MAX_HOST_LENGTH) }
      : {}),
    ...(status !== undefined ? { status } : {}),
    ...(sanitizeFragment(input.detail, MAX_DETAIL_LENGTH)
      ? { detail: sanitizeFragment(input.detail, MAX_DETAIL_LENGTH) }
      : {}),
    ...(input.source ? { source: input.source } : {}),
  };
}

/** Human phrase for the statuses a root fetch realistically dies on. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  410: "Gone",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  429: "Too Many Requests",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  508: "Loop Detected",
  521: "Web Server Is Down",
  522: "Connection Timed Out",
  523: "Origin Is Unreachable",
  525: "SSL Handshake Failed",
};

function statusPhrase(status: number | undefined): string {
  if (status === undefined) return "an error";
  // Object.hasOwn, not `in`/[]: the key comes from a persisted blob and a
  // prototype method must never surface as a status phrase.
  const text = Object.hasOwn(STATUS_TEXT, status) ? STATUS_TEXT[status] : undefined;
  return text ? `${status} ${text}` : String(status);
}

function siteName(detail: AuditFailureDetail): string {
  return detail.host ?? "the site";
}

/**
 * The short reason sentence stored as `AuditReport.statusReason` and copied to
 * `agent_runs.error`. Deliberately one sentence and under the 500-char column
 * bound, and deliberately phrased so {@link classifyAuditFailureReasonText} can
 * read the class back off it on surfaces that only ever see the string.
 */
export function auditFailureReasonText(detail: AuditFailureDetail): string {
  const site = siteName(detail);
  const extra = detail.detail ? `: ${detail.detail}` : "";
  switch (detail.code) {
    case "dns":
      // A colon, like every other class, NOT parentheses: these sentences are
      // escaped before they reach a markdown report, and `\(NXDOMAIN\)` in
      // the most-read line of a failed report reads worse than the risk it
      // would carry unescaped.
      return `DNS lookup failed for ${site}${extra}`;
    case "tls":
      return `TLS handshake with ${site} failed${extra}`;
    case "connection":
      return `Connection to ${site} failed before any response${extra}`;
    case "timeout":
      return `No response from ${site} within the request timeout${extra}`;
    case "http_4xx":
    case "http_5xx":
      return `${site} returned ${statusPhrase(detail.status)}${extra}`;
    case "redirect":
      return `Redirect from ${site} could not be followed${extra}`;
    case "robots":
      return `robots.txt disallows crawling ${site}`;
    case "unknown":
      return `No pages were crawled from ${site}${extra}`;
  }
}

/**
 * What the owner should do next, second person, for the surfaces that address
 * the site owner directly: the failure email, the HTML report, and the CLI's
 * text/markdown output.
 */
export const AUDIT_FAILURE_NEXT_STEP: Readonly<Record<AuditFailureReasonCode, string>> = {
  dns: "Check the domain's DNS records and that the hostname resolves from the public internet. If you moved hosts recently, wait for the change to propagate and re-run the audit.",
  tls: "Renew or repair the TLS certificate so it is valid for this hostname and served with the full chain, then re-run the audit.",
  connection:
    "Check that the origin server is running and accepting connections from the public internet, and that no firewall is dropping our requests.",
  timeout:
    "The origin accepted the connection but did not answer in time. Check server load, slow database queries, or a firewall holding the connection open, then re-run the audit.",
  // Covers both shapes a 4xx entry URL takes, because the class alone cannot
  // tell them apart and the wrong half of this advice is useless: a refusal
  // (401/403/429) is a wall to open, a 404/410 is an address to correct. The
  // reason line printed directly above names the exact status.
  http_4xx:
    "The server did not return the page. A 401, 403 or 429 is a refusal: allowlist the squirrelscan crawler in your WAF or bot protection, turn off bot fight mode for the audit, or check that the URL is reachable without a login. A 404 or 410 means the page is not there: check that the address is right and that it is published.",
  http_5xx:
    "The server hit an error of its own. Check your error logs and re-run the audit once the site is serving normally.",
  redirect:
    "Audit the URL the site actually serves, or fix the redirect so it lands on a page on the same site.",
  robots:
    "Allow the squirrelscan crawler in robots.txt, or point the audit at a path robots.txt permits.",
  // Kept as the pre-#1822 wording: `unknown` is the branch every older report
  // and every unattributable failure lands in, and this is the copy those
  // surfaces already shipped.
  unknown:
    "No pages could be fetched from this site, so there was nothing to audit. Check that the site is reachable and try again.",
};

/**
 * One sentence naming the cause, second person, for the report's failure
 * notice (the HTML report and the dashboard). Sits above the next step, which
 * says what to do about it.
 */
export const AUDIT_FAILURE_CAUSE: Readonly<Record<AuditFailureReasonCode, string>> = {
  dns: "We couldn't resolve your site's hostname, so there was no server to fetch pages from and nothing to audit.",
  tls: "We couldn't complete a TLS handshake with your site, so no page could be read securely and there was nothing to audit.",
  connection:
    "Nothing answered at your site's origin. The connection was refused, reset, or closed before any response arrived, so there was nothing to audit.",
  timeout:
    "Your site accepted our connection but never sent a response in time, so no page could be read and there was nothing to audit.",
  http_4xx:
    "Your site did not return a page for any request we made, so there was nothing to audit. Either it refused us, or the address we audited is not there.",
  http_5xx:
    "Your site returned a server error for every request we made, so there was nothing to audit.",
  redirect:
    "The URL we audited redirected somewhere we could not follow, so no page on your site could be read.",
  robots:
    "Your robots.txt disallows our crawler on this URL, so we did not fetch it and there was nothing to audit.",
  unknown:
    "We couldn't fetch any pages from your site, so there was nothing to audit. The site may have been down, unreachable, or timing out when we tried.",
};

/**
 * The same guidance in third person, for the agent-facing surfaces (the `llm`
 * renderer, the API report markdown, the MCP tools) which describe the site to
 * an agent rather than talking to its owner.
 */
export const AUDIT_FAILURE_NEXT_STEP_THIRD: Readonly<Record<AuditFailureReasonCode, string>> = {
  dns: "The hostname did not resolve. Check the domain's DNS records, and whether the domain has expired or was recently moved.",
  tls: "The TLS certificate could not be validated for this hostname. Check its expiry, hostname coverage, and that the full chain is served.",
  connection:
    "Nothing answered on the origin. Check that the server is running and reachable from the public internet.",
  timeout:
    "The origin accepted the connection but never answered. Check server load and any firewall holding connections open.",
  http_4xx:
    "The server did not return the page. A 401, 403 or 429 is a refusal, usually bot protection, a WAF rule or a login wall, and not a squirrelscan outage. A 404 or 410 means the URL does not exist, so the address being audited is probably wrong.",
  http_5xx:
    "The server returned an error of its own. Re-run the audit once the site is serving normally.",
  redirect:
    "The audited URL redirected somewhere the crawl could not follow. Audit the URL the site actually serves.",
  robots: "robots.txt disallows the crawler on this path. Audit a path robots.txt permits.",
  // Pre-#1822 wording, kept for the same reason as the second-person entry.
  unknown:
    "No pages could be fetched from the site, so nothing was audited. The site may have been down, unreachable, or timing out. Check that the site is reachable and try again.",
};

export function auditFailureNextStep(
  code: AuditFailureReasonCode,
  voice: "second" | "third" = "second",
): string {
  return voice === "third" ? AUDIT_FAILURE_NEXT_STEP_THIRD[code] : AUDIT_FAILURE_NEXT_STEP[code];
}

/**
 * Runtime error codes, mapped to the class they mean.
 *
 * A code is a far better signal than the message it comes with: it is a stable
 * contract, while the prose around it is reworded between runtime versions. Bun
 * 1.3 reported a DNS failure as `ConnectionRefused` with the message "Unable to
 * connect", and Bun 1.4 reports the same failure as `ENOTFOUND` with
 * "getaddrinfo ENOTFOUND" (squirrelscan/repo#1840). Matching the code means the
 * classification follows the runtime instead of chasing its wording.
 *
 * Keys are lowercased at lookup, so both errno style (`ENOTFOUND`) and Bun's
 * own PascalCase (`ConnectionRefused`) resolve.
 */
const ERRNO_CLASS: Readonly<Record<string, AuditFailureReasonCode>> = {
  enotfound: "dns",
  eai_again: "dns",
  eai_noname: "dns",
  dnsnotfound: "dns",
  econnrefused: "connection",
  econnreset: "connection",
  econnaborted: "connection",
  epipe: "connection",
  ehostunreach: "connection",
  enetunreach: "connection",
  connectionrefused: "connection",
  connectionreset: "connection",
  connectionclosed: "connection",
  etimedout: "timeout",
  timeout: "timeout",
  eproto: "tls",
  cert_has_expired: "tls",
  depth_zero_self_signed_cert: "tls",
  unable_to_verify_leaf_signature: "tls",
  err_tls_cert_altname_invalid: "tls",
};

/** How many nested `error.cause` levels to walk. Runtimes wrap a few deep. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The first runtime error code on an error or its `cause` chain.
 *
 * Mirrors how `isTlsError` in the crawler walks the chain: undici and Bun both
 * wrap the real failure behind a generic "fetch failed" a level or two up, so
 * the code on the outermost error is usually absent.
 */
export function fetchErrorCode(error: unknown): string | undefined {
  let current = error as { cause?: unknown; code?: unknown } | null | undefined;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current.code === "string" && current.code.length > 0) return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}

/**
 * Classify a runtime error code, or `undefined` when it names nothing we know.
 *
 * Undefined rather than `unknown` on purpose: the caller falls back to reading
 * the message, and a code we do not recognize must not stop it doing so.
 */
export function classifyFetchErrorCode(
  code: string | null | undefined,
): AuditFailureReasonCode | undefined {
  if (!code) return undefined;
  const key = code.toLowerCase();
  // Object.hasOwn, not `in`: the code comes from a runtime error and must not
  // be able to resolve to an inherited Object.prototype member.
  return Object.hasOwn(ERRNO_CLASS, key) ? ERRNO_CLASS[key] : undefined;
}

/**
 * Recover the failure class from a reason STRING.
 *
 * Needed because two surfaces only ever see the text: `agent_runs.error` (no
 * column for the code, and the completion PATCH carries only `error`) and the
 * Sentry/notification path built from it. The patterns below match the
 * sentences {@link auditFailureReasonText} produces, plus the raw crawler /
 * Chromium phrasings that reach the same surfaces from the CLI and the render
 * worker, so historic reasons classify too.
 *
 * An unrecognized reason returns `unknown` — which the renderers still treat as
 * a failure, never as an absence of one.
 */
export function classifyAuditFailureReasonText(
  reason: string | null | undefined,
): AuditFailureReasonCode {
  const r = (reason ?? "").toLowerCase();
  if (r.length === 0) return "unknown";

  // OUR failure, not the site's. The cloud container words a failed call to
  // squirrelscan's own API as "Callback '<label>' failed after N attempts
  // (HTTP 500: ...)", and that string can reach a surface that classifies it.
  // Checked first, and answered `unknown`, so an outage on our side is never
  // reported to a site owner as their server erroring.
  if (r.includes("callback '") && r.includes("failed after")) return "unknown";

  if (r.includes("robots.txt disallows")) return "robots";

  if (
    r.includes("err_name_not_resolved") ||
    r.includes("enotfound") ||
    r.includes("eai_again") ||
    r.includes("eai_noname") ||
    r.includes("getaddrinfo") ||
    r.includes("nxdomain") ||
    r.includes("could not resolve host") ||
    /dns (lookup|resolution) failed/.test(r)
  ) {
    return "dns";
  }

  if (
    r.includes("tls handshake") ||
    r.includes("tls/connection error") ||
    r.includes("ssl handshake") ||
    r.includes("err_cert_") ||
    r.includes("err_ssl_") ||
    r.includes("certificate has expired") ||
    r.includes("self-signed certificate") ||
    r.includes("self signed certificate") ||
    r.includes("unable to verify the first certificate") ||
    r.includes("hostname/ip does not match")
  ) {
    return "tls";
  }

  // Ahead of the status match so a message naming BOTH a status and a socket
  // failure ("Server error: 502, socket hang up") reads as the transport
  // failure it is, rather than as an application error the owner should go
  // hunting for in their logs.
  if (
    /err_connection_(reset|refused|closed|timed_out|aborted)/.test(r) ||
    /econn(reset|refused|aborted)/.test(r) ||
    /connection (reset|refused|closed|timed out)/.test(r) ||
    r.includes("socket connection was closed") ||
    r.includes("failed before any response") ||
    r.includes("socket hang up") ||
    r.includes("unable to connect") ||
    r.includes("err_empty_response")
  ) {
    return "connection";
  }

  // No bare "timed out": that would swallow an internal DB, R2 or upstream-API
  // timeout. Only browser/crawler signatures and the engine's own sentence,
  // whose BOTH halves are required.
  if (
    (r.includes("page.goto") && r.includes("timeout")) ||
    /timeout\s+\d+\s?ms\s+exceeded/.test(r) ||
    r.includes("navigation timeout") ||
    r.includes("err_timed_out") ||
    r.includes("etimedout") ||
    r.includes("crawl request timed out") ||
    (r.includes("no response from") && r.includes("within the request timeout"))
  ) {
    return "timeout";
  }

  if (
    r.includes("err_too_many_redirects") ||
    r.includes("redirect loop") ||
    r.includes("off-site redirect") ||
    r.includes("redirected off-site") ||
    (r.includes("redirect") && r.includes("could not be followed"))
  ) {
    return "redirect";
  }

  // The #792 blocked copy, the #1829 rate-limit copy and the crawler's own
  // refusal messages: a refusal is a 4xx whether or not a status survived into
  // the sentence. Ahead of the plain status match so a refusal is never read as
  // an ordinary client error.
  if (
    r.includes("blocked the crawler") ||
    r.includes("bot protection") ||
    r.includes("request blocked by server") ||
    r.includes("too many requests") ||
    /rate[\s-]?limit/.test(r) ||
    /\bwaf\b/.test(r) ||
    r.includes("captcha") ||
    /\b429\b/.test(r) ||
    statusIn(r, 401, 401) ||
    statusIn(r, 403, 403)
  ) {
    return "http_4xx";
  }

  if (statusIn(r, 400, 499)) return "http_4xx";
  if (statusIn(r, 500, 599)) return "http_5xx";

  return "unknown";
}

/**
 * Does the reason name an HTTP status in the given range?
 *
 * One bounded 3-digit match behind a required lead-in, so a bare port, retry
 * count or version number is not read as a status. No adjacent quantifiers, so
 * it cannot backtrack catastrophically.
 *
 * Deliberately NOT matching a bare "HTTP NNN": squirrelscan's own callback
 * failures are worded that way ("Callback 'mark-completed' failed after 3
 * attempts (HTTP 500: ...)"), and reading that as a status blames the audited
 * site for our outage.
 */
function statusIn(reason: string, min: number, max: number): boolean {
  const match = /\b(?:returned|server error:)\s(\d{3})\b/.exec(reason);
  if (!match) return false;
  const status = Number.parseInt(match[1]!, 10);
  return status >= min && status <= max;
}
