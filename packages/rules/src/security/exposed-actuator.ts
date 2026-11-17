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
// `heapdump` on an aggressive run only (asking for a heap dump
// makes the JVM write one, so it is a loud probe; on an active run a heapdump
// listed by an open index is reported from that listing alone, as a warning,
// because the index also lists endpoints that need a login). The heapdump
// request asks for its first 64 bytes with a Range header and reads at most
// that many, whatever the server sends. Requests carry no cookies, do not
// follow redirects, are bounded by the shared probe budget, a per-request
// timeout (one timeout ends that base) and the rule's own total time budget,
// and read a capped body that is decoded no further than the cap (#722). Below
// aggressive, a robots.txt-disallowed URL is not requested. A 429 or a bot
// challenge stops the rule.
//
// Anything not answered (robots.txt, budget, time, timeout, error, pushback)
// makes the run not checked, never a pass, so it never clears a finding.
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

const CHECK_CRITICAL = "exposed-actuator-critical";
const CHECK_EXPOSED = "exposed-actuator-endpoints";
const CHECK_CLEAN = "exposed-actuator";
const CHECK_NOT_CHECKED = "exposed-actuator-not-checked";

interface ExposedEndpoint {
  url: string;
  endpoint: ActuatorEndpointId;
  severity: "critical" | "warning";
  evidence: ActuatorEvidence;
  base: ActuatorBase;
}

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
      "Probes the site's Spring Boot Actuator paths with read-only GET requests and flags endpoints that answer anyone: env, configprops and heapdump leak secrets and memory (critical), the index and mappings map the application. Runs only when probing is active or aggressive.",
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
    ],
  },

  run(ctx: RuleContext): Promise<RuleResult> {
    return runExposedActuator(ctx);
  },
};

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
  const aggressive = probe.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const deadline = Date.now() + timing.totalBudgetMs;
  let probed = 0;
  let errored = 0;
  let skippedRobots = 0;
  let budgetStopped = false;
  let timeStopped = false;
  let timedOutBases = 0;
  let throttled = false;
  const exposed: ExposedEndpoint[] = [];

  outer: for (const base of selection.bases) {
    let listed: string[] | null = null;
    for (const spec of ACTUATOR_ENDPOINTS) {
      const url = `${base.url}${spec.path}`;
      // An open index lists every endpoint exposed over HTTP: one it leaves
      // out is not requested.
      if (spec.id !== "index" && listed && !listed.includes(spec.id)) continue;
      if (spec.id === "heapdump" && !aggressive) {
        // Asking for a heap dump makes the JVM write one, so an active run
        // never asks. An open index that lists it is a warning: the index
        // lists endpoints Spring Security still protects, so only the HPROF
        // header read on an aggressive run makes it critical.
        if (listed?.includes("heapdump")) {
          exposed.push({ url, endpoint: "heapdump", severity: "warning", evidence: "listed-in-index", base });
        }
        continue;
      }
      if (!aggressive && isRobotsTxtDisallowed(url, robotsTxt, "*")) {
        skippedRobots++;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timeStopped = true;
        break outer;
      }
      const outcome = await sendActuatorProbe(
        probe,
        base.url,
        spec,
        Math.min(timing.requestTimeoutMs, remaining)
      );
      if (!outcome.sent) {
        budgetStopped = true;
        break outer;
      }
      probed++;
      if ("error" in outcome) {
        errored++;
        if (Date.now() >= deadline) {
          timeStopped = true;
          break outer;
        }
        if (outcome.error === "TimeoutError") {
          // A server that hangs on one path hangs on the next: leave this base.
          timedOutBases++;
          continue outer;
        }
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
        break outer;
      }
      if (response.status < 200 || response.status >= 300) continue;
      if (spec.id === "index") listed = readActuatorIndex(response);
      if (EVIDENCE[spec.id].confirm(response)) {
        exposed.push({ url, endpoint: spec.id, severity: spec.severity, evidence: EVIDENCE[spec.id].evidence, base });
      }
    }
  }

  const details = {
    bases: selection.bases.length,
    probed,
    errored,
    skippedStateChanging: selection.skippedStateChanging,
    skippedRobots,
    skippedCap: selection.skippedCap,
    budgetStopped,
    timeStopped,
    timedOutBases,
    throttled,
  };

  const critical = exposed.filter((e) => e.severity === "critical");
  const other = exposed.filter((e) => e.severity !== "critical");
  if (critical.length > 0) {
    checks.push({
      name: CHECK_CRITICAL,
      status: "fail",
      message: `${critical.length} Spring Boot Actuator endpoint(s) that leak secrets or memory are open to anyone: ${critical.map((e) => e.url).join(", ")}`,
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
  if (exposed.length > 0) return { checks };

  const answered = probed - errored - (throttled ? 1 : 0);
  if (probed === 0 && budgetStopped) {
    checks.push({
      name: CHECK_NOT_CHECKED,
      status: "skipped",
      skipReason: "probe-budget",
      message: "The probe budget ran out before any Spring Boot Actuator path was probed",
      details,
    });
  } else if (probed === 0 && !timeStopped) {
    // Nothing sent: every path was disallowed by robots.txt (or there was no
    // base to probe). Nothing was checked, so this is never a pass, and a
    // finding from an earlier run is not cleared.
    checks.push({
      name: CHECK_NOT_CHECKED,
      status: "skipped",
      skipReason: skippedRobots > 0 ? "robots-disallowed" : PROBE_INCOMPLETE_SKIP_REASON,
      message:
        skippedRobots > 0
          ? `robots.txt disallows every Spring Boot Actuator path (${skippedRobots}), so none was probed. Run with --probe aggressive to probe them anyway, on a site you own or may test.`
          : "No Spring Boot Actuator path could be probed",
      details,
    });
  } else if (probed > 0 && errored === probed && !budgetStopped && !timeStopped) {
    checks.push({
      name: CHECK_NOT_CHECKED,
      status: "skipped",
      skipReason: "probe-errors",
      message: `Every Spring Boot Actuator probe failed with a network error or timeout (${probed} request(s)), so the actuator was not checked`,
      details,
    });
  } else if (budgetStopped || timeStopped || throttled || errored > 0) {
    // The paths not answered could be open.
    const why: string[] = [];
    if (throttled) {
      why.push("the site rate limited the probes (HTTP 429) or answered with a bot challenge, so no further request was sent");
    }
    if (budgetStopped) why.push(`the probe budget ran out after ${probed} request(s)`);
    if (timeStopped) why.push(`the rule's ${Math.round(timing.totalBudgetMs / 1000)} s time limit ran out after ${probed} request(s)`);
    if (timedOutBases > 0) why.push(`${timedOutBases} base path(s) stopped answering (a request timed out)`);
    const otherErrors = errored - timedOutBases;
    if (otherErrors > 0) why.push(`${otherErrors} request(s) failed with a network error or timeout`);
    checks.push({
      name: CHECK_NOT_CHECKED,
      status: "skipped",
      skipReason: budgetStopped && !timeStopped && !throttled && errored === 0 ? "probe-budget" : PROBE_INCOMPLETE_SKIP_REASON,
      message: `Spring Boot Actuator check incomplete: ${why.join("; ")}. ${answered} request(s) were answered without an open endpoint, but the rest were not checked`,
      details,
    });
  } else {
    checks.push({
      name: CHECK_CLEAN,
      status: "pass",
      message: `No Spring Boot Actuator endpoint answered anyone (${probed} request(s) across ${selection.bases.length} base path(s))`,
      details,
    });
  }
  return { checks };
}
