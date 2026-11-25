// security/debug-endpoints - debug, config and metrics endpoints that disclose
// internal state to anyone (squirrelscan#2323)
//
// A quiet probing rule: it sends requests beyond the crawl, so it runs only
// when the probing intensity allows quiet probes (`ctx.probe`, see
// probe-budget.ts: active or aggressive). Passive, or no `ctx.probe`, sends
// nothing and reports not checked.
//
// What may be probed. A short curated list (DEBUG_ENDPOINT_PATHS) plus the
// endpoint discovery pass's candidates (`ctx.endpointSurface`) whose path names
// a debug, config, env, metrics or health endpoint. `selectDebugEndpoints`
// enforces every condition:
//
//  - Same origin as the audited base URL, checked here again rather than
//    trusting `probeEligible`. No URL carries credentials.
//  - A discovered call site states GET or no method, and its path names no
//    state-changing action (`isStateChangingPath`).
//  - Not a GraphQL path (security/graphql-introspection owns those) and not an
//    actuator path (security/exposed-actuator owns those).
//  - At most MAX_DISCOVERED_DEBUG_ENDPOINTS discovered endpoints.
//  - Below aggressive, a robots.txt-disallowed URL is not requested.
//
// What is sent. One anonymous GET per endpoint, shared with the other probing
// rules (`sendAnonymousGet`): query and fragment dropped, no cookies, no
// Authorization header, redirects not followed, one quiet probe from the
// shared budget, a per-request timeout, and a capped body decoded no further
// than the cap (#722). A 429 or a bot challenge stops the rule, as does the
// first timeout (a server that hangs on one path hangs on the next).
//
// What is flagged. A 2xx answer that is not HTML is read for five classes of
// internal state, each by its shape, never by its status:
//
//  - env-vars (fail): an object, or dotenv-style lines, of at least three
//    environment-variable names with scalar values, at least one of them a
//    well-known variable or a credential-shaped name.
//  - config-secrets (fail): a password, secret or private key under a field
//    named for it (a placeholder such as `****` or `${VAR}` is not one), or a
//    connection URL that carries a user name and password.
//  - internal-hosts (warn): private IP addresses, internal-only host names
//    (`.internal`, `.local`, `.svc.cluster.local` and the like) or dotless
//    service names in URLs. Loopback and the audited host are not counted, and
//    nothing is judged when the audited site is itself on a private host.
//  - prometheus-metrics (warn): the Prometheus or OpenMetrics text format.
//  - runtime-state (warn): Go expvar's command line and memory statistics.
//
// A bare health check (`{"status":"ok"}`) matches none of these. Two endpoints
// that answer with the same body are one finding (a catch-all route).
//
// What is reported. The endpoint, its status and the classes of data, with
// counts and, for env-vars and config-secrets, a few field names. Never a
// value: no secret, host name or address from the response leaves this file.
//
// Not checked is never clean (#1920): any endpoint left unanswered (robots.txt,
// budget, timeout, error, 5xx, pushback, the discovery cap) makes the run
// incomplete, and the findings already confirmed stand beside that note.

import {
  PROBE_INCOMPLETE_SKIP_REASON,
  PROBE_LEVEL_TOO_LOW_SKIP_REASON,
} from "@squirrelscan/core-contracts";
import { isNonPublicHostname } from "@squirrelscan/utils/non-public-host";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { ProbeBudget } from "../probe-budget";
import type {
  CheckItem,
  CheckResult,
  Rule,
  RuleContext,
  RuleResult,
} from "../types";

import { hasRequestTool } from "../tools";
import { isGraphqlPath, isStateChangingPath } from "./graphql-probe";
import {
  type AnonymousGetResponse,
  isThrottledOrChallenged,
  isUnverifiedReply,
  sendAnonymousGet,
} from "./probe-http";

export const DEBUG_ENDPOINTS_RULE_ID = "security/debug-endpoints";

const CHECK = "debug-endpoint-exposed";
const CLEAN = "debug-endpoints-none";
const NOT_CHECKED = "debug-endpoints-not-checked";
const INCOMPLETE = "debug-endpoints-incomplete";

/** Probed on every site that allows quiet probes. Small on purpose: each is one quiet GET. */
export const DEBUG_ENDPOINT_PATHS: readonly string[] = [
  "/api/debug",
  "/debug",
  "/debug/vars",
  "/api/config",
  "/api/env",
  "/env",
  "/metrics",
  "/healthz",
  "/health",
  "/api/health",
];

/** Discovered endpoints one run probes, on top of the curated list. */
export const MAX_DISCOVERED_DEBUG_ENDPOINTS = 5;

// A discovered path is a candidate when one of its segments is one of these.
const DEBUG_PATH_WORDS = new Set([
  "debug",
  "config",
  "configuration",
  "env",
  "environment",
  "metrics",
  "prometheus",
  "health",
  "healthz",
  "healthcheck",
  "livez",
  "readyz",
  "vars",
  "diagnostics",
]);

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ── selection ──────────────────────────────────────────────────────

export interface DebugEndpoint {
  /** Origin plus path: no query, no fragment. */
  url: string;
  source: "curated" | "discovered";
  discoveredVia: string;
}

export interface DebugEndpointSelection {
  endpoints: DebugEndpoint[];
  /** Matching discovered candidates past MAX_DISCOVERED_DEBUG_ENDPOINTS. */
  skippedCap: number;
  /** Matching discovered candidates left out because the path or method changes state. */
  skippedStateChanging: number;
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

/** True when a path segment names a debug, config, env, metrics or health endpoint. */
export function isDebugEndpointPath(pathname: string): boolean {
  return pathname
    .toLowerCase()
    .split("/")
    .some((segment) => DEBUG_PATH_WORDS.has(segment.replace(/\.json$/, "")));
}

/**
 * The endpoints the rule may probe, in a stable order: the curated list, then
 * matching discovered candidates in the discovery pass's order. Pure: sends
 * nothing.
 */
export function selectDebugEndpoints(
  ctx: Pick<RuleContext, "site" | "endpointSurface">
): DebugEndpointSelection {
  const endpoints: DebugEndpoint[] = [];
  let skippedCap = 0;
  let skippedStateChanging = 0;
  const baseUrl = ctx.site?.baseUrl;
  const siteOrigin = baseUrl ? originOf(baseUrl) : null;
  if (!baseUrl || !siteOrigin)
    return { endpoints, skippedCap, skippedStateChanging };
  const seen = new Set<string>();

  for (const path of DEBUG_ENDPOINT_PATHS) {
    const url = `${siteOrigin}${path}`;
    seen.add(url);
    endpoints.push({ url, source: "curated", discoveredVia: "curated" });
  }

  let discovered = 0;
  for (const c of ctx.endpointSurface?.candidates ?? []) {
    if (!c.probeEligible || !c.sameOrigin) continue;
    let u: URL;
    try {
      u = new URL(c.url, baseUrl);
    } catch {
      continue;
    }
    // Strict same origin, whatever the candidate says about itself.
    if (originOf(u.href) !== siteOrigin) continue;
    if (u.username || u.password) continue;
    const path = u.pathname;
    if (!isDebugEndpointPath(path)) continue;
    if (isGraphqlPath(path)) continue;
    if (path.toLowerCase().split("/").includes("actuator")) continue;
    if (
      isStateChangingPath(path) ||
      (c.method !== undefined && UNSAFE_METHODS.has(c.method.toUpperCase()))
    ) {
      skippedStateChanging++;
      continue;
    }
    const url = `${u.origin}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    if (discovered >= MAX_DISCOVERED_DEBUG_ENDPOINTS) {
      skippedCap++;
      continue;
    }
    discovered++;
    endpoints.push({
      url,
      source: "discovered",
      discoveredVia: c.discoveredVia,
    });
  }
  return { endpoints, skippedCap, skippedStateChanging };
}

// ── classification ─────────────────────────────────────────────────

export type LeakClass =
  | "env-vars"
  | "config-secrets"
  | "internal-hosts"
  | "prometheus-metrics"
  | "runtime-state";

export interface LeakFinding {
  class: LeakClass;
  /** How many variables, fields, hosts or metric families. */
  count: number;
  /** A few field names (never values), for env-vars and config-secrets. */
  names?: string[];
}

/** The classes that fail the check; the rest warn. */
const FAIL_CLASSES = new Set<LeakClass>(["env-vars", "config-secrets"]);

const CLASS_LABEL: Record<LeakClass, string> = {
  "env-vars": "environment variables",
  "config-secrets": "configuration secrets",
  "internal-hosts": "internal hosts or addresses",
  "prometheus-metrics": "Prometheus metrics",
  "runtime-state": "process command line and memory statistics",
};

const CLASS_ORDER: readonly LeakClass[] = [
  "env-vars",
  "config-secrets",
  "internal-hosts",
  "prometheus-metrics",
  "runtime-state",
];

/** Field names kept per class. */
const MAX_NAMES = 5;
/** JSON nodes walked per answer, and the deepest level read. */
const MAX_JSON_NODES = 20_000;
const MAX_JSON_DEPTH = 12;
/** Text tokens read for host names per answer. */
const MAX_TOKENS = 50_000;
/** Lines read per text answer. */
const MAX_LINES = 20_000;

// A reportable field name: short and plain. Anything else is counted, not named.
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,127}$/;
const KNOWN_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "HOSTNAME",
  "PWD",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TZ",
  "PORT",
  "NODE_ENV",
  "NODE_OPTIONS",
  "RAILS_ENV",
  "RACK_ENV",
  "APP_ENV",
  "FLASK_ENV",
  "DJANGO_SETTINGS_MODULE",
  "PYTHONPATH",
  "JAVA_HOME",
  "GOPATH",
  "DATABASE_URL",
  "REDIS_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "KUBERNETES_SERVICE_HOST",
  "KUBERNETES_PORT",
]);
const CREDENTIAL_ENV_SUFFIX_RE =
  /_(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|SECRET_KEY|API_KEY|DSN|DATABASE_URL)$/;

/** Field names (lowercased, non-alphanumerics removed) that hold a secret, matched as a suffix. */
const SECRET_KEY_SUFFIXES = [
  "password",
  "passwd",
  "secret",
  "secretkey",
  "privatekey",
  "secretaccesskey",
  "connectionstring",
  "signingkey",
  "encryptionkey",
  "masterkey",
];
const PUBLIC_KEY_PREFIXES = ["public", "publishable"];
// Values that stand for a secret without being one.
// Only short values are tested: a placeholder is never long, and the bound keeps
// the match linear on a site-supplied string.
const PLACEHOLDER_RE =
  /^(?:[*x\u2022.\-_ ]{1,256}|<[^>]{0,64}>|\$\{[^}]{0,128}\}|%[^%]{0,128}%|null|none|undefined|string|text|password|secret|required|optional|hidden|\*{3}.{0,256})$/i;
const PLACEHOLDER_WORDS = ["redact", "masked"];
// A site-relative path such as a route, never a credential.
const PATH_VALUE_RE = /^\/[a-z0-9\-_/.]*$/i;
// One key=value pair, as in a connection string. The key is bounded so the
// unanchored match stays linear on a site-supplied string.
const KEY_VALUE_PAIR_RE = /[A-Za-z_][\w.]{0,64}=\S/;
// A boolean or toggle setting under a password-named key.
const FLAG_VALUE_RE =
  /^(?:true|false|yes|no|on|off|enabled?|disabled?|null|none)$/i;
// Keys whose values look like addresses but are versions or digests.
const VERSION_KEY_RE = /version|build|release|commit|sha|hash|checksum/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  const k = normaliseKey(key);
  if (PUBLIC_KEY_PREFIXES.some((p) => k.startsWith(p))) return false;
  return SECRET_KEY_SUFFIXES.some((s) => k.endsWith(s));
}

function isSecretValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < 4) return false;
  // UI copy and route paths ("Forgot your password?", "/account/reset-password")
  // sit under password-named keys in i18n bundles and route maps. A secret has
  // no spaces, except a PEM block or a key=value connection string. A bare "="
  // is not enough: validation copy ("Password length must be >= 8") has one.
  if (/\s/.test(v) && !v.includes("-----BEGIN") && !KEY_VALUE_PAIR_RE.test(v)) {
    return false;
  }
  if (PATH_VALUE_RE.test(v)) return false;
  // Feature flags ("requirePassword": "false") are settings, not credentials.
  if (FLAG_VALUE_RE.test(v)) return false;
  if (v.length > 512) return true;
  const lower = v.toLowerCase();
  if (PLACEHOLDER_WORDS.some((w) => lower.includes(w))) return false;
  return !PLACEHOLDER_RE.test(v);
}

function isScalar(v: unknown): boolean {
  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

function addName(names: string[], name: string): void {
  if (
    names.length < MAX_NAMES &&
    SAFE_NAME_RE.test(name) &&
    !names.includes(name)
  )
    names.push(name);
}

/** The env-var names of one object or set of dotenv lines, when they read as an environment. */
function envNamesOf(entries: [string, unknown][]): string[] | null {
  const envKeys = entries.filter(
    ([k, v]) => ENV_NAME_RE.test(k) && isScalar(v)
  );
  if (envKeys.length < 3 || envKeys.length * 2 < entries.length) return null;
  const known = envKeys.some(
    ([k]) => KNOWN_ENV_NAMES.has(k) || CREDENTIAL_ENV_SUFFIX_RE.test(k)
  );
  return known ? envKeys.map(([k]) => k) : null;
}

/** A host the answer names that no public visitor could reach, or null. */
function internalHost(rawHost: string, siteHost: string): string | null {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host.length === 0 || host === siteHost) return null;
  // Loopback and the unspecified address name the process itself, not the network.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "::" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
    return null;
  return isNonPublicHostname(host) ? host : null;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DOTTED_NAME_RE = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,20}$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,20}:\/\//i;
// Split on what cannot be part of a URL or host token. Linear: one class.
const TOKEN_SPLIT_RE = /[\s"'<>(){},;=|\\`]+/;

interface TextScan {
  hosts: Set<string>;
  /** Connection URLs that carry a user name and password. */
  credentialUrls: number;
}

/** Read one string for internal hosts and credentialed URLs. `scan` accumulates. */
function scanText(text: string, siteHost: string | null, scan: TextScan): void {
  let previous = "";
  let read = 0;
  for (const token of text.split(TOKEN_SPLIT_RE)) {
    if (++read > MAX_TOKENS) break;
    const prev = previous;
    previous = token;
    if (token.length < 3 || token.length > 2048) continue;
    if (SCHEME_RE.test(token)) {
      let u: URL;
      try {
        u = new URL(token);
      } catch {
        continue;
      }
      if (u.username && u.password) scan.credentialUrls++;
      if (siteHost !== null && u.hostname) {
        const host = internalHost(u.hostname, siteHost);
        if (host) scan.hosts.add(host);
      }
      continue;
    }
    if (siteHost === null) continue;
    // A label such as `version="10.1.0.3"` names a version, not an address.
    if (VERSION_KEY_RE.test(prev)) continue;
    const bare = token.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
    const ip = IPV4_RE.exec(bare);
    if (ip) {
      if (ip.slice(1).every((o) => Number(o) <= 255)) {
        const host = internalHost(bare, siteHost);
        if (host) scan.hosts.add(host);
      }
      continue;
    }
    if (DOTTED_NAME_RE.test(bare) && !/^[\d.]+$/.test(bare)) {
      const host = internalHost(bare, siteHost);
      if (host) scan.hosts.add(host);
    }
  }
}

const PROM_TYPE_RE =
  /^# TYPE [A-Za-z_:][A-Za-z0-9_:]{0,200} (?:counter|gauge|histogram|summary|untyped|unknown|info|stateset|gaugehistogram)\s*$/;
const PROM_SAMPLE_RE =
  /^[A-Za-z_:][A-Za-z0-9_:]{0,200}(?:\{[^}\n]{0,4096}\})? {1,8}(?:[-+]?(?:\d{1,64}(?:\.\d{0,64})?(?:[eE][-+]?\d{1,4})?|\.\d{1,64}(?:[eE][-+]?\d{1,4})?)|[-+]?Inf|NaN)(?: [-+]?\d{1,20})?\s*$/;
const DOTENV_RE = /^(?:export {1,8})?([A-Z][A-Z0-9_]{1,127})=/;

function linesOf(text: string): string[] {
  return text.split("\n", MAX_LINES).map((l) => l.replace(/\r$/, ""));
}

/** The number of metric families in a Prometheus text answer, or 0. */
function prometheusFamilies(lines: string[]): number {
  let families = 0;
  let samples = 0;
  for (const line of lines) {
    if (line.length > 8192) continue;
    if (line.startsWith("#")) {
      if (PROM_TYPE_RE.test(line)) families++;
    } else if (line.trim() && PROM_SAMPLE_RE.test(line)) samples++;
  }
  return families > 0 && samples > 0 ? families : 0;
}

/** Env-var names in dotenv-style lines, when the answer reads as an environment. */
function dotenvNames(lines: string[]): string[] | null {
  const entries: [string, unknown][] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = DOTENV_RE.exec(t);
    entries.push(m ? [m[1]!, "value"] : ["", null]);
  }
  return envNamesOf(entries);
}

interface JsonScan {
  envNames: Set<string>;
  secretNames: string[];
  secretFields: number;
  runtime: boolean;
}

function walkJson(
  root: unknown,
  siteHost: string | null,
  text: TextScan
): JsonScan {
  const out: JsonScan = {
    envNames: new Set(),
    secretNames: [],
    secretFields: 0,
    runtime: false,
  };
  if (
    isPlainObject(root) &&
    Array.isArray(root.cmdline) &&
    isPlainObject(root.memstats)
  )
    out.runtime = true;
  let nodes = 0;
  const stack: { value: unknown; depth: number; key: string }[] = [
    { value: root, depth: 0, key: "" },
  ];
  while (stack.length > 0) {
    if (++nodes > MAX_JSON_NODES) break;
    const { value, depth, key } = stack.pop()!;
    if (typeof value === "string") {
      if (!VERSION_KEY_RE.test(key)) scanText(value, siteHost, text);
      continue;
    }
    if (depth >= MAX_JSON_DEPTH) continue;
    if (Array.isArray(value)) {
      for (const v of value) stack.push({ value: v, depth: depth + 1, key });
      continue;
    }
    if (!isPlainObject(value)) continue;
    const entries = Object.entries(value);
    const env = envNamesOf(entries);
    if (env) for (const name of env) out.envNames.add(name);
    for (const [k, v] of entries) {
      if (isSecretKey(k) && isSecretValue(v)) {
        out.secretFields++;
        addName(out.secretNames, k);
      }
      stack.push({ value: v, depth: depth + 1, key: k });
    }
  }
  return out;
}

/**
 * The classes of internal state one answer discloses, in a stable order.
 * `siteHost` is the audited host, or null when the audited site is itself on
 * a private host (internal hosts are then not judged). Pure.
 */
export function classifyDebugResponse(
  response: Pick<AnonymousGetResponse, "contentType" | "body">,
  siteHost: string | null
): LeakFinding[] {
  const body = response.body;
  const trimmed = body.trimStart();
  if (response.contentType.includes("html") || trimmed.startsWith("<"))
    return [];
  const found = new Map<LeakClass, LeakFinding>();
  const text: TextScan = { hosts: new Set(), credentialUrls: 0 };
  let secretFields = 0;
  let secretNames: string[] = [];

  let json: unknown;
  let parsed = false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(body);
      parsed = true;
    } catch {
      parsed = false;
    }
  }
  if (parsed) {
    const scan = walkJson(json, siteHost, text);
    if (scan.envNames.size > 0) {
      const names: string[] = [];
      for (const n of scan.envNames) addName(names, n);
      found.set("env-vars", {
        class: "env-vars",
        count: scan.envNames.size,
        names,
      });
    }
    secretFields = scan.secretFields;
    secretNames = scan.secretNames;
    if (scan.runtime)
      found.set("runtime-state", { class: "runtime-state", count: 1 });
  } else {
    const lines = linesOf(body);
    const families = prometheusFamilies(lines);
    if (families > 0)
      found.set("prometheus-metrics", {
        class: "prometheus-metrics",
        count: families,
      });
    const env = families > 0 ? null : dotenvNames(lines);
    if (env) {
      const names: string[] = [];
      for (const n of env) addName(names, n);
      found.set("env-vars", { class: "env-vars", count: env.length, names });
    }
    scanText(body, siteHost, text);
  }

  if (secretFields + text.credentialUrls > 0) {
    found.set("config-secrets", {
      class: "config-secrets",
      count: secretFields + text.credentialUrls,
      names: secretNames,
    });
  }
  if (text.hosts.size > 0)
    found.set("internal-hosts", {
      class: "internal-hosts",
      count: text.hosts.size,
    });
  return CLASS_ORDER.flatMap((c) => found.get(c) ?? []);
}

// ── the rule ───────────────────────────────────────────────────────

interface Hit {
  endpoint: DebugEndpoint;
  status: number;
  leaks: LeakFinding[];
  /** Other endpoints that answered with the same body. */
  alsoAt: string[];
}

type UncheckedWhy =
  | "robots"
  | "budget"
  | "timeout"
  | "error"
  | "server-error"
  | "throttled";

const WHY_LABEL: Record<UncheckedWhy, string> = {
  robots: "disallowed by robots.txt",
  budget: "the probe budget ran out",
  timeout: "a request timed out, so no further endpoint was requested",
  error: "the request failed",
  "server-error": "the server answered with an error (5xx)",
  throttled:
    "the site rate limited the probes (HTTP 429) or answered with a bot challenge, so no further endpoint was requested",
};

function describeLeak(l: LeakFinding): string {
  const names =
    l.names && l.names.length > 0 ? `, e.g. ${l.names.join(", ")}` : "";
  return `${CLASS_LABEL[l.class]} (${l.count}${names})`;
}

function hitCheck(hit: Hit): CheckResult {
  const { endpoint, status, leaks, alsoAt } = hit;
  const fails = leaks.some((l) => FAIL_CLASSES.has(l.class));
  const leaked = leaks.map(describeLeak).join("; ");
  const also =
    alsoAt.length > 0
      ? ` The same answer is served at ${alsoAt.join(", ")}.`
      : "";
  const item: CheckItem = {
    id: endpoint.url,
    label: `${endpoint.url}: ${leaks.map((l) => CLASS_LABEL[l.class]).join(", ")}`,
    meta: {
      status,
      classes: leaks.map((l) => l.class),
      leaks: leaks.map((l) => ({
        class: l.class,
        count: l.count,
        ...(l.names && l.names.length > 0 ? { names: l.names } : {}),
      })),
      source: endpoint.source,
      discoveredVia: endpoint.discoveredVia,
      ...(alsoAt.length > 0 ? { alsoAt } : {}),
    },
  };
  return {
    name: CHECK,
    status: fails ? "fail" : "warn",
    message: `${endpoint.url} discloses internal state to anyone: ${leaked}. Values are not shown.${also}`,
    items: [item],
    details: {
      endpoint: endpoint.url,
      status,
      classes: leaks.map((l) => l.class),
      severity: fails ? "high" : "medium",
    },
  };
}

function siteHostFor(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
    // Auditing a private host: every address it names is "internal", so none is judged.
    return isNonPublicHostname(host) ? null : host;
  } catch {
    return null;
  }
}

export const debugEndpointsRule: Rule = {
  meta: {
    id: DEBUG_ENDPOINTS_RULE_ID,
    name: "Exposed Debug Endpoints",
    description:
      "Requests a short list of common debug, config, env, metrics and health endpoints, plus matching endpoints the site's own code calls, with anonymous GET requests, and flags each one whose answer discloses environment variables, configuration secrets, internal hosts, Prometheus metrics or process state. Values are never reported. Runs only when probing is active or aggressive.",
    solution:
      'Turn off debug and env endpoints in production, or put them behind authentication. Serve metrics and detailed health checks on an internal port or path that the internet cannot reach (a separate listener, a network policy, or an allowlist at the proxy), and keep the public health check to a bare status such as `{"status":"ok"}`. If environment variables or secrets were readable, treat them as leaked and rotate them.',
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 8,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CLEAN, outcome: "clean", clears: [CHECK] },
      { name: NOT_CHECKED, outcome: "skipped" },
      { name: INCOMPLETE, outcome: "skipped" },
    ],
  },

  // Synchronous when nothing will be probed, so a run that sends nothing
  // answers at once (rule-clean-run-site-checks, #1741).
  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const probe = ctx.probe;
    const level = probe?.level ?? "passive";
    if (!probe || level === "passive") {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            skipReason: PROBE_LEVEL_TOO_LOW_SKIP_REASON,
            message:
              "Debug, config and metrics endpoints not checked: probing is passive. Run with --probe active to check them.",
            value: "not-checked",
            details: { probeLevel: level, requiredLevel: "active" },
          },
        ],
      };
    }
    // `squirrel analyze` installs no request tool: it re-reads stored data and must not touch the site.
    if (!hasRequestTool()) {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            skipReason: "analyze-offline",
            message:
              "Debug, config and metrics endpoints not checked: analyze runs offline; run `squirrel audit` to probe",
            value: "not-checked",
          },
        ],
      };
    }
    const baseUrl = ctx.site?.baseUrl;
    const selection = selectDebugEndpoints(ctx);
    if (!baseUrl || selection.endpoints.length === 0) {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            message: "Invalid base URL",
            value: "not-checked",
          },
        ],
      };
    }
    return probeDebugEndpoints(ctx, probe, baseUrl, selection);
  },
};

async function probeDebugEndpoints(
  ctx: RuleContext,
  probe: ProbeBudget,
  baseUrl: string,
  selection: DebugEndpointSelection
): Promise<RuleResult> {
  const level = probe.level;
  const siteHost = siteHostFor(baseUrl);
  const aggressive = level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;

  const hits: Hit[] = [];
  const byBody = new Map<string, Hit>();
  const unchecked: { url: string; why: UncheckedWhy }[] = [];
  let probed = 0;
  let stopped: UncheckedWhy | null = null;

  for (const endpoint of selection.endpoints) {
    if (stopped) {
      unchecked.push({ url: endpoint.url, why: stopped });
      continue;
    }
    if (!aggressive && isRobotsTxtDisallowed(endpoint.url, robotsTxt, "*")) {
      unchecked.push({ url: endpoint.url, why: "robots" });
      continue;
    }
    const outcome = await sendAnonymousGet(probe, endpoint.url);
    if (!outcome.sent) {
      stopped = "budget";
      unchecked.push({ url: endpoint.url, why: "budget" });
      continue;
    }
    probed++;
    if ("error" in outcome) {
      const why: UncheckedWhy =
        outcome.error === "TimeoutError" ? "timeout" : "error";
      if (why === "timeout") stopped = "timeout";
      unchecked.push({ url: endpoint.url, why });
      continue;
    }
    const { response } = outcome;
    const reply = {
      status: response.status,
      headers: response.headers,
      text: response.body,
    };
    if (isThrottledOrChallenged(reply)) {
      stopped = "throttled";
      unchecked.push({ url: endpoint.url, why: "throttled" });
      continue;
    }
    if (isUnverifiedReply(reply)) {
      unchecked.push({ url: endpoint.url, why: "server-error" });
      continue;
    }
    // Anything but a 2xx (a redirect, a 401, 403 or 404) is not exposed here.
    if (response.status < 200 || response.status >= 300) continue;
    const leaks = classifyDebugResponse(response, siteHost);
    if (leaks.length === 0) continue;
    const same = byBody.get(response.body);
    if (same) {
      same.alsoAt.push(endpoint.url);
      continue;
    }
    const hit: Hit = { endpoint, status: response.status, leaks, alsoAt: [] };
    byBody.set(response.body, hit);
    hits.push(hit);
  }

  const checks: CheckResult[] = hits.map(hitCheck);
  const details = {
    endpoints: selection.endpoints.length,
    curated: DEBUG_ENDPOINT_PATHS.length,
    discovered: selection.endpoints.length - DEBUG_ENDPOINT_PATHS.length,
    probed,
    exposed: hits.length,
    unverified: unchecked.length,
    skippedCap: selection.skippedCap,
    skippedStateChanging: selection.skippedStateChanging,
    internalHostsJudged: siteHost !== null,
  };

  if (unchecked.length > 0 || selection.skippedCap > 0) {
    const byWhy = new Map<UncheckedWhy, string[]>();
    for (const u of unchecked)
      byWhy.set(u.why, [...(byWhy.get(u.why) ?? []), u.url]);
    const parts = [...byWhy].map(
      ([why, urls]) => `${urls.join(", ")} (${WHY_LABEL[why]})`
    );
    if (selection.skippedCap > 0)
      parts.push(
        `${selection.skippedCap} more discovered endpoint(s) past the cap of ${MAX_DISCOVERED_DEBUG_ENDPOINTS}`
      );
    checks.push({
      name: INCOMPLETE,
      status: "skipped",
      skipReason: PROBE_INCOMPLETE_SKIP_REASON,
      message: `Debug, config and metrics endpoints check incomplete, and these may disclose internal state: ${parts.join("; ")}.${
        byWhy.has("robots")
          ? " Run with --probe aggressive to probe robots.txt-disallowed paths, on a site you own or may test."
          : ""
      }`,
      value: "not-checked",
      details: { ...details, stoppedBy: stopped },
    });
    return { checks };
  }

  if (hits.length === 0) {
    checks.push({
      name: CLEAN,
      status: "pass",
      message: `None of the ${selection.endpoints.length} debug, config, metrics and health endpoint(s) probed discloses internal state`,
      details,
    });
  }
  return { checks };
}
