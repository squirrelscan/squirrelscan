// Conditional-GET gate in front of a render fetcher (#821, #839).
//
// Signed-in audits default to render-all: every HTML page is browser-rendered
// (2 credits, ~20s). On a re-run the crawler already attaches conditional
// headers (If-None-Match / If-Modified-Since) for stale-but-stored pages, but
// the render fetcher ignores them and re-renders unconditionally — so an
// unchanged page pays the full render cost on every audit.
//
// v1 (#821) did a cheap plain-HTTP probe FIRST when the request carried
// conditional headers, and reused the stored render on a 304. That helps only
// when the origin honors validators. Many WP + Cloudflare origins don't: the
// Last-Modified rolls with serve time (never 304s) and the raw source bytes
// rotate on every fetch — but the ENTIRE diff is one Cloudflare-injected
// challenge-platform <script> (#839). So v2 also fingerprints the NORMALIZED
// source (that injection stripped) and reuses the stored render when the hash
// is unchanged, even when the origin always answers 200.
//
// Behavior, given a request the caller marked as having a stored copy (it
// carries conditional headers, or a `storedSourceHash`):
//   - probe the URL with plain HTTP.
//   - 304 → reuse the stored render (origin honored validators). No render.
//   - confidently non-HTML (2xx/3xx) → return the probe; rendering is pointless.
//   - 2xx/3xx HTML (or ambiguous content-type) → fingerprint the normalized
//     source. Matches the stored hash → reuse the stored render via a
//     synthesized 304 (no render). Otherwise render (WITHOUT the conditional
//     headers, so the render isn't itself answered with a 304) and attach the
//     fresh source hash so the crawler persists it for next time.
//   - error/block status (403 WAF, 5xx) → render; the plain fetch may be walled,
//     and a block/error body is not a trustworthy fingerprint (no hash attached).
//   - probe network error/timeout → fall through to render (never let the probe
//     make things worse).
//
// A request with NO conditional headers AND no stored hash (first visit /
// --refresh / no stored page) can't reuse anything, so it renders — but it ALSO
// fires the plain-HTTP probe CONCURRENTLY with the render purely to fingerprint
// the source and bootstrap `source_hash` for next run. Validator-less origins
// (no ETag/Last-Modified) never trigger the shouldProbe path, so without this
// the hash would stay NULL and every re-run would re-render every page forever
// (#990). The probe adds no latency (render dominates ~20s) and, bounded by a
// short grace, can never fail or stall the render.
//
// The wrapper never re-implements the render fetcher's charge/fallback logic; it
// only decides whether to call it, and preserves the wrapped fetcher's `id` and
// capabilities so downstream concurrency planning (which keys on the
// "cloud-render" id) is unaffected.

import { createHash } from "crypto";

import { normalizeHtmlForFingerprint } from "@squirrelscan/utils/fingerprint";

import type { DocumentFetcher, FetchRequest, FetchResponse } from "./index";

export interface ConditionalRenderFetcherOptions {
  /** Plain-HTTP fetcher — used only for the cheap conditional revalidation probe. */
  http: DocumentFetcher;
  /** Render fetcher (cloud) — the wrapped fetcher that produces the real render. */
  render: DocumentFetcher;
  /** Called with the url each time a probe (304 or matching source hash) lets us reuse the cached render. */
  onReuse?: (url: string) => void;
  /**
   * Override the "does this request carry conditional headers?" test. Default:
   * If-None-Match / If-Modified-Since present (case-insensitive). Exposed for tests.
   */
  hasConditionalHeaders?: (req: FetchRequest) => boolean;
  /**
   * Bounded wait for the bootstrap probe after the render resolves, in ms.
   * Defaults to {@link BOOTSTRAP_PROBE_GRACE_MS}. Exposed for tests.
   */
  bootstrapProbeGraceMs?: number;
}

const CONDITIONAL_HEADER_NAMES = new Set(["if-none-match", "if-modified-since"]);

function requestHasConditionalHeaders(req: FetchRequest): boolean {
  const headers = req.headers;
  if (!headers) return false;
  for (const name of Object.keys(headers)) {
    if (CONDITIONAL_HEADER_NAMES.has(name.toLowerCase())) return true;
  }
  return false;
}

/** A copy of the request with any conditional headers removed (never mutates req). */
function stripConditionalHeaders(req: FetchRequest): FetchRequest {
  if (!req.headers) return req;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (CONDITIONAL_HEADER_NAMES.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return { ...req, headers };
}

// A response we're CONFIDENT is non-HTML: it declares a content-type that isn't
// html/xhtml (case-insensitive). A missing/ambiguous content-type is NOT treated
// as non-HTML — when unsure we render, because a skipped render loses the
// rendered DOM (a wrong report) while an unnecessary render only costs credits.
function isDefinitelyNonHtml(resp: FetchResponse): boolean {
  const ct = (resp.headers["content-type"] ?? resp.headers["Content-Type"] ?? "").toLowerCase();
  if (ct === "") return false;
  return !ct.includes("text/html") && !ct.includes("application/xhtml");
}

// sha256 hex of the normalized source. The normalizer is the SHARED contract
// with the api server (#840) — both sides must hash the same normalized string
// for the fingerprints to agree.
function computeSourceFingerprint(body: string): string {
  return createHash("sha256").update(normalizeHtmlForFingerprint(body)).digest("hex");
}

// Bootstrap probe grace: the probe starts with the render and normally resolves
// long before it (~0.5s vs ~20s), but cap the post-render wait so a hung probe
// can never stall the crawl. The probe's own fetcher timeout tears down the
// dangling request; we just stop waiting.
const BOOTSTRAP_PROBE_GRACE_MS = 2000;

// Resolve `p`, or null if it doesn't settle within `ms` (never rejects — the
// caller's promise already swallows probe failures). Clears its timer so a
// resolved probe leaves nothing pending.
function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, grace]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Turn a 2xx probe into a 304 so the crawler's existing 304 path reuses the
// stored render. The crawler's 304 branch only reads `status`, but we blank the
// body to mirror a real Not-Modified response.
function synthesizeNotModified(probe: FetchResponse): FetchResponse {
  return { ...probe, status: 304, body: "" };
}

export function createConditionalRenderDocumentFetcher(
  opts: ConditionalRenderFetcherOptions,
): DocumentFetcher {
  const carriesConditional = opts.hasConditionalHeaders ?? requestHasConditionalHeaders;
  const bootstrapProbeGraceMs = opts.bootstrapProbeGraceMs ?? BOOTSTRAP_PROBE_GRACE_MS;

  return {
    // Preserve the wrapped render fetcher's identity — downstream concurrency
    // planning keys on the "cloud-render" id, and the render path still dominates.
    id: opts.render.id,
    capabilities: opts.render.capabilities,
    async fetch(req: FetchRequest): Promise<FetchResponse> {
      // Probe whenever the caller says a stored copy exists: it carries
      // conditional headers, or it supplied the stored source hash. No stored
      // copy (first visit / --refresh) → render directly, exactly as before.
      const shouldProbe = carriesConditional(req) || req.storedSourceHash != null;
      if (!shouldProbe) {
        // No stored copy to revalidate against — render, but fingerprint the
        // source in parallel to bootstrap `source_hash` for next run (#990).
        // No conditional headers exist in this branch, so req is passed as-is.
        // The probe can never fail or delay the render: its rejection is
        // swallowed, and we await the render (which dominates and unwinds on
        // abort) BEFORE giving the already-in-flight probe a bounded grace.
        const probePromise = opts.http.fetch(req).catch(() => null);
        const rendered = await opts.render.fetch(req);
        const probe = await settleWithin(probePromise, bootstrapProbeGraceMs);
        if (probe && probe.status >= 200 && probe.status < 300 && !isDefinitelyNonHtml(probe)) {
          return { ...rendered, sourceHash: computeSourceFingerprint(probe.body) };
        }
        return rendered;
      }

      // Cheap plain-HTTP revalidation probe.
      let probe: FetchResponse;
      try {
        probe = await opts.http.fetch(req);
      } catch (err) {
        // Cancellation must unwind promptly (release the host slot); any other
        // probe failure must not make things worse — render instead.
        if (req.signal?.aborted) throw err;
        return opts.render.fetch(stripConditionalHeaders(req));
      }

      // 304 → origin honored validators; the crawler reuses the stored render.
      if (probe.status === 304) {
        opts.onReuse?.(req.url);
        return probe;
      }

      // Confidently non-HTML (2xx/3xx) → rendering is pointless; keep the probe.
      if (probe.status < 400 && isDefinitelyNonHtml(probe)) {
        return probe;
      }

      // 2xx HTML (or ambiguous content) → fingerprint the normalized source.
      // Unchanged since last run → reuse the stored render; otherwise render and
      // carry the fresh hash back for persistence. Restricted to 2xx: only a
      // success body is a trustworthy fingerprint of the page's real content — a
      // 3xx stub body could collide across a changed Location and cause a false
      // reuse.
      if (probe.status >= 200 && probe.status < 300) {
        const sourceHash = computeSourceFingerprint(probe.body);
        if (req.storedSourceHash && sourceHash === req.storedSourceHash) {
          opts.onReuse?.(req.url);
          return synthesizeNotModified(probe);
        }
        const rendered = await opts.render.fetch(stripConditionalHeaders(req));
        return { ...rendered, sourceHash };
      }

      // A 3xx with HTML/ambiguous content-type, or an error/block status (403
      // WAF, 5xx) where the plain fetch may be walled → render a fresh copy. Drop
      // the conditional headers so the render isn't answered with a 304, and
      // don't attach a hash from an untrustworthy (redirect/block/error) body.
      return opts.render.fetch(stripConditionalHeaders(req));
    },
  };
}
