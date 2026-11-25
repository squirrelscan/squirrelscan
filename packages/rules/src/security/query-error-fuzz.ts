// security/query-error-fuzz - a query parameter whose malformed value makes the
// site print a PHP, database or framework error page
//
// A loud probing rule: it sends up to MAX_FUZZ_REQUESTS requests beyond the
// crawl, so it runs only when the shared probe budget allows `loud` probes
// (`--probe aggressive`, see probe-budget.ts) and sends nothing otherwise or
// when `ctx.probe` is absent.
//
// What may be probed. A candidate is a URL that already carries a query string
// and one of its parameters, taken from the crawled page URLs and the internal
// links on those pages. All of these hold:
//
//  - Same origin as the audited base URL (scheme, host and port).
//  - Not a state-changing path (`isStateChangingPath`, shared with the GraphQL
//    and open-redirect probes).
//  - At most MAX_FUZZ_PARAMS candidates, deduped on origin, path and parameter
//    name. The robots.txt group is not consulted: loud probes run only on an
//    aggressive audit, which ignores it everywhere else too.
//
// What may be sent. Per candidate URL one unmodified request (the baseline),
// then, per parameter, the same URL with that one value replaced by each token
// of FUZZ_TOKENS in turn. GET only, no cookies, redirects never followed, the
// body read up to FUZZ_BODY_CAP decoded bytes. No other method, no body, no
// token outside the frozen list. A parameter stops at its first finding. The
// whole run is capped at MAX_FUZZ_REQUESTS requests, baselines included, and a
// 429 or bot challenge stops it.
//
// What is reported. An error signature (FUZZ_SIGNATURES) in a probe response
// that the baseline did not show. A clean 400 or 404 carries no signature and
// is never flagged. Findings name the page (origin and path, never the query
// string, which can carry tokens), the parameter and the token that triggered
// it, and never quote the response body.

import {
  PROBE_INCOMPLETE_SKIP_REASON,
  PROBE_LEVEL_TOO_LOW_SKIP_REASON,
} from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";

import type { ProbeBudget } from "../probe-budget";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { hasRequestTool } from "../tools";
import { isStateChangingPath } from "./graphql-probe";
import { isThrottledOrChallenged, readCapped } from "./probe-http";

const CHECK = "query-error-fuzz";
const CLEAN = "query-error-fuzz-clean";
const NOT_CHECKED = "query-error-fuzz-not-checked";
const INCOMPLETE = "query-error-fuzz-incomplete";

/**
 * The only values ever sent, in order: a quote, a double quote, a NUL byte
 * (sent as `%00`), an empty array, a very large number and a negative number.
 * Each is inert text for a server that validates its input. Frozen, and the
 * only source of a probe value: `buildFuzzProbe` takes an index into it, not a
 * string, so the set cannot grow by passing something else.
 */
export const FUZZ_TOKENS: readonly {
  readonly id: string;
  readonly value: string;
}[] = Object.freeze(
  [
    { id: "quote", value: "'" },
    { id: "double-quote", value: '"' },
    { id: "null-byte", value: "\u0000" },
    { id: "empty-array", value: "[]" },
    { id: "large-number", value: "99999999999999999999" },
    { id: "negative-number", value: "-1" },
  ].map((t) => Object.freeze(t))
);

/** Candidate parameters fuzzed per run. */
export const MAX_FUZZ_PARAMS = 8;

/** Hard cap on requests per run, baselines included. */
export const MAX_FUZZ_REQUESTS = 60;

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const FUZZ_TIMEOUT_MS = 10_000;

/** Decoded bytes read from one response. */
export const FUZZ_BODY_CAP = 64 * 1024;

export type FuzzSignatureKind = "php" | "database" | "framework";

interface FuzzSignature {
  id: string;
  kind: FuzzSignatureKind;
  /** Matched against the lower-cased body. Every quantifier is bounded. */
  re: RegExp;
}

/**
 * Error page markers, each specific enough that a page which merely talks
 * about errors does not match. Matched against the lower-cased body.
 */
export const FUZZ_SIGNATURES: readonly FuzzSignature[] = [
  {
    id: "php-fatal-error",
    kind: "php",
    re: /(?:fatal error|parse error|warning|notice|deprecated)<\/b>:\s{1,8}[^<]{0,300}? on line (?:<b>)?\d{1,7}|(?:fatal error|parse error): [^\n<]{0,300}? in \S{1,300} on line \d{1,7}/,
  },
  {
    id: "php-stack-trace",
    kind: "php",
    re: /stack trace:\s{0,8}(?:<br ?\/?>)?\s{0,8}#0 \S{1,300}\.php\(\d{1,7}\)/,
  },
  {
    id: "mysql-syntax",
    kind: "database",
    re: /you have an error in your sql syntax/,
  },
  {
    id: "mysql-function",
    kind: "database",
    re: /mysqli?_(?:fetch|query|num_rows|connect)\w{0,20}\(\)/,
  },
  { id: "pdo-sqlstate", kind: "database", re: /sqlstate\[[0-9a-z]{5}\]/ },
  {
    id: "postgres",
    kind: "database",
    re: /(?:pg_query\(\)|syntax error at or near|psqlexception|unterminated quoted string at or near)/,
  },
  { id: "oracle", kind: "database", re: /\bora-\d{5}\b/ },
  {
    id: "mssql",
    kind: "database",
    re: /unclosed quotation mark after the character string|incorrect syntax near/,
  },
  {
    id: "sqlite",
    kind: "database",
    re: /sqlite3?::\w{1,40}|sqlite_error|unrecognized token: "/,
  },
  {
    id: "python-traceback",
    kind: "framework",
    re: /traceback \(most recent call last\)/,
  },
  {
    id: "django-debug",
    kind: "framework",
    re: /you're seeing this error because you have <code>debug = true/,
  },
  {
    id: "laravel-whoops",
    kind: "framework",
    re: /whoops, looks like something went wrong|illuminate\\[a-z]{1,40}\\[a-z]{1,60}/,
  },
  {
    id: "rails-exception",
    kind: "framework",
    re: /actioncontroller::\w{1,60}|activerecord::\w{1,60}error/,
  },
  {
    id: "aspnet-error",
    kind: "framework",
    re: /server error in '[^']{1,100}' application|system\.web\.httprequestvalidationexception|system\.data\.sqlclient\.sqlexception/,
  },
  {
    id: "java-stack-trace",
    kind: "framework",
    re: /(?:exception|error)[^\n<]{0,200}\n?\s{0,40}at (?:java|javax|org|com|net)\.[\w.$]{1,200}\([\w]{1,80}\.java:\d{1,6}\)/,
  },
  {
    id: "node-stack-trace",
    kind: "framework",
    re: /\n\s{2,8}at [^\n<]{1,200} \((?:\/|[a-z]:\\)[^\n<)]{1,300}\.(?:js|ts|mjs):\d{1,6}:\d{1,6}\)/,
  },
];

export interface FuzzSignatureMatch {
  id: string;
  kind: FuzzSignatureKind;
}

/** The first error signature in a response body, or null. Pure. */
export function findErrorSignature(body: string): FuzzSignatureMatch | null {
  const text = body.slice(0, FUZZ_BODY_CAP).toLowerCase();
  for (const s of FUZZ_SIGNATURES) {
    if (s.re.test(text)) return { id: s.id, kind: s.kind };
  }
  return null;
}

/** Every signature id present in a body, for the baseline comparison. Pure. */
function signatureIds(body: string): Set<string> {
  const text = body.slice(0, FUZZ_BODY_CAP).toLowerCase();
  const out = new Set<string>();
  for (const s of FUZZ_SIGNATURES) if (s.re.test(text)) out.add(s.id);
  return out;
}

export interface FuzzCandidate {
  /** The URL as found, with its original query string. Sent, never reported. */
  url: string;
  /** Origin and path only, for reports. */
  page: string;
  /** The parameter name as it appears in the URL. */
  param: string;
}

export interface FuzzCandidateSelection {
  candidates: FuzzCandidate[];
  skippedStateChanging: number;
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
 * The URL and parameter pairs a run may fuzz, in a stable order: crawled page
 * URLs, then internal links in page order. Pure: sends nothing.
 */
export function selectFuzzCandidates(
  ctx: Pick<RuleContext, "site">
): FuzzCandidateSelection {
  const selection: FuzzCandidateSelection = {
    candidates: [],
    skippedStateChanging: 0,
    skippedCap: 0,
  };
  const baseUrl = ctx.site?.baseUrl;
  if (!baseUrl) return selection;
  const siteOrigin = originOf(baseUrl);
  if (!siteOrigin) return selection;
  const seen = new Set<string>();

  const consider = (rawUrl: string | undefined): void => {
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
    const unsafe = isStateChangingPath(u.pathname);
    for (const param of new Set(u.searchParams.keys())) {
      const key = JSON.stringify([page, param.toLowerCase()]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (unsafe) {
        selection.skippedStateChanging++;
        continue;
      }
      if (selection.candidates.length >= MAX_FUZZ_PARAMS) {
        selection.skippedCap++;
        continue;
      }
      selection.candidates.push({ url: u.href, page, param });
    }
  };

  const pages = ctx.site?.pages ?? [];
  for (const p of pages) {
    consider(p.url);
    if (p.finalUrl && p.finalUrl !== p.url) consider(p.finalUrl);
  }
  for (const p of pages) {
    for (const link of p.parsed?.links ?? []) {
      if (link.isInternal) consider(link.url);
    }
  }
  return selection;
}

// ── sending ─────────────────────────────────────────────────────────

const REQUEST_INIT: RequestInit = Object.freeze({
  method: "GET",
  credentials: "omit",
  redirect: "manual",
  headers: Object.freeze({
    Accept: "text/html,*/*;q=0.8",
    "User-Agent": SQUIRRELSCAN_USER_AGENT,
  }),
}) as RequestInit;

/**
 * The exact URL and init for one probe: the candidate URL with its one
 * parameter set to a token of FUZZ_TOKENS (by index), or unmodified when
 * `tokenIndex` is null (the baseline). Exported so tests pin what is sent.
 */
export function buildFuzzProbe(
  candidate: Pick<FuzzCandidate, "url" | "param">,
  tokenIndex: number | null
): { url: string; init: RequestInit } {
  const u = new URL(candidate.url);
  u.hash = "";
  if (tokenIndex !== null) {
    const token = FUZZ_TOKENS[tokenIndex];
    if (!token) throw new RangeError("unknown fuzz token");
    u.searchParams.set(candidate.param, token.value);
  }
  return { url: u.href, init: { ...REQUEST_INIT } };
}

type SendOutcome =
  | { sent: false; reason: "budget" | "cap" }
  | { sent: true; status: number; body: string; pushback: boolean }
  | { sent: true; error: string };

interface RequestCounter {
  count: number;
}

async function sendFuzz(
  probe: ProbeBudget,
  counter: RequestCounter,
  candidate: Pick<FuzzCandidate, "url" | "param">,
  tokenIndex: number | null
): Promise<SendOutcome> {
  if (counter.count >= MAX_FUZZ_REQUESTS) return { sent: false, reason: "cap" };
  if (!probe.allows("loud")) return { sent: false, reason: "budget" };
  const { url, init } = buildFuzzProbe(candidate, tokenIndex);
  const done = new AbortController();
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(FUZZ_TIMEOUT_MS),
    done.signal,
  ]);
  // Counted before the request leaves, so a request that fails still uses budget.
  counter.count++;
  probe.record();
  try {
    const res = await fetchUndecoded(url, { ...init, signal });
    const { text } = await readCapped(res, FUZZ_BODY_CAP);
    return {
      sent: true,
      status: res.status,
      body: text,
      pushback: isThrottledOrChallenged({
        status: res.status,
        headers: res.headers,
        text,
      }),
    };
  } catch (err) {
    return {
      sent: true,
      error: err instanceof Error ? err.name || err.message : String(err),
    };
  } finally {
    done.abort();
  }
}

// ── rule ────────────────────────────────────────────────────────────

interface FuzzFinding {
  candidate: FuzzCandidate;
  token: (typeof FUZZ_TOKENS)[number];
  status: number;
  signature: FuzzSignatureMatch;
}

export const queryErrorFuzzRule: Rule = {
  meta: {
    id: "security/query-error-fuzz",
    name: "Query Parameter Error Pages",
    description:
      "Changes one query value at a time on same-origin URLs to a short fixed list of harmless tokens (a quote, a double quote, a NUL byte, an empty array, a very large number, a negative number) and flags a parameter whose answer is a PHP, database or framework error page the unmodified request did not show. GET only. Runs only when probing is aggressive.",
    solution:
      "Validate and cast every query value before it reaches a query or a function: use prepared statements, parse numbers and reject what does not fit, and answer malformed input with a plain 400 or 404. Turn off detailed error output in production (display_errors off in PHP, DEBUG off in Django and Laravel, custom error pages in ASP.NET and Spring) and log the details server-side.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 6,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CLEAN, outcome: "clean", clears: [CHECK] },
      { name: NOT_CHECKED, outcome: "skipped" },
      { name: INCOMPLETE, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const level = ctx.probe?.level ?? "passive";
    const probe = ctx.probe;
    if (!probe || level !== "aggressive") {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            skipReason: PROBE_LEVEL_TOO_LOW_SKIP_REASON,
            message: `Query parameter error pages not checked: probing is ${level}, and this rule only probes at aggressive.`,
            value: "not-checked",
            details: { probeLevel: level, requiredLevel: "aggressive" },
          },
        ],
      };
    }
    if (!hasRequestTool()) {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            skipReason: "analyze-offline",
            message:
              "Query parameter error pages not checked: analyze runs offline; run `squirrel audit` to probe",
            value: "not-checked",
          },
        ],
      };
    }

    const selection = selectFuzzCandidates(ctx);
    const details = {
      skippedStateChanging: selection.skippedStateChanging,
      skippedCap: selection.skippedCap,
    };
    if (selection.candidates.length === 0) {
      return {
        checks: [
          {
            name: CLEAN,
            status: "pass",
            message:
              "No same-origin URL with a query parameter could be fuzzed",
            details,
          },
        ],
      };
    }

    const counter: RequestCounter = { count: 0 };
    const baselines = new Map<string, Set<string> | null>();
    const findings: FuzzFinding[] = [];
    let fuzzed = 0;
    let stopped: "budget" | "cap" | "pushback" | null = null;

    outer: for (const candidate of selection.candidates) {
      // One baseline per URL, shared by its parameters.
      if (!baselines.has(candidate.url)) {
        const base = await sendFuzz(probe, counter, candidate, null);
        if (!base.sent) {
          stopped = base.reason;
          break;
        }
        if ("error" in base) {
          baselines.set(candidate.url, null);
        } else if (base.pushback) {
          stopped = "pushback";
          break;
        } else {
          baselines.set(candidate.url, signatureIds(base.body));
        }
      }
      const baseline = baselines.get(candidate.url);
      // No baseline, nothing to compare against.
      if (!baseline) continue;
      fuzzed++;
      for (let i = 0; i < FUZZ_TOKENS.length; i++) {
        const out = await sendFuzz(probe, counter, candidate, i);
        if (!out.sent) {
          stopped = out.reason;
          break outer;
        }
        if ("error" in out) continue;
        if (out.pushback) {
          stopped = "pushback";
          break outer;
        }
        const found = [...signatureIds(out.body)].find(
          (id) => !baseline.has(id)
        );
        if (found) {
          const signature = FUZZ_SIGNATURES.find((s) => s.id === found)!;
          findings.push({
            candidate,
            token: FUZZ_TOKENS[i]!,
            status: out.status,
            signature: { id: signature.id, kind: signature.kind },
          });
          break;
        }
      }
    }

    const checks: CheckResult[] = [];
    const kindLabel: Record<FuzzSignatureKind, string> = {
      php: "a PHP error",
      database: "a database error",
      framework: "a framework error or stack trace",
    };
    for (const f of findings) {
      const { page, param } = f.candidate;
      const { id: tokenId } = f.token;
      const { id: signatureId, kind } = f.signature;
      checks.push({
        name: CHECK,
        status: "warn",
        message: `Error page at ${page}: the ${param} parameter answered ${kindLabel[kind]} (HTTP ${f.status}) when its value was changed to the ${tokenId} token`,
        items: [
          {
            id: `${page}?${param}`,
            label: `${page} (?${param}=): ${signatureId} with the ${tokenId} token`,
            meta: {
              page,
              param,
              token: tokenId,
              signature: signatureId,
              kind,
              status: f.status,
            },
          },
        ],
        details: {
          page,
          param,
          token: tokenId,
          signature: signatureId,
          kind,
          status: f.status,
        },
      });
    }

    const summary = {
      ...details,
      fuzzed,
      requests: counter.count,
      stopped,
    };
    if (findings.length === 0 && (stopped || fuzzed === 0)) {
      checks.push({
        name: INCOMPLETE,
        status: "skipped",
        skipReason: PROBE_INCOMPLETE_SKIP_REASON,
        message:
          stopped === "pushback"
            ? "The site rate limited or challenged the probe, so query parameters were not fully checked"
            : stopped
              ? `The request limit or probe budget stopped the run after ${fuzzed} of ${selection.candidates.length} parameter(s); none of those fuzzed answered an error page, but the rest were not checked`
              : "No baseline request succeeded, so query parameters were not checked",
        details: summary,
      });
    } else if (findings.length === 0) {
      checks.push({
        name: CLEAN,
        status: "pass",
        message: `No fuzzed query parameter answered an error page (${fuzzed} parameter(s), ${counter.count} requests)`,
        details: summary,
      });
    }
    return { checks };
  },
};
