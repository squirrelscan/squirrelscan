// security/http-methods - dangerous HTTP methods advertised through OPTIONS
//
// A probing rule: it runs only when the probing intensity allows quiet probes
// (`ctx.probe.allows("quiet")`, see probe-budget.ts) and sends nothing on a
// passive run or with no probe budget.
//
// What may be sent:
//  - OPTIONS, to at most MAX_OPTIONS_PATHS paths of the audited origin: the
//    root and up to two crawled pages from different top-level sections. A
//    path that names a state-changing action or that robots.txt disallows is
//    never chosen. OPTIONS asks what the server allows; it changes nothing.
//  - One TRACE, only when an OPTIONS answer advertised TRACE. TRACE asks the
//    server to echo the request back, so it changes nothing either. The
//    request carries a random marker header and no credentials.
//  - Never PUT, DELETE, PATCH, CONNECT or any other method. They are read from
//    the Allow header, never tried.
//
// Reflection is confirmed when the TRACE answer is 2xx and either echoes the
// marker in a response header or is typed `message/http`. Bun's fetch hands
// back an empty body for TRACE, so the body is never evidence.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { ProbeBudget } from "../probe-budget";
import type {
  CheckItem,
  CheckResult,
  Rule,
  RuleContext,
  RuleResult,
} from "../types";

import { isStateChangingPath } from "./graphql-probe";
import { isUnverifiedReply, readCapped } from "./probe-http";

/** OPTIONS requests per run: the root plus a few pages. */
export const MAX_OPTIONS_PATHS = 3;
/** TRACE requests per run. */
export const MAX_TRACE_REQUESTS = 1;
export const HTTP_METHODS_TIMEOUT_MS = 10_000;
const MAX_TRACE_BODY_BYTES = 8 * 1024;
const MAX_ALLOW_VALUE_LENGTH = 1024;

/** Methods flagged when advertised. TRACE and TRACK are the cross-site tracing pair. */
export const DANGEROUS_METHODS = [
  "TRACE",
  "TRACK",
  "PUT",
  "DELETE",
  "PATCH",
  "CONNECT",
] as const;
export type DangerousMethod = (typeof DANGEROUS_METHODS)[number];

const CHECK_DANGEROUS = "http-methods-dangerous";
const CHECK_TRACE = "http-methods-trace";
const CHECK_CLEAN = "http-methods";
const CHECK_NOT_CHECKED = "http-methods-not-checked";

/** The dangerous methods named by an Allow header value, in DANGEROUS_METHODS order. */
export function parseAllow(value: string | null): DangerousMethod[] {
  if (!value) return [];
  const tokens = new Set(
    value
      .slice(0, MAX_ALLOW_VALUE_LENGTH)
      .split(",")
      .map((t) => t.trim().toUpperCase())
  );
  return DANGEROUS_METHODS.filter((m) => tokens.has(m));
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The root, then up to two crawled pages of other top-level sections. Same origin only. */
export function selectOptionsUrls(ctx: Pick<RuleContext, "site">): string[] {
  const baseUrl = ctx.site?.baseUrl;
  const origin = baseUrl ? originOf(baseUrl) : null;
  if (!baseUrl || !origin) return [];
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const urls = [`${origin}/`];
  const sections = new Set<string>(["/"]);
  for (const page of ctx.site?.pages ?? []) {
    if (urls.length >= MAX_OPTIONS_PATHS) break;
    if (page.redirectSource || page.statusCode < 200 || page.statusCode >= 300)
      continue;
    let u: URL;
    try {
      u = new URL(page.finalUrl ?? page.url);
    } catch {
      continue;
    }
    if (u.origin !== origin || u.pathname === "/") continue;
    if (isStateChangingPath(u.pathname)) continue;
    const section = `/${u.pathname.split("/")[1] ?? ""}`;
    if (sections.has(section)) continue;
    const target = `${origin}${u.pathname}`;
    if (isRobotsTxtDisallowed(target, robotsTxt, "*")) continue;
    sections.add(section);
    urls.push(target);
  }
  return urls;
}

interface OptionsOutcome {
  url: string;
  /** The request failed, or the answer cannot show what is allowed (redirected, throttled, challenged, 5xx). */
  unverified: boolean;
  methods: DangerousMethod[];
}

async function sendRequest(
  probe: ProbeBudget,
  url: string,
  init: RequestInit
): Promise<Response> {
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(HTTP_METHODS_TIMEOUT_MS),
  ]);
  probe.record();
  return fetchUndecoded(url, {
    ...init,
    credentials: "omit",
    redirect: "manual",
    signal,
  });
}

/** One OPTIONS request. Exported so tests can pin the method sent. */
export async function sendOptions(
  probe: ProbeBudget,
  url: string
): Promise<OptionsOutcome> {
  try {
    const res = await sendRequest(probe, url, {
      method: "OPTIONS",
      headers: { "User-Agent": SQUIRRELSCAN_USER_AGENT },
    });
    const { text } = await readCapped(res, 4 * 1024);
    // A redirect is not followed, so its Allow header (usually absent) says
    // nothing about the path: unknown, never a pass.
    const unverified =
      (res.status >= 300 && res.status < 400) ||
      isUnverifiedReply({ status: res.status, headers: res.headers, text });
    return {
      url,
      unverified,
      methods: unverified ? [] : parseAllow(res.headers.get("allow")),
    };
  } catch {
    return { url, unverified: true, methods: [] };
  }
}

/** One TRACE request. Returns true (reflected), false (not), or null (could not tell). */
export async function sendTrace(
  probe: ProbeBudget,
  url: string,
  marker: string
): Promise<boolean | null> {
  try {
    const res = await sendRequest(probe, url, {
      method: "TRACE",
      headers: {
        "User-Agent": SQUIRRELSCAN_USER_AGENT,
        "X-Squirrelscan-Trace": marker,
      },
    });
    const { text } = await readCapped(res, MAX_TRACE_BODY_BYTES);
    if (isUnverifiedReply({ status: res.status, headers: res.headers, text }))
      return null;
    if (res.status < 200 || res.status >= 300) return false;
    for (const [, v] of res.headers) if (v.includes(marker)) return true;
    return (res.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("message/http");
  } catch {
    return null;
  }
}

function item(url: string, methods: DangerousMethod[]): CheckItem {
  return {
    id: url,
    label: `${url}: Allow advertises ${methods.join(", ")}`,
    meta: { methods },
  };
}

export const httpMethodsRule: Rule = {
  meta: {
    id: "security/http-methods",
    name: "Dangerous HTTP methods",
    description:
      "Sends OPTIONS to the site root and up to two crawled pages and flags TRACE, TRACK, PUT, DELETE, PATCH or CONNECT in the Allow header. When TRACE is advertised it sends one TRACE with a marker header to confirm the server reflects the request. Never sends PUT, DELETE, PATCH or CONNECT. Runs only when probing is active or aggressive.",
    solution:
      "Disable the methods the website does not use. Turn TRACE and TRACK off at the web server (nginx and Caddy refuse them by default; Apache: `TraceEnable off`; IIS: request filtering verbs). Allow PUT, DELETE and PATCH only on the API routes that need them, behind authentication, and reject CONNECT on origin servers. Limit methods per route, or at the reverse proxy or WAF.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 5,
    checks: [
      { name: CHECK_TRACE, outcome: "problem" },
      { name: CHECK_DANGEROUS, outcome: "problem" },
      {
        name: CHECK_CLEAN,
        outcome: "clean",
        clears: [CHECK_TRACE, CHECK_DANGEROUS],
      },
      { name: CHECK_NOT_CHECKED, outcome: "skipped" },
    ],
  },

  // Answers synchronously when nothing may be probed, so a passive run costs no await.
  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    return passiveResult(ctx) ?? runHttpMethods(ctx);
  },
};

function passiveResult(ctx: RuleContext): RuleResult | null {
  if (ctx.probe && ctx.probe.level !== "passive") return null;
  return {
    checks: [
      {
        name: CHECK_NOT_CHECKED,
        status: "skipped",
        skipReason: "probing-passive",
        message:
          "Probing is passive, so no OPTIONS request was sent. Run with --probe active to check for dangerous HTTP methods.",
      },
    ],
  };
}

export async function runHttpMethods(ctx: RuleContext): Promise<RuleResult> {
  const skipped = passiveResult(ctx);
  if (skipped) return skipped;
  const probe = ctx.probe!;

  const urls = selectOptionsUrls(ctx);
  const outcomes: OptionsOutcome[] = [];
  let budgetStopped = false;
  for (const url of urls) {
    if (!probe.allows("quiet")) {
      budgetStopped = true;
      break;
    }
    outcomes.push(await sendOptions(probe, url));
  }

  const checks: CheckResult[] = [];
  const answered = outcomes.filter((o) => !o.unverified);
  const flagged = answered.filter((o) => o.methods.length > 0);
  const traceAt = flagged.find((o) => o.methods.includes("TRACE"));

  let reflected: boolean | null = null;
  let traceAsked = false;
  if (traceAt && MAX_TRACE_REQUESTS > 0 && probe.allows("quiet")) {
    traceAsked = true;
    const marker = `sq${crypto.randomUUID().replaceAll("-", "")}`;
    reflected = await sendTrace(probe, traceAt.url, marker);
  }

  if (reflected === true && traceAt) {
    checks.push({
      name: CHECK_TRACE,
      status: "fail",
      message: `${traceAt.url} answers TRACE and reflects the request, which enables cross-site tracing`,
      items: [item(traceAt.url, traceAt.methods)],
      details: { severity: "error", traceReflected: true },
    });
  }
  const others = flagged
    .map((o) => ({
      ...o,
      methods:
        reflected === true ? o.methods.filter((m) => m !== "TRACE") : o.methods,
    }))
    .filter((o) => o.methods.length > 0);
  if (others.length > 0) {
    const all = [...new Set(others.flatMap((o) => o.methods))];
    checks.push({
      name: CHECK_DANGEROUS,
      status: "warn",
      message: `${others.length} path(s) advertise ${all.join(", ")} in the Allow header${
        traceAsked && reflected === false
          ? " (TRACE did not reflect the request)"
          : ""
      }`,
      items: others.map((o) => item(o.url, o.methods)),
      details: { methods: all, traceReflected: reflected },
    });
  }

  const incomplete =
    budgetStopped ||
    outcomes.length === 0 ||
    outcomes.some((o) => o.unverified);
  if (incomplete && flagged.length === 0) {
    const allFailed = outcomes.length > 0 && answered.length === 0;
    checks.push({
      name: CHECK_NOT_CHECKED,
      status: "skipped",
      skipReason: budgetStopped
        ? outcomes.length === 0
          ? "probe-budget"
          : PROBE_INCOMPLETE_SKIP_REASON
        : allFailed
          ? "probe-errors"
          : PROBE_INCOMPLETE_SKIP_REASON,
      message: `OPTIONS answered for ${answered.length} of ${urls.length} path(s), so dangerous HTTP methods were not fully checked`,
    });
  } else if (flagged.length === 0) {
    checks.push({
      name: CHECK_CLEAN,
      status: "pass",
      message: `No dangerous HTTP method is advertised (${outcomes.length} OPTIONS request(s))`,
    });
  }
  return { checks };
}
