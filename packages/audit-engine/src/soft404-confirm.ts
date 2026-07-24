// soft404-confirm (#1177) — a bounded, end-of-crawl confirmation re-fetch over
// pages the crawl flagged as soft-404s.
//
// crawl/soft-404 makes a confident per-page claim from ONE fetch. But some sites
// intermittently serve a framework error shell (HTTP 200 + noindex) for real,
// existing pages (transient ISR/CDN revalidation). The owner then opens the URL,
// sees real content, and reads our warn as a false positive — trust damage even
// though the crawl genuinely received a 404 shell. So before warning we re-fetch
// each flagged page ONCE and re-run detection:
//   - shell reproduces      → `confirmed`    (real soft-404, warn as normal)
//   - real content served   → `intermittent` (nondeterministic 404-shell serving)
//   - re-fetch not possible  → `unconfirmed`  (offline / error / non-2xx / budget)
//
// The re-fetch is request-equivalent to a PLAIN-FETCH crawl: it uses the RESOLVED
// effective UA the crawl used plus the crawler's browser-like headers, so a
// header/UA-varying origin (WAF) can't diverge between crawl and confirmation. It
// is NOT equivalent to a JS-rendered crawl (a browser render sends its own
// headers and runs JS); rendered candidates are skipped entirely (below) rather
// than compared against a plain fetch. A confirmation that comes back as a WAF/bot
// -challenge is treated as `unconfirmed`, never `intermittent` — a challenge page
// is not "real content".
//
// It runs in the rules phase of the audit (shared by the CLI + cloud adapters,
// like ./cloaking-probe), NOT in the crawl loop, and is wired into
// `runRulesOnStorage` in ONE place so the CLI/cloud paths can't drift. Bounded to
// the flagged candidates only (never all pages) so it can't multiply crawl cost,
// and polite: same-host confirms are sequential and honor the crawl's per-host
// delay, with an overall wall-clock budget; ON by default, opt out via
// `[integrity.soft404_confirm]` on rate-limited hosts.

import { applyBrowserHeaders } from "@squirrelscan/crawler";
import { detectSoft404, parsePage, type Soft404Confirmation } from "@squirrelscan/parser";
import { detectWafChallengePage } from "@squirrelscan/waf-detect";

import { DEFAULT_MAX_BODY_BYTES, readBodyCapped } from "./lib/capped-body-read";

import type { ParsedPage } from "@squirrelscan/rules";

// Confirmation body is truncated to this length before we retain/parse it, so a
// huge page can't blow up the reparse. The read itself is streamed and stops at
// this cap (see ./lib/capped-body-read), shared with the cloaking probe (#1201).
const MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;

/** Default cap on confirmation fetches; extra candidates degrade to `unconfirmed`. */
export const DEFAULT_MAX_CONFIRMATIONS = 25;

/** Response headers the WAF/challenge detector reads (see @squirrelscan/waf-detect). */
export interface ConfirmResponseHeaders {
  server?: string | null;
  cfCacheStatus?: string | null;
  xCache?: string | null;
}

/** A single confirmation fetch outcome. status 0 = network error (inconclusive). */
export interface ConfirmResponse {
  status: number;
  body: string;
  headers?: ConfirmResponseHeaders;
  error?: string;
}

export type ConfirmFetch = (
  url: string,
  userAgent: string,
  headers?: Record<string, string>,
) => Promise<ConfirmResponse>;

/** A crawled page the confirm pass may re-fetch; `parsed` is mutated in place. */
export interface Soft404ConfirmPage {
  url: string;
  statusCode: number;
  parsed: ParsedPage;
  /**
   * True when the crawl content came from a JS render (cloud renderMode "all").
   * A plain confirmation re-fetch of such a page returns the pre-render HTML —
   * near-zero words — which would falsely trip detectSoft404's tiny-content
   * signal. So rendered candidates are NOT re-fetched (see below).
   */
  rendered?: boolean;
}

/** Default overall wall-clock budget for the whole pass; exhausted → unconfirmed. */
export const DEFAULT_WALL_BUDGET_MS = 60_000;

export interface Soft404ConfirmOptions {
  /**
   * Master switch. Default true. When false the pass does NO network — every
   * candidate is annotated `unconfirmed` (never dropped). For rate-limited /
   * staging hosts where the extra re-fetches are unwelcome.
   */
  enabled?: boolean;
  /** Hard cap on confirmation fetches. Default `DEFAULT_MAX_CONFIRMATIONS`. */
  maxConfirmations?: number;
  /**
   * UA used for the confirmation fetch. MUST be the RESOLVED effective UA the
   * crawl used (sticky/random UA), not the raw config value — otherwise a
   * UA-varying origin (WAF) can serve a different response on confirmation and
   * make a real soft-404 look "intermittent".
   */
  userAgent: string;
  /** Custom request headers forwarded to every fetch (same as the crawl). */
  customHeaders?: Record<string, string>;
  /** Per-fetch timeout. Default 15s. */
  timeoutMs?: number;
  /** Concurrent confirmation fetches ACROSS hosts. Default 3. */
  concurrency?: number;
  /**
   * Delay between consecutive same-host confirmation fetches (crawl politeness).
   * Same-host confirms are sequential and honor this; cross-host runs in
   * parallel up to `concurrency`. Default 0.
   */
  perHostDelayMs?: number;
  /** Overall wall-clock budget for the pass; exhausted → remaining unconfirmed. */
  wallBudgetMs?: number;
  /** Injectable clock (ms epoch) for deterministic budget tests. Default Date.now. */
  now?: () => number;
  /** Injectable delay for deterministic politeness tests. Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Roll-up of the pass, for the audit trace. */
export interface Soft404ConfirmSummary {
  candidates: number;
  confirmed: number;
  intermittent: number;
  unconfirmed: number;
  /** Candidates skipped (not re-fetched) because their crawl content was rendered. */
  renderedSkipped: number;
}

/** Same fields the runner feeds `detectSoft404`, so candidacy matches crawl-time. */
function detectionInput(statusCode: number, parsed: ParsedPage) {
  return {
    statusCode,
    document: parsed.document,
    title: parsed.meta?.title,
    h1Texts: parsed.h1?.texts,
    robotsMeta: parsed.meta?.robots,
    wordCount: parsed.content?.wordCount,
  };
}

function defaultConfirmFetch(timeoutMs: number): ConfirmFetch {
  return async (url, userAgent, headers) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Build the SAME browser-like request the crawl sent (UA + sec-fetch/sec-ch
      // headers) so a header/UA-varying origin can't diverge between crawl and
      // confirmation. Custom headers set first win, matching the crawler.
      const reqHeaders = new Headers(headers);
      applyBrowserHeaders(reqHeaders, userAgent);
      const res = await fetch(url, {
        headers: reqHeaders,
        redirect: "follow",
        signal: controller.signal,
      });
      let body = "";
      try {
        body = await readBodyCapped(res, MAX_BODY_BYTES);
      } catch {
        /* body read failed — keep status, treat as empty body */
      }
      return {
        status: res.status,
        body,
        headers: {
          server: res.headers.get("server"),
          cfCacheStatus: res.headers.get("cf-cache-status"),
          xCache: res.headers.get("x-cache"),
        },
      };
    } catch (e) {
      return { status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Re-fetch one candidate and decide its verdict. */
async function confirmOne(
  candidate: Soft404ConfirmPage,
  opts: Soft404ConfirmOptions,
  fetchImpl: ConfirmFetch,
): Promise<Soft404Confirmation> {
  const res = await fetchImpl(candidate.url, opts.userAgent, opts.customHeaders);
  // Only a fresh 2xx lets us re-judge the "serves 404 content with HTTP 200"
  // claim. A network error (status 0) or any non-2xx re-fetch can't confirm or
  // refute it → unconfirmed (annotate, never drop).
  if (res.status < 200 || res.status >= 300) return "unconfirmed";

  // A WAF/bot-challenge served on re-fetch (e.g. a 200 interstitial to an
  // unexpected UA) is NOT real content — never call that "intermittent". Treat
  // it as unconfirmed so we don't overclaim nondeterministic serving.
  const wafChallenge = detectWafChallengePage({
    status: res.status,
    headers: res.headers ?? {},
    html: res.body,
  });
  if (wafChallenge.detected) return "unconfirmed";

  const reparsed = parsePage(res.body, candidate.url);
  const detection = detectSoft404(detectionInput(res.status, reparsed));
  return detection.isSoft404 ? "confirmed" : "intermittent";
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Confirm the crawl's soft-404 candidates in place: re-derive candidacy with
 * `detectSoft404` (same inputs as the runner), re-fetch up to `maxConfirmations`
 * of them once, and write the verdict onto each candidate's
 * `parsed.soft404Confirmation`. Candidates beyond the budget — and any whose
 * re-fetch was inconclusive — are marked `unconfirmed`, never dropped. Bounded to
 * flagged candidates only, so it never multiplies crawl cost. Best-effort:
 * per-fetch failures degrade to `unconfirmed` rather than throwing.
 */
export async function confirmSoft404Candidates(
  pages: Soft404ConfirmPage[],
  opts: Soft404ConfirmOptions,
  fetchImpl: ConfirmFetch = defaultConfirmFetch(opts.timeoutMs ?? 15_000),
): Promise<Soft404ConfirmSummary> {
  const summary: Soft404ConfirmSummary = {
    candidates: 0,
    confirmed: 0,
    intermittent: 0,
    unconfirmed: 0,
    renderedSkipped: 0,
  };

  const record = (c: Soft404ConfirmPage, verdict: Soft404Confirmation) => {
    c.parsed.soft404Confirmation = verdict;
    if (verdict === "unconfirmed-rendered") summary.renderedSkipped++;
    else summary[verdict]++;
  };

  const candidates = pages.filter(
    (p) => detectSoft404(detectionInput(p.statusCode, p.parsed)).isSoft404,
  );
  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;

  // Disabled: annotate every candidate unconfirmed, do NO network (rate-limited /
  // staging hosts). The rule still warns — the finding is never dropped.
  if (opts.enabled === false) {
    for (const c of candidates) record(c, "unconfirmed");
    return summary;
  }

  // Rendered candidates: a plain re-fetch would return pre-render HTML and falsely
  // trip tiny-content, so never fetch them — the exact pipeline-drift FP this pass
  // exists to prevent. Annotate render-unverified (still warns, never dropped); do
  // NOT re-render here.
  const fetchable: Soft404ConfirmPage[] = [];
  for (const c of candidates) {
    if (c.rendered) record(c, "unconfirmed-rendered");
    else fetchable.push(c);
  }
  if (fetchable.length === 0) return summary;

  const cap = Math.max(0, opts.maxConfirmations ?? DEFAULT_MAX_CONFIRMATIONS);
  const toFetch = fetchable.slice(0, cap);
  // Over-cap candidates: warn, annotated unconfirmed (never silently dropped).
  for (const c of fetchable.slice(cap)) record(c, "unconfirmed");

  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const perHostDelayMs = Math.max(0, opts.perHostDelayMs ?? 0);
  const wallBudgetMs = Math.max(0, opts.wallBudgetMs ?? DEFAULT_WALL_BUDGET_MS);
  const start = now();

  // Group by host so same-host confirms stay sequential (crawl politeness);
  // different hosts can run in parallel up to `concurrency`.
  const byHost = new Map<string, Soft404ConfirmPage[]>();
  for (const c of toFetch) {
    const host = hostOf(c.url);
    const group = byHost.get(host);
    if (group) group.push(c);
    else byHost.set(host, [c]);
  }

  await mapPool([...byHost.values()], opts.concurrency ?? 3, async (group) => {
    for (let i = 0; i < group.length; i++) {
      const c = group[i]!;
      // Wall-budget exhausted → don't fetch; annotate unconfirmed (never dropped).
      if (now() - start >= wallBudgetMs) {
        record(c, "unconfirmed");
        continue;
      }
      // Honor the crawl's per-host delay between consecutive same-host requests.
      if (i > 0 && perHostDelayMs > 0) await sleep(perHostDelayMs);
      const verdict = await confirmOne(c, opts, fetchImpl).catch(
        (): Soft404Confirmation => "unconfirmed",
      );
      record(c, verdict);
    }
  });

  return summary;
}

/** Hostname of a URL, or "" when unparseable (grouped together — still bounded). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
