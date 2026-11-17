// security/exposed-actuator - Spring Boot Actuator endpoints open to anyone
//
// A probing rule: it sends requests beyond the crawl, so it runs only when the
// probing intensity allows it (`ctx.probe`, see probe-budget.ts) and sends
// nothing on a passive run or with no probe budget.
//
// What may be probed. An actuator base path comes from the endpoint discovery
// pass (`ctx.endpointSurface`): a same-origin candidate whose path has an
// `actuator` segment gives the path up to and including that segment, so
// `/mgmt/actuator/health` gives `/mgmt/actuator`. The conventional `/actuator`
// is always considered too. Every one of these must hold, and
// `selectActuatorBases` enforces all of them:
//
//  - Same origin as the audited base URL, checked here again. `probeEligible`
//    only says same-origin; it does not say safe to send.
//  - The candidate's path names no state-changing action (`isStateChangingPath`,
//    shared with the GraphQL probes, plus the actuator's own write operations
//    such as shutdown, restart and refresh), and its call site declares no
//    POST, PUT, PATCH or DELETE (every actuator write is one of those).
//  - At most MAX_ACTUATOR_BASES bases.
//
// What may be sent. Only GET, only to the fixed read-only sub-endpoints in
// ACTUATOR_ENDPOINTS under each base: the index, `env`, `configprops` and
// `mappings` (only the ones an open index lists, when it is open), and
// `heapdump` on an aggressive run only, listed or not (asking for a heap dump
// makes the JVM write one, so it is a loud probe; on an active run a heapdump
// listed by an open index is reported from that listing alone, as a warning,
// because the index also lists endpoints that need a login). The heapdump
// request asks for its first 64 bytes with a Range header and reads at most
// that many, whatever the server sends. The Range header does not stop an open
// JVM writing a full dump, so a run asks for at most one heap dump: no heapdump
// is requested after one is confirmed, or after a heapdump request timed out
// (a large heap can take longer than the timeout to start answering).
// Requests carry no cookies, do not
// follow redirects, are bounded by the shared probe budget, a per-request
// timeout (one timeout ends that base) and the rule's own total time budget,
// and read a capped body that is decoded no further than the cap (#722). Below
// aggressive, a robots.txt-disallowed URL is not requested. A 429 or a bot
// challenge stops the rule.
//
// A pass clears only what the run requested and got a definite answer for.
// There are two verdicts, each with its own problem, clean and not-checked
// check: one for the index, `env`, `configprops` and `mappings`, one for the
// heapdump. A path not answered (robots.txt, budget, time, a base that timed
// out, an error, a 5xx, pushback, a base past the cap) makes its verdict not
// checked, never a pass. The heapdump passes only when an aggressive run got a
// 401, 403 or 404 for it on every base, so an active run, which never asks for
// it, leaves a heap dump an earlier aggressive run found open.
//
// What is reported. An endpoint counts only when its 2xx answer has the shape
// that actuator endpoint has (`_links` naming actuator endpoints,
// `activeProfiles` with `propertySources`, configuration property beans,
// request mappings, the HPROF "JAVA PROFILE" header), never on status alone, so
// a single-page app that answers every path with its 200 shell is not a
// finding. Findings name the endpoint and the kind of evidence only. A response
// body, and any value in it, never leaves this file.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { ProbeBudget, ProbeKind } from "../probe-budget";
import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { isStateChangingPath } from "./graphql-probe";
import { isThrottledOrChallenged, readCappedBytes } from "./probe-http";

/** Base paths one run probes. */
export const MAX_ACTUATOR_BASES = 3;

/**
 * Per-request timeout, on top of the shared probe budget's deadline. The same
 * 10 s as security/exposed-files. A request that times out ends its base: a
 * server that hangs on one unknown path hangs on the rest.
 */
export const ACTUATOR_PROBE_TIMEOUT_MS = 10_000;

/**
 * Wall-clock cap on the whole rule, whatever the shared probe budget allows.
 * security/exposed-files has no cap of its own: its only bound at --probe active
 * is the shared budget's 30 s default (`DEFAULT_PROBE_BUDGET_MS.active` in
 * @squirrelscan/config). This rule takes the same 30 s for itself, which is
 * also one request timeout for each of the MAX_ACTUATOR_BASES bases, so a site
 * that hangs on every path costs at most 30 s. Paths not reached by then are
 * not checked.
 */
export const ACTUATOR_TOTAL_BUDGET_MS = 30_000;

/** The time bounds the rule runs under. Tests pass smaller ones. */
export interface ActuatorTiming {
  requestTimeoutMs: number;
  totalBudgetMs: number;
}

export const DEFAULT_ACTUATOR_TIMING: ActuatorTiming = {
  requestTimeoutMs: ACTUATOR_PROBE_TIMEOUT_MS,
  totalBudgetMs: ACTUATOR_TOTAL_BUDGET_MS,
};

/** The base path probed on every site, besides the ones the discovery pass found. */
export const ACTUATOR_CONVENTION_BASE = "/actuator";

/** The HPROF file header every HotSpot heap dump starts with. */
export const HPROF_MAGIC = "JAVA PROFILE ";

export type ActuatorEndpointId = "index" | "env" | "configprops" | "heapdump" | "mappings";

/** What showed the endpoint is an actuator endpoint. Never the content itself. */
export type ActuatorEvidence =
  | "actuator-index-links"
  | "env-property-sources"
  | "configprops-beans"
  | "request-mappings"
  | "hprof-header"
  | "listed-in-index";

interface ActuatorEndpointSpec {
  id: ActuatorEndpointId;
  /** Appended to the base path. */
  path: string;
  /** `critical` endpoints hand out secrets or memory; the rest map the application. */
  severity: "critical" | "warning";
  /** quiet needs active, loud needs aggressive. */
  kind: ProbeKind;
  /** Decoded response bytes read. A longer body is read only as a prefix. */
  maxBytes: number;
}

/** The only requests this rule sends, in order. Every one is a GET. */
export const ACTUATOR_ENDPOINTS: readonly ActuatorEndpointSpec[] = [
  { id: "index", path: "", severity: "warning", kind: "quiet", maxBytes: 64 * 1024 },
  { id: "env", path: "/env", severity: "critical", kind: "quiet", maxBytes: 1024 * 1024 },
  { id: "configprops", path: "/configprops", severity: "critical", kind: "quiet", maxBytes: 1024 * 1024 },
  { id: "mappings", path: "/mappings", severity: "warning", kind: "quiet", maxBytes: 1024 * 1024 },
  { id: "heapdump", path: "/heapdump", severity: "critical", kind: "loud", maxBytes: 64 },
];

// Actuator endpoint ids. An index must name at least one besides `self`, so a
// HAL resource from another API (Spring Data REST, for one) is not an index.
const KNOWN_ACTUATOR_IDS = new Set([
  "auditevents",
  "beans",
  "caches",
  "conditions",
  "configprops",
  "env",
  "flyway",
  "health",
  "heapdump",
  "httpexchanges",
  "httptrace",
  "info",
  "integrationgraph",
  "jolokia",
  "liquibase",
  "logfile",
  "loggers",
  "mappings",
  "metrics",
  "prometheus",
  "quartz",
  "scheduledtasks",
  "sbom",
  "sessions",
  "shutdown",
  "startup",
  "threaddump",
]);

// The actuator's own write operations. A discovered path naming one is never
// used, even though this rule would only GET the fixed endpoints under its base.
const ACTUATOR_WRITE_WORDS = new Set(["shutdown", "restart", "refresh", "pause", "resume", "busrefresh", "busenv"]);
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ── selection ──────────────────────────────────────────────────────

export interface ActuatorBase {
  /** Origin plus base path, no trailing slash. */
  url: string;
  source: "discovered" | "convention";
  discoveredVia: string;
}

export interface ActuatorBaseSelection {
  bases: ActuatorBase[];
  /** Actuator candidates left out because the path or method changes state. */
  skippedStateChanging: number;
  /** Bases past MAX_ACTUATOR_BASES. */
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

function namesActuatorWrite(pathname: string): boolean {
  return pathname
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => ACTUATOR_WRITE_WORDS.has(w));
}

/** The path up to and including its first `actuator` segment, or null. */
export function actuatorBasePath(pathname: string): string | null {
  const segments = pathname.split("/");
  const i = segments.indexOf("actuator");
  if (i < 0) return null;
  return segments.slice(0, i + 1).join("/");
}

/**
 * The actuator base paths the rule may probe, in a stable order: discovered
 * bases first (in the discovery pass's order), then `/actuator`. Pure: sends
 * nothing.
 */
export function selectActuatorBases(
  ctx: Pick<RuleContext, "site" | "endpointSurface">
): ActuatorBaseSelection {
  const out: ActuatorBase[] = [];
  let skippedStateChanging = 0;
  let skippedCap = 0;
  const baseUrl = ctx.site?.baseUrl;
  const siteOrigin = baseUrl ? originOf(baseUrl) : null;
  if (!baseUrl || !siteOrigin) return { bases: out, skippedStateChanging, skippedCap };
  const seen = new Set<string>();

  const consider = (rawUrl: string, source: ActuatorBase["source"], discoveredVia: string, method?: string) => {
    let u: URL;
    try {
      u = new URL(rawUrl, baseUrl);
    } catch {
      return;
    }
    // Strict same origin, whatever the candidate says about itself.
    if (originOf(u.href) !== siteOrigin) return;
    if (u.username || u.password) return;
    const basePath = actuatorBasePath(u.pathname);
    if (!basePath) return;
    if (
      isStateChangingPath(u.pathname) ||
      namesActuatorWrite(u.pathname) ||
      (method !== undefined && UNSAFE_METHODS.has(method.toUpperCase()))
    ) {
      skippedStateChanging++;
      return;
    }
    const url = `${u.origin}${basePath}`;
    if (seen.has(url)) return;
    seen.add(url);
    if (out.length >= MAX_ACTUATOR_BASES) {
      skippedCap++;
      return;
    }
    out.push({ url, source, discoveredVia });
  };

  for (const c of ctx.endpointSurface?.candidates ?? []) {
    if (!c.probeEligible || !c.sameOrigin) continue;
    consider(c.url, c.source === "convention" ? "convention" : "discovered", c.discoveredVia, c.method);
  }
  consider(ACTUATOR_CONVENTION_BASE, "convention", "convention");
  return { bases: out, skippedStateChanging, skippedCap };
}

// ── sending ────────────────────────────────────────────────────────

export interface ActuatorResponse {
  status: number;
  contentType: string;
  /** At most the endpoint's byte cap. Read here, never reported. */
  bytes: Uint8Array;
  truncated: boolean;
  /** Read for a rate limit or bot challenge (`cf-mitigated`), never reported. */
  headers: Headers;
}

export type ActuatorProbeOutcome =
  | { sent: false }
  | { sent: true; response: ActuatorResponse }
  | { sent: true; error: string };

/** Build the exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildActuatorProbe(baseUrl: string, spec: ActuatorEndpointSpec): { url: string; init: RequestInit } {
  const headers: Record<string, string> =
    spec.id === "heapdump"
      ? { Accept: "application/octet-stream", Range: `bytes=0-${spec.maxBytes - 1}`, "User-Agent": SQUIRRELSCAN_USER_AGENT }
      : {
          Accept: "application/vnd.spring-boot.actuator.v3+json, application/json;q=0.9",
          "User-Agent": SQUIRRELSCAN_USER_AGENT,
        };
  return {
    url: `${baseUrl}${spec.path}`,
    init: { method: "GET", credentials: "omit", redirect: "manual", headers },
  };
}

async function sendActuatorProbe(
  probe: ProbeBudget,
  baseUrl: string,
  spec: ActuatorEndpointSpec,
  timeoutMs: number
): Promise<ActuatorProbeOutcome> {
  if (!probe.allows(spec.kind)) return { sent: false };
  const { url, init } = buildActuatorProbe(baseUrl, spec);
  // Aborted once the read is done, so a capped read does not keep pulling an
  // endless answer (a heap dump that ignores Range) off the wire.
  const done = new AbortController();
  const signal = AbortSignal.any([probe.signal(), AbortSignal.timeout(timeoutMs), done.signal]);
  probe.record();
  try {
    const res = await fetchUndecoded(url, { ...init, signal });
    const { bytes, truncated } = await readCappedBytes(res, spec.maxBytes);
    return {
      sent: true,
      response: {
        status: res.status,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        bytes,
        truncated,
        headers: res.headers,
      },
    };
  } catch (err) {
    return { sent: true, error: err instanceof Error ? err.name || "Error" : "Error" };
  } finally {
    done.abort();
  }
}

// ── reading ────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonOf(response: ActuatorResponse): unknown {
  if (response.truncated || response.contentType.includes("html")) return undefined;
  const text = new TextDecoder().decode(response.bytes).trim();
  if (!text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The endpoint ids an actuator index lists besides `self`, or null when it is not an index. */
export function readActuatorIndex(response: ActuatorResponse): string[] | null {
  const json = jsonOf(response);
  if (!isPlainObject(json) || !isPlainObject(json._links)) return null;
  const links = json._links;
  const self = links.self;
  if (!isPlainObject(self) || typeof self.href !== "string") return null;
  const listed: string[] = [];
  for (const [id, link] of Object.entries(links)) {
    if (id === "self") continue;
    if (!isPlainObject(link) || typeof link.href !== "string") return null;
    // `env-toMatch`, `metrics-requiredMetricName` and similar are templated sub-links.
    const base = id.split("-")[0]!;
    if (KNOWN_ACTUATOR_IDS.has(base) && !listed.includes(base)) listed.push(base);
  }
  return listed.length > 0 ? listed : null;
}

const ENV_PREFIX_RE = /^\s*\{\s*"activeProfiles"\s*:\s*\[/;
const CONTEXTS_PREFIX_RE = (key: string) =>
  new RegExp(`^\\s*\\{\\s*"contexts"\\s*:\\s*\\{\\s*"[^"\\\\]{1,200}"\\s*:\\s*\\{[^]{0,200}?"${key}"\\s*:\\s*\\{`);
const CONFIGPROPS_PREFIX_RE = CONTEXTS_PREFIX_RE("beans");
const MAPPINGS_PREFIX_RE = CONTEXTS_PREFIX_RE("mappings");

function prefixText(response: ActuatorResponse): string | null {
  if (!response.truncated || response.contentType.includes("html")) return null;
  return new TextDecoder().decode(response.bytes);
}

/** `/env`: `activeProfiles` and `propertySources` arrays, the second of named sources. */
export function isEnvResponse(response: ActuatorResponse): boolean {
  const json = jsonOf(response);
  if (isPlainObject(json)) {
    if (!Array.isArray(json.activeProfiles) || !Array.isArray(json.propertySources)) return false;
    return json.propertySources.every((s) => isPlainObject(s) && typeof s.name === "string");
  }
  // Longer than the cap: the prefix must open as an env answer does.
  const text = prefixText(response);
  return text !== null && ENV_PREFIX_RE.test(text) && /"propertySources"\s*:\s*\[/.test(text);
}

function contextsEntries(json: unknown, key: string): Record<string, unknown>[] | null {
  if (!isPlainObject(json) || !isPlainObject(json.contexts)) return null;
  const out: Record<string, unknown>[] = [];
  for (const ctx of Object.values(json.contexts)) {
    if (isPlainObject(ctx) && isPlainObject(ctx[key])) out.push(ctx[key]);
  }
  return out.length > 0 ? out : null;
}

/** `/configprops`: `contexts.<id>.beans` holding beans with a `prefix` and `properties`. */
export function isConfigpropsResponse(response: ActuatorResponse): boolean {
  const json = jsonOf(response);
  if (json !== undefined) {
    const beans = contextsEntries(json, "beans");
    if (!beans) return false;
    return beans.some((b) =>
      Object.values(b).some((bean) => isPlainObject(bean) && typeof bean.prefix === "string" && isPlainObject(bean.properties))
    );
  }
  const text = prefixText(response);
  return (
    text !== null &&
    CONFIGPROPS_PREFIX_RE.test(text) &&
    /"prefix"\s*:\s*"/.test(text) &&
    /"properties"\s*:\s*\{/.test(text)
  );
}

/** `/mappings`: `contexts.<id>.mappings` with dispatcher servlets or handlers. */
export function isMappingsResponse(response: ActuatorResponse): boolean {
  const json = jsonOf(response);
  if (json !== undefined) {
    const mappings = contextsEntries(json, "mappings");
    if (!mappings) return false;
    return mappings.some(
      (m) => isPlainObject(m.dispatcherServlets) || isPlainObject(m.dispatcherHandlers) || Array.isArray(m.servletFilters)
    );
  }
  const text = prefixText(response);
  return text !== null && MAPPINGS_PREFIX_RE.test(text) && /"dispatcher(?:Servlets|Handlers)"\s*:/.test(text);
}

/** `/heapdump`: the body opens with the HPROF header. */
export function isHprofResponse(response: ActuatorResponse): boolean {
  if (response.bytes.byteLength < HPROF_MAGIC.length) return false;
  for (let i = 0; i < HPROF_MAGIC.length; i++) {
    if (response.bytes[i] !== HPROF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

const EVIDENCE: Record<ActuatorEndpointId, { evidence: ActuatorEvidence; confirm: (r: ActuatorResponse) => boolean }> = {
  index: { evidence: "actuator-index-links", confirm: (r) => readActuatorIndex(r) !== null },
  env: { evidence: "env-property-sources", confirm: isEnvResponse },
  configprops: { evidence: "configprops-beans", confirm: isConfigpropsResponse },
  mappings: { evidence: "request-mappings", confirm: isMappingsResponse },
  heapdump: { evidence: "hprof-header", confirm: isHprofResponse },
};

const EVIDENCE_LABEL: Record<ActuatorEvidence, string> = {
  "actuator-index-links": "actuator index listing its endpoints",
  "env-property-sources": "environment property sources",
  "configprops-beans": "configuration property beans",
  "request-mappings": "request mappings",
  "hprof-header": "HPROF heap dump header",
  "listed-in-index": "listed by the open actuator index, not downloaded (it may still require authentication)",
};

// ── the rule ───────────────────────────────────────────────────────

// Two independent verdicts, each with its own problem, clean and not-checked
// check, because a pass clears only what the run requested and got a definite
// answer for. The heapdump is requested on an aggressive run only, so an
// active run's pass for the other endpoints must not clear a heap dump an
// earlier aggressive run found.
const CHECK_CRITICAL = "exposed-actuator-critical";
const CHECK_EXPOSED = "exposed-actuator-endpoints";
const CHECK_CLEAN = "exposed-actuator";
const CHECK_NOT_CHECKED = "exposed-actuator-not-checked";
const CHECK_HEAPDUMP = "exposed-actuator-heapdump";
const CHECK_HEAPDUMP_CLOSED = "exposed-actuator-heapdump-closed";
const CHECK_HEAPDUMP_NOT_CHECKED = "exposed-actuator-heapdump-not-checked";

/** Statuses that are a definite "not open" for a heapdump request. Anything else is not checked. */
const HEAPDUMP_CLOSED_STATUSES = new Set([401, 403, 404]);

interface ExposedEndpoint {
  url: string;
  endpoint: ActuatorEndpointId;
  severity: "critical" | "warning";
  evidence: ActuatorEvidence;
  base: ActuatorBase;
}

/** Why a path the run should have checked was not. */
type UncheckedWhy =
  | "robots"
  | "probe-level"
  | "budget"
  | "time"
  | "timeout"
  | "error"
  | "throttled"
  | "server-error"
  | "no-definite-answer"
  | "heapdump-timeout"
  | "heapdump-already-confirmed"
  | "heapdump-stopped-after-timeout";

interface UncheckedEndpoint {
  url: string;
  endpoint: ActuatorEndpointId;
  why: UncheckedWhy;
}

const WHY_LABEL: Record<UncheckedWhy, string> = {
  robots: "disallowed by robots.txt",
  "probe-level": "requested only with --probe aggressive",
  budget: "the probe budget ran out",
  time: "the rule's time limit ran out",
  timeout: "its base stopped answering (a request timed out)",
  error: "the request failed",
  throttled: "the site rate limited the probes (HTTP 429) or answered with a bot challenge",
  "server-error": "the server answered with an error (5xx)",
  "no-definite-answer": "the answer was neither the endpoint nor a 401, 403 or 404",
  "heapdump-timeout": "the request timed out; an open endpoint may have started writing a dump",
  "heapdump-already-confirmed":
    "not requested: a heap dump was already confirmed under another base, and each request makes the server write one",
  "heapdump-stopped-after-timeout":
    "not requested: an earlier heapdump request timed out, so the run asks for no further heap dump",
};

function item(e: ExposedEndpoint): CheckItem {
  return {
    id: e.url,
    label: `${e.url} (${e.endpoint}): ${EVIDENCE_LABEL[e.evidence]}`,
    meta: {
      endpoint: e.endpoint,
      evidence: e.evidence,
      severity: e.severity,
      ...(e.evidence === "listed-in-index" ? { confidence: "lower" } : {}),
      source: e.base.source,
      discoveredVia: e.base.discoveredVia,
    },
  };
}

export const exposedActuatorRule: Rule = {
  meta: {
    id: "security/exposed-actuator",
    name: "Exposed Spring Boot Actuator",
    description:
      "Probes the site's Spring Boot Actuator paths with read-only GET requests and flags endpoints that answer anyone: env, configprops and heapdump leak secrets and memory (critical), the index and mappings map the application. Runs only when probing is active or aggressive; the heapdump only when aggressive.",
    solution:
      "Expose only `health` (and `info` if you need it) over HTTP: set `management.endpoints.web.exposure.include=health,info` and never use `*` in production. Put the rest behind authentication with Spring Security, or move them to a separate management port that is not reachable from the internet (`management.server.port`). If `env`, `configprops` or `heapdump` was reachable, treat every secret the application holds as leaked and rotate it: database passwords, API keys, signing keys and cloud credentials.",
    category: "security",
    scope: "site",
    severity: "error",
    weight: 9,
    checks: [
      { name: CHECK_CRITICAL, outcome: "problem" },
      { name: CHECK_EXPOSED, outcome: "problem" },
      { name: CHECK_CLEAN, outcome: "clean", clears: [CHECK_CRITICAL, CHECK_EXPOSED] },
      { name: CHECK_NOT_CHECKED, outcome: "skipped" },
      { name: CHECK_HEAPDUMP, outcome: "problem" },
      { name: CHECK_HEAPDUMP_CLOSED, outcome: "clean", clears: [CHECK_HEAPDUMP] },
      { name: CHECK_HEAPDUMP_NOT_CHECKED, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): Promise<RuleResult> {
    return runExposedActuator(ctx);
  },
};

/** The skip reason for a family's not-checked check, from why its paths were not checked. */
function skipReasonFor(whys: Set<UncheckedWhy | "cap">, allErrored: boolean): string {
  if (whys.size === 1 && whys.has("robots")) return "robots-disallowed";
  if (whys.size === 1 && whys.has("probe-level")) return "probe-level-too-low";
  if (whys.size === 1 && whys.has("budget")) return "probe-budget";
  if (allErrored) return "probe-errors";
  return PROBE_INCOMPLETE_SKIP_REASON;
}

function describeUnchecked(unchecked: UncheckedEndpoint[], skippedCap: number): string {
  const parts: string[] = [];
  const byWhy = new Map<UncheckedWhy, string[]>();
  for (const u of unchecked) byWhy.set(u.why, [...(byWhy.get(u.why) ?? []), u.url]);
  for (const [why, urls] of byWhy) parts.push(`${urls.join(", ")} (${WHY_LABEL[why]})`);
  if (skippedCap > 0) parts.push(`${skippedCap} more actuator base path(s) past the cap of ${MAX_ACTUATOR_BASES}`);
  return parts.join("; ");
}

/** The rule's run, with its time bounds as a parameter so tests can shrink them. */
export async function runExposedActuator(
  ctx: RuleContext,
  timing: ActuatorTiming = DEFAULT_ACTUATOR_TIMING
): Promise<RuleResult> {
  const checks: CheckResult[] = [];
  const probe = ctx.probe;

  if (!probe || probe.level === "passive") {
    checks.push({
      name: CHECK_NOT_CHECKED,
      status: "skipped",
      skipReason: "probing-passive",
      message:
        "Probing is passive, so no Spring Boot Actuator path was probed. Run with --probe active to check for exposed actuator endpoints.",
    });
    return { checks };
  }

  const selection = selectActuatorBases(ctx);
  const bases = selection.bases;
  const aggressive = probe.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const deadline = Date.now() + timing.totalBudgetMs;
  let probed = 0;
  let errored = 0;
  let budgetStopped = false;
  let timeStopped = false;
  let timedOutBases = 0;
  let throttled = false;
  let heapdumpClosed = 0;
  // Every heapdump request makes an open JVM write a full dump, so a run asks
  // for at most one: none after a confirmed dump, and none after a heapdump
  // request timed out (a large heap can take longer than the timeout to start
  // answering, so a timeout may mean a dump is being written).
  let heapdumpStop: "heapdump-already-confirmed" | "heapdump-stopped-after-timeout" | null = null;
  const exposed: ExposedEndpoint[] = [];
  const unchecked: UncheckedEndpoint[] = [];

  // Every path from endpoint `s` of base `b` on (of that base only, when
  // `thisBaseOnly`) is left unchecked, for `why`. A heapdump below aggressive,
  // or after the run stopped asking for heap dumps, keeps its own reason: it
  // was never going to be sent.
  const leaveRest = (b: number, s: number, listed: string[] | null, why: UncheckedWhy, thisBaseOnly = false) => {
    const last = thisBaseOnly ? b + 1 : bases.length;
    for (let bi = b; bi < last; bi++) {
      for (let si = bi === b ? s : 0; si < ACTUATOR_ENDPOINTS.length; si++) {
        const spec = ACTUATOR_ENDPOINTS[si]!;
        // Left out by this base's open index: answered by the index, not unchecked.
        if (bi === b && listed && spec.id !== "index" && spec.id !== "heapdump" && !listed.includes(spec.id)) continue;
        const url = `${bases[bi]!.url}${spec.path}`;
        const heapWhy = !aggressive ? "probe-level" : (heapdumpStop ?? why);
        unchecked.push({ url, endpoint: spec.id, why: spec.id === "heapdump" ? heapWhy : why });
      }
    }
  };

  outer: for (let b = 0; b < bases.length; b++) {
    const base = bases[b]!;
    let listed: string[] | null = null;
    for (let s = 0; s < ACTUATOR_ENDPOINTS.length; s++) {
      const spec = ACTUATOR_ENDPOINTS[s]!;
      const url = `${base.url}${spec.path}`;
      if (spec.id === "heapdump" && !aggressive) {
        // Asking for a heap dump makes the JVM write one, so an active run
        // never asks, and never passes it. An open index that lists it is a
        // warning: the index lists endpoints Spring Security still protects,
        // so only the HPROF header read on an aggressive run makes it critical.
        if (listed?.includes("heapdump")) {
          exposed.push({ url, endpoint: "heapdump", severity: "warning", evidence: "listed-in-index", base });
        }
        unchecked.push({ url, endpoint: "heapdump", why: "probe-level" });
        continue;
      }
      // An open index lists every endpoint exposed over HTTP: one it leaves
      // out is not requested. The heapdump is the exception: it can pass only
      // on its own definite answer, so an aggressive run always asks.
      if (spec.id !== "index" && spec.id !== "heapdump" && listed && !listed.includes(spec.id)) continue;
      if (spec.id === "heapdump" && heapdumpStop) {
        unchecked.push({ url, endpoint: "heapdump", why: heapdumpStop });
        continue;
      }
      if (!aggressive && isRobotsTxtDisallowed(url, robotsTxt, "*")) {
        unchecked.push({ url, endpoint: spec.id, why: "robots" });
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timeStopped = true;
        leaveRest(b, s, listed, "time");
        break outer;
      }
      const outcome = await sendActuatorProbe(probe, base.url, spec, Math.min(timing.requestTimeoutMs, remaining));
      if (!outcome.sent) {
        budgetStopped = true;
        leaveRest(b, s, listed, "budget");
        break outer;
      }
      probed++;
      if ("error" in outcome) {
        errored++;
        if (spec.id === "heapdump" && outcome.error === "TimeoutError") {
          // Never closed, and no further heapdump request this run.
          heapdumpStop = "heapdump-stopped-after-timeout";
          unchecked.push({ url, endpoint: "heapdump", why: "heapdump-timeout" });
          if (Date.now() >= deadline) {
            timeStopped = true;
            leaveRest(b, s + 1, listed, "time");
            break outer;
          }
          timedOutBases++;
          leaveRest(b, s + 1, listed, "timeout", true);
          continue outer;
        }
        if (Date.now() >= deadline) {
          timeStopped = true;
          leaveRest(b, s, listed, "time");
          break outer;
        }
        if (outcome.error === "TimeoutError") {
          // A server that hangs on one path hangs on the next: leave this base.
          timedOutBases++;
          leaveRest(b, s, listed, "timeout", true);
          continue outer;
        }
        unchecked.push({ url, endpoint: spec.id, why: "error" });
        continue;
      }
      const { response } = outcome;
      if (
        isThrottledOrChallenged({
          status: response.status,
          headers: response.headers,
          text: new TextDecoder().decode(response.bytes),
        })
      ) {
        // The site pushed back: the answer says nothing about the path, and
        // no further request is sent.
        throttled = true;
        leaveRest(b, s, listed, "throttled");
        break outer;
      }
      if (response.status >= 500) {
        unchecked.push({ url, endpoint: spec.id, why: "server-error" });
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        if (spec.id === "index") listed = readActuatorIndex(response);
        if (EVIDENCE[spec.id].confirm(response)) {
          exposed.push({ url, endpoint: spec.id, severity: spec.severity, evidence: EVIDENCE[spec.id].evidence, base });
          if (spec.id === "heapdump") heapdumpStop = "heapdump-already-confirmed";
          continue;
        }
      }
      if (spec.id === "heapdump") {
        // Only a definite refusal or absence passes the heapdump: a 2xx
        // without the HPROF header, a redirect or another status may be a
        // proxy or error page in front of a dump that is still there.
        if (HEAPDUMP_CLOSED_STATUSES.has(response.status)) heapdumpClosed++;
        else unchecked.push({ url, endpoint: "heapdump", why: "no-definite-answer" });
      }
    }
  }

  const details = {
    bases: bases.length,
    probed,
    errored,
    skippedStateChanging: selection.skippedStateChanging,
    skippedRobots: unchecked.filter((u) => u.why === "robots").length,
    skippedCap: selection.skippedCap,
    budgetStopped,
    timeStopped,
    timedOutBases,
    throttled,
  };
  const allErrored = probed > 0 && errored === probed && !budgetStopped && !timeStopped;

  // ── index, env, configprops, mappings ──
  const mainExposed = exposed.filter((e) => e.endpoint !== "heapdump");
  const mainUnchecked = unchecked.filter((u) => u.endpoint !== "heapdump");
  const critical = mainExposed.filter((e) => e.severity === "critical");
  const other = mainExposed.filter((e) => e.severity !== "critical");
  if (critical.length > 0) {
    checks.push({
      name: CHECK_CRITICAL,
      status: "fail",
      message: `${critical.length} Spring Boot Actuator endpoint(s) that leak secrets are open to anyone: ${critical.map((e) => e.url).join(", ")}`,
      items: critical.map(item),
      details: { severity: "critical", ...details },
    });
  }
  if (other.length > 0) {
    checks.push({
      name: CHECK_EXPOSED,
      status: "warn",
      message: `${other.length} Spring Boot Actuator endpoint(s) are open to anyone: ${other.map((e) => e.url).join(", ")}`,
      items: other.map(item),
      details,
    });
  }
  if (mainUnchecked.length > 0 || selection.skippedCap > 0 || bases.length === 0) {
    // A path not definitely answered could be open: never a pass for it.
    const whys = new Set<UncheckedWhy | "cap">(mainUnchecked.map((u) => u.why));
    if (selection.skippedCap > 0) whys.add("cap");
    checks.push({
      name: CHECK_NOT_CHECKED,
      status: "skipped",
      skipReason: skipReasonFor(whys, allErrored),
      message:
        bases.length === 0
          ? "No Spring Boot Actuator path could be probed"
          : `Spring Boot Actuator paths not checked: ${describeUnchecked(mainUnchecked, selection.skippedCap)}.${
              whys.has("robots") ? " Run with --probe aggressive to probe robots.txt-disallowed paths, on a site you own or may test." : ""
            }`,
      details,
    });
  } else if (mainExposed.length === 0) {
    checks.push({
      name: CHECK_CLEAN,
      status: "pass",
      message: `No Spring Boot Actuator endpoint answered anyone (${probed} request(s) across ${bases.length} base path(s))`,
      details,
    });
  }

  // ── heapdump ──
  const heapExposed = exposed.filter((e) => e.endpoint === "heapdump");
  const heapUnchecked = unchecked.filter((u) => u.endpoint === "heapdump");
  if (heapExposed.length > 0) {
    const read = heapExposed.filter((e) => e.severity === "critical");
    checks.push({
      name: CHECK_HEAPDUMP,
      status: read.length > 0 ? "fail" : "warn",
      message:
        read.length > 0
          ? `${read.length} Spring Boot Actuator heapdump endpoint(s) hand anyone a dump of the JVM's memory: ${read.map((e) => e.url).join(", ")}`
          : `${heapExposed.length} Spring Boot Actuator heapdump endpoint(s) are listed by an open actuator index (not downloaded; they may still require authentication): ${heapExposed.map((e) => e.url).join(", ")}`,
      items: heapExposed.map(item),
      details: read.length > 0 ? { severity: "critical", ...details } : details,
    });
  }
  if (heapUnchecked.length > 0 || selection.skippedCap > 0 || bases.length === 0 || !aggressive) {
    const whys = new Set<UncheckedWhy | "cap">(heapUnchecked.map((u) => u.why));
    if (selection.skippedCap > 0) whys.add("cap");
    checks.push({
      name: CHECK_HEAPDUMP_NOT_CHECKED,
      status: "skipped",
      skipReason: skipReasonFor(whys, allErrored),
      message: !aggressive
        ? "The Spring Boot Actuator heapdump was not requested: asking for one makes the JVM write a heap dump, so it is probed only with --probe aggressive, on a site you own or may test."
        : `Spring Boot Actuator heapdump not checked: ${describeUnchecked(heapUnchecked, selection.skippedCap) || "no actuator base path could be probed"}.`,
      details,
    });
  } else if (heapExposed.length === 0 && heapdumpClosed === bases.length) {
    checks.push({
      name: CHECK_HEAPDUMP_CLOSED,
      status: "pass",
      message: `No Spring Boot Actuator heapdump answered anyone (${heapdumpClosed} base path(s) answered 401, 403 or 404)`,
      details,
    });
  }
  return { checks };
}
