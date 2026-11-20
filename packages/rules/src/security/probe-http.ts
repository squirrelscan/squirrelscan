// Shared plumbing for the rules that probe (GraphQL, unauthenticated API): a
// response body read up to a fixed number of DECODED bytes, so a site cannot
// answer a probe with an endless or compression-bomb body (#722).

import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { decodedBody, fetchUndecoded } from "@squirrelscan/utils/response-body";
import { hasWafChallengeEvidence } from "@squirrelscan/utils/waf-markers";

import type { ProbeBudget } from "../probe-budget";

// The per-chunk cap is the guard; `content-length` is not trusted. A stalled
// body is bounded by the request signal, which also aborts `reader.read()`.
// The cap applies to the DECODED body: `decodedBody` undoes the response's
// Content-Encoding lazily, so a compressed answer is inflated no further than
// the cap (#722). A body that does not decode fails the read and so the probe.
// Shared with security/exposed-files, which needs the raw bytes for its magic
// number signatures.
export async function readCappedBytes(
  res: Response,
  maxBytes: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const body = decodedBody(res);
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Release the reader on a cap, an abort or a read error alike. This does
    // not close the connection: the caller aborts the request for that.
    if (!finished) await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: buf, truncated };
}

export async function readCapped(
  res: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readCappedBytes(res, maxBytes);
  return { text: new TextDecoder().decode(bytes), truncated };
}

// ── throttled or challenged ─────────────────────────────────────────

/** What a pushback check needs from one probe answer. */
export interface ProbeReply {
  status: number;
  /** Response headers, when the caller kept them. */
  headers?: Headers | null;
  /** The (capped) body as text. */
  text: string;
}

// Challenge interstitials by their title: Cloudflare ("Just a moment...",
// "Attention Required!", "Access denied"), DDoS-Guard.
const CHALLENGE_TITLE_RE =
  /<title>\s*(Just a moment\.\.\.|Attention Required! \| Cloudflare|Access denied \| [^<]*Cloudflare|DDoS-Guard)\s*<\/title>/i;
// Markers only a challenge page carries. Not `/cdn-cgi/challenge-platform/`:
// Cloudflare injects that script into ordinary pages too.
const CHALLENGE_BODY_RE = /window\._cf_chl_opt|id="cf-browser-verification"|id="challenge-error-text"/i;

/**
 * True when the site pushed back instead of answering: rate limited (HTTP 429),
 * a bot or WAF challenge (`cf-mitigated: challenge`, or a challenge page by its
 * title or markers, whatever the status), or a 403 that carries WAF or
 * challenge markers (`WAF_CHALLENGE_MARKERS` in @squirrelscan/utils). Such an answer says
 * nothing about the path probed, so it is never read as "not exposed". A 401,
 * or a 403 the app sent itself (JSON or plain, no marker), is a real answer:
 * the endpoint is protected. Shared by security/exposed-files,
 * security/unauthenticated-api and security/json-sensitive-fields.
 */
export function isThrottledOrChallenged(reply: ProbeReply): boolean {
  if (reply.status === 429) return true;
  if (reply.headers?.get("cf-mitigated")?.toLowerCase() === "challenge") return true;
  const head = reply.text.slice(0, 64 * 1024);
  if (CHALLENGE_TITLE_RE.test(head) || CHALLENGE_BODY_RE.test(head)) return true;
  // Markers are read on a 403 only: several ride on every answer from a
  // protected site, so on a 2xx or a 401 they prove nothing.
  return reply.status === 403 && hasWafChallengeEvidence({ headers: reply.headers, body: head });
}

/**
 * True when an answer cannot show whether the endpoint is open: throttled,
 * challenged, or a server error (5xx). A probing rule counts such an endpoint
 * as not checked, never as clean. Every other answer (2xx, 3xx, 401, a plain
 * 403, 404) is verified.
 */
export function isUnverifiedReply(reply: ProbeReply): boolean {
  return reply.status >= 500 || isThrottledOrChallenged(reply);
}

// ── one anonymous GET per endpoint per audit ────────────────────────

/** What one anonymous JSON GET answered, as every probing rule that shares it reads it. */
export interface AnonymousGetResponse {
  status: number;
  contentType: string;
  /** The body as text, at most ANONYMOUS_GET_CAP decoded bytes. */
  body: string;
  /** True when the decoded body was longer than the cap; `body` is then a prefix. */
  truncated: boolean;
  /** Response headers, read for a rate limit or bot challenge (`cf-mitigated`). */
  headers: Headers;
}

export type AnonymousGetOutcome =
  | { sent: false }
  | { sent: true; response: AnonymousGetResponse }
  | { sent: true; error: string };

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const ANONYMOUS_GET_TIMEOUT_MS = 10_000;

/** Decoded-body cap for one anonymous GET. */
export const ANONYMOUS_GET_CAP = 256 * 1024;

/**
 * The normalised endpoint URL both probing rules request and report: query and
 * fragment dropped. The key one audit's shared answer is cached under, and the
 * key the runner dedupes their findings on (squirrelscan#2082). Throws on an
 * unparseable URL, like `new URL`.
 */
export function anonymousGetUrl(endpointUrl: string): string {
  const u = new URL(endpointUrl);
  u.search = "";
  u.hash = "";
  return u.href;
}

/**
 * The exact URL and init for an anonymous GET of an API or auth endpoint:
 * query and fragment dropped, no cookie, no Authorization header, no redirect
 * followed. security/unauthenticated-api and security/auth-endpoint-disclosure
 * send this same request, so one answer serves both (squirrelscan#1886).
 */
export function buildAnonymousGet(endpointUrl: string): { url: string; init: RequestInit } {
  return {
    url: anonymousGetUrl(endpointUrl),
    init: {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      // No Cookie and no Authorization header, ever: the point is what an
      // anonymous caller gets.
      headers: {
        Accept: "application/json, */*;q=0.1",
        "User-Agent": SQUIRRELSCAN_USER_AGENT,
      },
    },
  };
}

// Keyed on the audit's probe budget, so the memo lives exactly as long as one
// audit's probing and two audits never share an answer.
const anonymousGets = new WeakMap<ProbeBudget, Map<string, Promise<AnonymousGetOutcome>>>();

/**
 * Send the anonymous GET for `endpointUrl` once per audit. The first caller
 * spends one quiet probe from the shared budget; every later caller (another
 * rule asking for the same URL) gets the same answer and spends nothing, so the
 * endpoint is requested once however many rules read it (squirrelscan#1886).
 * Sends nothing, and remembers nothing, when the budget refuses.
 */
export function sendAnonymousGet(
  probe: ProbeBudget | undefined,
  endpointUrl: string
): Promise<AnonymousGetOutcome> {
  if (!probe) return Promise.resolve({ sent: false });
  const { url, init } = buildAnonymousGet(endpointUrl);
  let memo = anonymousGets.get(probe);
  const cached = memo?.get(url);
  if (cached) return cached;
  if (!probe.allows("quiet")) return Promise.resolve({ sent: false });
  if (!memo) {
    memo = new Map();
    anonymousGets.set(probe, memo);
  }
  // Counted before the request leaves, so a request that fails still uses budget.
  probe.record();
  const pending = fetchAnonymousGet(url, init, probe.signal());
  memo.set(url, pending);
  return pending;
}

/**
 * The answer another rule already got for `endpointUrl` in this audit, without
 * sending anything. A rule that stopped probing (throttled, challenged, out of
 * budget) still reads these, so it reports what is already known
 * (squirrelscan#1886).
 */
export function peekAnonymousGet(
  probe: ProbeBudget | undefined,
  endpointUrl: string
): Promise<AnonymousGetOutcome> | undefined {
  if (!probe) return undefined;
  return anonymousGets.get(probe)?.get(buildAnonymousGet(endpointUrl).url);
}

async function fetchAnonymousGet(
  url: string,
  init: RequestInit,
  deadline: AbortSignal
): Promise<AnonymousGetOutcome> {
  // Aborted once the read is done, so a capped read does not keep pulling an
  // endless answer off the wire until the timeout (see graphql-probe.ts).
  const done = new AbortController();
  const signal = AbortSignal.any([deadline, AbortSignal.timeout(ANONYMOUS_GET_TIMEOUT_MS), done.signal]);
  try {
    // Never `fetch` itself: Bun inflates a Content-Encoding body in full before
    // any capped read (#722).
    const res = await fetchUndecoded(url, { ...init, signal });
    const { text, truncated } = await readCapped(res, ANONYMOUS_GET_CAP);
    return {
      sent: true,
      response: {
        status: res.status,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        body: text,
        truncated,
        headers: res.headers,
      },
    };
  } catch (err) {
    return { sent: true, error: err instanceof Error ? err.name || err.message : String(err) };
  } finally {
    done.abort();
  }
}
