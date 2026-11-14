// security/open-redirect - a redirect-shaped query parameter that sends the
// visitor to any site it names
//
// A probing rule: it sends requests beyond the crawl, so it runs only when the
// probing intensity allows quiet probes (`ctx.probe`, see probe-budget.ts) and
// sends nothing on a passive run or when `ctx.probe` is absent.
//
// What may be probed. A candidate is a URL and one of its query parameters,
// taken from the crawled page URLs, the internal links on those pages, and the
// discovery pass's GET call sites and form actions (`ctx.endpointSurface`).
// Every one of these must hold, and `selectOpenRedirectCandidates` enforces all
// of them:
//
//  - Same origin as the audited base URL (scheme, host and port), checked here.
//  - A redirect-shaped parameter name: `next`, `url`, `redirect`, `return`,
//    `returnTo`, `returnUrl`, `dest`, `continue` and the like (see
//    REDIRECT_PARAM_NAMES), matched without case, `_` or `-`.
//  - Not a state-changing path (`isStateChangingPath`, shared with the GraphQL
//    probes): `/logout?next=/` is never requested.
//  - Not a discovered call site that declares any method but GET.
//  - Not disallowed by robots.txt, unless the run is aggressive.
//  - At most MAX_OPEN_REDIRECT_CANDIDATES candidates per run, deduped on
//    origin, path and parameter name.
//
// What may be sent. Per candidate, the same URL with that one parameter set to
// a canary on a host that cannot resolve (`.invalid`, RFC 6761), first as an
// absolute URL and, when that is not followed off-site, as a protocol-relative
// one. GET only, no cookies, `redirect: "manual"`: the redirect is never
// followed, only its status and `Location` header are read, and the body is
// not read at all. A finding needs a 3xx whose `Location` resolves to the
// canary host. A redirect that stays on the site, a redirect to any other
// host, or a 200 that echoes the value is not a finding.
//
// Findings name the page (origin and path, never the query string, which can
// carry tokens) and the parameter.

import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { ProbeBudget } from "../probe-budget";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { isStateChangingPath } from "./graphql-probe";

const CHECK = "open-redirect";

/** A host under `.invalid` (RFC 6761): it never resolves, so a followed redirect goes nowhere. */
export const OPEN_REDIRECT_CANARY_HOST = "squirrelscan-redirect-probe.invalid";

/** The values sent, in order. The second is tried only when the first was not followed off-site. */
export const OPEN_REDIRECT_PAYLOADS = [
  { kind: "absolute", value: `https://${OPEN_REDIRECT_CANARY_HOST}/` },
  { kind: "protocol-relative", value: `//${OPEN_REDIRECT_CANARY_HOST}/` },
] as const;

export type OpenRedirectPayloadKind = (typeof OPEN_REDIRECT_PAYLOADS)[number]["kind"];

/** URL and parameter pairs probed per run. Each costs at most two requests. */
export const MAX_OPEN_REDIRECT_CANDIDATES = 10;

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const OPEN_REDIRECT_TIMEOUT_MS = 10_000;

/**
 * Redirect-shaped parameter names, compared lower-cased with `_` and `-`
 * removed, so `returnTo`, `return_to` and `return-to` all match `returnto`.
 */
export const REDIRECT_PARAM_NAMES: ReadonlySet<string> = new Set([
  "next",
  "url",
  "redirect",
  "redirecturl",
  "redirectto",
  "return",
  "returnurl",
  "returnto",
  "returnpath",
  "dest",
  "destination",
  "continue",
  "goto",
  "r",
]);

/** True when a query parameter name is redirect-shaped. */
export function isRedirectParamName(name: string): boolean {
  return REDIRECT_PARAM_NAMES.has(name.toLowerCase().replace(/[_-]/g, ""));
}

export interface OpenRedirectCandidate {
  /** The URL as found: origin, path and its original query string. Sent, never reported. */
  url: string;
  /** Origin and path only, for reports. */
  page: string;
  /** The parameter name as it appears in the URL. */
  param: string;
  /** `page-url`, `link`, or the discovery pass's `discoveredVia`. */
  foundVia: string;
}

export interface OpenRedirectCandidateSelection {
  candidates: OpenRedirectCandidate[];
  /** Redirect-shaped candidates left out because the path or declared method changes state. */
  skippedStateChanging: number;
  /** Candidates left out because robots.txt disallows them (below aggressive). */
  skippedRobots: number;
  /** Candidates past MAX_OPEN_REDIRECT_CANDIDATES. */
  skippedCap: number;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The URL and parameter pairs a run may probe, in a stable order: crawled page
 * URLs, then internal links in page order, then discovered GET endpoints.
 * Pure: sends nothing.
 */
export function selectOpenRedirectCandidates(
  ctx: Pick<RuleContext, "site" | "endpointSurface" | "probe">
): OpenRedirectCandidateSelection {
  const selection: OpenRedirectCandidateSelection = {
    candidates: [],
    skippedStateChanging: 0,
    skippedRobots: 0,
    skippedCap: 0,
  };
  const baseUrl = ctx.site?.baseUrl;
  if (!baseUrl) return selection;
  const siteOrigin = originOf(baseUrl);
  if (!siteOrigin) return selection;

  const aggressive = ctx.probe?.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const seen = new Set<string>();

  const consider = (rawUrl: string | undefined, foundVia: string, method?: string): void => {
    if (!rawUrl || !rawUrl.includes("?")) return;
    let u: URL;
    try {
      u = new URL(rawUrl, baseUrl);
    } catch {
      return;
    }
    if (originOf(u.href) !== siteOrigin) return;
    if (u.username || u.password) return;
    u.hash = "";
    const page = `${u.origin}${u.pathname}`;
    const unsafe =
      isStateChangingPath(u.pathname) || (method !== undefined && method.toUpperCase() !== "GET");
    for (const param of new Set(u.searchParams.keys())) {
      if (!isRedirectParamName(param)) continue;
      const key = `${page}\n${param.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (unsafe) {
        selection.skippedStateChanging++;
        continue;
      }
      if (!aggressive && isRobotsTxtDisallowed(u.href, robotsTxt, "*")) {
        selection.skippedRobots++;
        continue;
      }
      if (selection.candidates.length >= MAX_OPEN_REDIRECT_CANDIDATES) {
        selection.skippedCap++;
        continue;
      }
      selection.candidates.push({ url: u.href, page, param, foundVia });
    }
  };

  const pages = ctx.site?.pages ?? [];
  for (const p of pages) {
    consider(p.url, "page-url");
    if (p.finalUrl && p.finalUrl !== p.url) consider(p.finalUrl, "page-url");
  }
  for (const p of pages) {
    for (const link of p.parsed?.links ?? []) {
      if (link.isInternal) consider(link.url, "link");
    }
  }
  for (const c of ctx.endpointSurface?.candidates ?? []) {
    if (!c.probeEligible || !c.sameOrigin) continue;
    consider(c.url, c.discoveredVia, c.method);
  }
  return selection;
}

// ── sending ─────────────────────────────────────────────────────────

/** The exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildOpenRedirectProbe(
  candidate: Pick<OpenRedirectCandidate, "url" | "param">,
  payload: string
): { url: string; init: RequestInit } {
  const u = new URL(candidate.url);
  u.hash = "";
  u.searchParams.set(candidate.param, payload);
  return {
    url: u.href,
    init: {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: { Accept: "text/html,*/*;q=0.8", "User-Agent": SQUIRRELSCAN_USER_AGENT },
    },
  };
}

export type OpenRedirectVerdict =
  /** A 3xx whose Location resolves to the canary host. */
  | { kind: "open"; status: number }
  /** A 3xx whose Location stays on the audited origin. */
  | { kind: "same-origin"; status: number }
  /** A 3xx to some other host: an allowlisted destination, not the value sent. */
  | { kind: "other-host"; status: number }
  /** Not a redirect, or a 3xx with no usable Location. */
  | { kind: "no-redirect"; status: number };

/** Read one response's status and Location. Pure. */
export function classifyRedirect(
  status: number,
  location: string | null,
  requestUrl: string
): OpenRedirectVerdict {
  if (status < 300 || status > 399 || !location) return { kind: "no-redirect", status };
  let target: URL;
  try {
    // Resolved the way a browser would: `//host` and `/\host` take the request's scheme.
    target = new URL(location.trim(), requestUrl);
  } catch {
    return { kind: "no-redirect", status };
  }
  if (target.hostname.toLowerCase() === OPEN_REDIRECT_CANARY_HOST) return { kind: "open", status };
  if (target.origin === new URL(requestUrl).origin) return { kind: "same-origin", status };
  return { kind: "other-host", status };
}

export type OpenRedirectProbeOutcome =
  | { sent: false }
  | { sent: true; verdict: OpenRedirectVerdict }
  | { sent: true; error: string };

/**
 * Send one probe, if the shared budget allows a quiet probe. Never follows the
 * redirect and never reads the body.
 */
export async function sendOpenRedirectProbe(
  probe: ProbeBudget | undefined,
  candidate: Pick<OpenRedirectCandidate, "url" | "param">,
  payload: string
): Promise<OpenRedirectProbeOutcome> {
  if (!probe || !probe.allows("quiet")) return { sent: false };
  const { url, init } = buildOpenRedirectProbe(candidate, payload);
  // Aborted once the status and headers are in, so the body is never downloaded.
  const done = new AbortController();
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(OPEN_REDIRECT_TIMEOUT_MS),
    done.signal,
  ]);
  // Counted before the request leaves, so a request that fails still uses budget.
  probe.record();
  try {
    const res = await fetchUndecoded(url, { ...init, signal });
    const verdict = classifyRedirect(res.status, res.headers.get("location"), url);
    await res.body?.cancel().catch(() => {});
    return { sent: true, verdict };
  } catch (err) {
    return { sent: true, error: err instanceof Error ? err.name || err.message : String(err) };
  } finally {
    done.abort();
  }
}

// ── rule ────────────────────────────────────────────────────────────

type CandidateVerdict =
  | { kind: "open"; payload: OpenRedirectPayloadKind; status: number }
  | { kind: "closed"; cut: boolean }
  | { kind: "errored"; cut: boolean }
  | { kind: "not-sent" };

async function probeCandidate(
  ctx: RuleContext,
  candidate: OpenRedirectCandidate
): Promise<CandidateVerdict> {
  let sentAny = false;
  let answered = false;
  for (const payload of OPEN_REDIRECT_PAYLOADS) {
    const outcome = await sendOpenRedirectProbe(ctx.probe, candidate, payload.value);
    if (!outcome.sent) {
      if (!sentAny) return { kind: "not-sent" };
      // The budget ran out between the two forms: this parameter was only half checked.
      return answered ? { kind: "closed", cut: true } : { kind: "errored", cut: true };
    }
    sentAny = true;
    if ("error" in outcome) continue;
    answered = true;
    if (outcome.verdict.kind === "open") {
      return { kind: "open", payload: payload.kind, status: outcome.verdict.status };
    }
  }
  return answered ? { kind: "closed", cut: false } : { kind: "errored", cut: false };
}

export const openRedirectRule: Rule = {
  meta: {
    id: "security/open-redirect",
    name: "Open Redirect",
    description:
      "Probes same-origin URLs whose query carries a redirect-shaped parameter (next, url, redirect, returnTo, continue and the like) with an off-site value, and flags a parameter the server redirects to whatever host it names. The redirect is never followed. Runs only when probing is active or aggressive.",
    solution:
      "Never redirect to a URL taken from the request as it is. Accept only a relative path that starts with a single `/` (reject `//`, `/\\` and anything with a scheme), or map a short key to a fixed list of destinations, or check the parsed host against an allowlist of your own hosts. Resolve the value with a URL parser before you check it: string prefix checks such as `startsWith(\"/\")` let `//evil.example` through. Fall back to a safe default page when the value fails the check.",
    category: "security",
    scope: "site",
    severity: "warning",
    weight: 5,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CHECK, outcome: "clean", clears: [CHECK] },
      { name: CHECK, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];

    if (!ctx.probe || ctx.probe.level === "passive") {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probing-passive",
        message:
          "Probing is passive, so no redirect parameter was probed. Run with --probe active to check for open redirects.",
      });
      return { checks };
    }

    const selection = selectOpenRedirectCandidates(ctx);
    const details = {
      skippedStateChanging: selection.skippedStateChanging,
      skippedRobots: selection.skippedRobots,
      skippedCap: selection.skippedCap,
    };
    if (selection.candidates.length === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: "No same-origin URL with a redirect-shaped parameter could be probed",
        details,
      });
      return { checks };
    }

    let probed = 0;
    let errored = 0;
    let budgetStopped = false;
    const open: Array<{ candidate: OpenRedirectCandidate; payload: OpenRedirectPayloadKind; status: number }> =
      [];
    for (const candidate of selection.candidates) {
      const verdict = await probeCandidate(ctx, candidate);
      if (verdict.kind === "not-sent") {
        budgetStopped = true;
        break;
      }
      probed++;
      if (verdict.kind !== "open" && verdict.cut) budgetStopped = true;
      if (verdict.kind === "errored") errored++;
      if (verdict.kind === "open") open.push({ candidate, payload: verdict.payload, status: verdict.status });
    }

    if (probed === 0) {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probe-budget",
        message: "The probe budget ran out before any redirect parameter was probed",
        details,
      });
      return { checks };
    }

    if (errored === probed) {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probe-errors",
        message: `Every open redirect probe failed with a network error or timeout (${probed} parameter(s)), so open redirects were not checked`,
        details: { ...details, probed, errored },
      });
      return { checks };
    }

    for (const { candidate, payload, status } of open) {
      const form = payload === "absolute" ? "an absolute URL" : "a protocol-relative URL (//host)";
      checks.push({
        name: CHECK,
        status: "warn",
        message: `Open redirect at ${candidate.page}: the ${candidate.param} parameter sends visitors to any site it names (a ${status} to an off-site host given as ${form})`,
        items: [
          {
            id: `${candidate.page}?${candidate.param}`,
            label: `${candidate.page} (?${candidate.param}=): ${status} to an off-site host`,
            meta: { page: candidate.page, param: candidate.param, payload, status, foundVia: candidate.foundVia },
          },
        ],
        details: { page: candidate.page, param: candidate.param, payload, status },
      });
    }

    // A run the budget cut short is not a clean result: the parameters it never
    // reached could be open.
    if (open.length === 0 && budgetStopped) {
      checks.push({
        name: CHECK,
        status: "skipped",
        skipReason: "probe-budget",
        message: `The probe budget ran out after ${probed} of ${selection.candidates.length} redirect parameter(s). None of those probed redirected off-site, but the rest were not checked`,
        details: { ...details, probed, errored, budgetStopped },
      });
    } else if (open.length === 0) {
      checks.push({
        name: CHECK,
        status: "pass",
        message: `No redirect parameter sent visitors off-site (${probed} parameter(s) probed)`,
        details: { ...details, probed, errored, budgetStopped },
      });
    }
    return { checks };
  },
};
