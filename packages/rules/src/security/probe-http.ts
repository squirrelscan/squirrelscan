// Shared plumbing for the rules that probe (GraphQL, unauthenticated API): a
// response body read up to a fixed number of DECODED bytes, so a site cannot
// answer a probe with an endless or compression-bomb body (#722).

import { decodedBody } from "@squirrelscan/utils/response-body";
import { hasWafChallengeEvidence } from "@squirrelscan/utils/waf-markers";

// The per-chunk cap is the guard; `content-length` is not trusted. A stalled
// body is bounded by the request signal, which also aborts `reader.read()`.
// The cap applies to the DECODED body: `decodedBody` undoes the response's
// Content-Encoding lazily, so a compressed answer is inflated no further than
// the cap (#722). A body that does not decode fails the read and so the probe.
// Shared with security/exposed-files, which needs the raw bytes for its magic
// number signatures.
export async function readCappedBytes(
  res: Response,
  maxBytes: number,
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
  maxBytes: number,
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
const CHALLENGE_BODY_RE =
  /window\._cf_chl_opt|id="cf-browser-verification"|id="challenge-error-text"/i;

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
