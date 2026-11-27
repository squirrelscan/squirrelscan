// security/wordpress-exposure - WordPress endpoints that hand out usernames,
// the version and a brute-force or pingback surface
//
// A probing rule gated on WordPress detection: it runs only when the endpoint
// discovery pass found a convention candidate for the wordpress stack
// (`discoveredVia: "convention:wordpress"`, see CONVENTION_PATHS in
// endpoint-surface.ts). On any other site it reports nothing. On a WordPress
// site it sends requests beyond the crawl, so it follows the shared probe
// budget (`ctx.probe`) and sends nothing on a passive run.
//
// What is sent. Only GET, only to four fixed same-origin paths, one request
// each, so a run sends at most MAX_WORDPRESS_REQUESTS requests:
//
//  - `/readme.html` and `/xmlrpc.php` (quiet, need `active`)
//  - `/wp-json/wp/v2/users` and `/?author=1` (loud, need `aggressive`):
//    username enumeration is what a scanner does to build a password list, and
//    the author probe is a request whose answer is a redirect to a username
//    URL, so both are loud.
//
// `xmlrpc.php` is never sent a POST: a GET to an enabled endpoint answers
// "XML-RPC server accepts POST requests only", which is enough to know it is
// on. Requests carry no cookies, do not follow redirects, read a capped body,
// stop on a 429 or a bot challenge, and are bounded by the probe budget, a
// per-request timeout and the rule's own total time. Below aggressive, a path
// robots.txt disallows is not requested.
//
// What is reported. An endpoint counts only when its answer has the shape that
// endpoint has, never on status alone. Findings name the endpoint, the kind of
// evidence and (for users) a count. A username, and any body, never leaves
// this file. The version from readme.html, when an old readme names one, is
// the one value reported.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { ProbeKind } from "../probe-budget";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { isThrottledOrChallenged, readCappedBytes } from "./probe-http";

/** The most requests one run sends. */
export const MAX_WORDPRESS_REQUESTS = 4;
export const WORDPRESS_PROBE_TIMEOUT_MS = 10_000;
export const WORDPRESS_TOTAL_BUDGET_MS = 30_000;

export interface WordpressTiming {
  requestTimeoutMs: number;
  totalBudgetMs: number;
}
export const DEFAULT_WORDPRESS_TIMING: WordpressTiming = {
  requestTimeoutMs: WORDPRESS_PROBE_TIMEOUT_MS,
  totalBudgetMs: WORDPRESS_TOTAL_BUDGET_MS,
};

type Family = "users" | "version" | "xmlrpc";
type ProbeId = "rest-users" | "author-redirect" | "readme" | "xmlrpc";

interface ProbeSpec {
  id: ProbeId;
  family: Family;
  /** Path and query appended to the origin. */
  path: string;
  kind: ProbeKind;
  maxBytes: number;
}

/** The only requests this rule sends, in order. Every one is a GET. */
export const WORDPRESS_PROBES: readonly ProbeSpec[] = [
  {
    id: "readme",
    family: "version",
    path: "/readme.html",
    kind: "quiet",
    maxBytes: 64 * 1024,
  },
  {
    id: "xmlrpc",
    family: "xmlrpc",
    path: "/xmlrpc.php",
    kind: "quiet",
    maxBytes: 4 * 1024,
  },
  {
    id: "rest-users",
    family: "users",
    path: "/wp-json/wp/v2/users",
    kind: "loud",
    maxBytes: 256 * 1024,
  },
  {
    id: "author-redirect",
    family: "users",
    path: "/?author=1",
    kind: "loud",
    maxBytes: 1024,
  },
];

const CHECKS: Record<
  Family,
  { exposed: string; closed: string; notChecked: string }
> = {
  users: {
    exposed: "wordpress-user-enumeration",
    closed: "wordpress-user-enumeration-closed",
    notChecked: "wordpress-user-enumeration-not-checked",
  },
  version: {
    exposed: "wordpress-version-disclosure",
    closed: "wordpress-version-disclosure-closed",
    notChecked: "wordpress-version-disclosure-not-checked",
  },
  xmlrpc: {
    exposed: "wordpress-xmlrpc-enabled",
    closed: "wordpress-xmlrpc-closed",
    notChecked: "wordpress-xmlrpc-not-checked",
  },
};
const FAMILIES: readonly Family[] = ["version", "xmlrpc", "users"];

const FAMILY_LABEL: Record<Family, string> = {
  users: "WordPress username enumeration",
  version: "WordPress version disclosure",
  xmlrpc: "WordPress xmlrpc.php",
};

const RISK: Record<Family, string> = {
  users:
    "Usernames give an attacker half of every login: they can be fed to wp-login.php or xmlrpc.php in a brute-force or credential-stuffing run.",
  version:
    "readme.html confirms WordPress and dates the install, and a version tells a scanner which known vulnerabilities to try.",
  xmlrpc:
    "xmlrpc.php is a brute-force target (system.multicall tries many passwords in one request) and a pingback amplification vector (pingback.ping makes your server request a URL the attacker picks).",
};

// ── gate ───────────────────────────────────────────────────────────

/** True when endpoint discovery found WordPress (its convention candidates are present). */
export function isWordpressSite(
  ctx: Pick<RuleContext, "endpointSurface">
): boolean {
  return (ctx.endpointSurface?.candidates ?? []).some(
    (c) => c.discoveredVia === "convention:wordpress"
  );
}

function siteOrigin(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

// ── reading ────────────────────────────────────────────────────────

interface Reply {
  status: number;
  headers: Headers;
  contentType: string;
  bytes: Uint8Array;
  truncated: boolean;
}

type Outcome =
  | { sent: false }
  | { sent: true; reply: Reply }
  | { sent: true; error: string };

/** Build the exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildWordpressProbe(
  origin: string,
  spec: ProbeSpec
): { url: string; init: RequestInit } {
  return {
    url: `${origin}${spec.path}`,
    init: {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: {
        Accept: spec.id === "rest-users" ? "application/json" : "*/*",
        "User-Agent": SQUIRRELSCAN_USER_AGENT,
      },
    },
  };
}

async function send(
  ctx: RuleContext,
  origin: string,
  spec: ProbeSpec,
  timeoutMs: number
): Promise<Outcome> {
  const probe = ctx.probe;
  if (!probe?.allows(spec.kind)) return { sent: false };
  const { url, init } = buildWordpressProbe(origin, spec);
  const done = new AbortController();
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(timeoutMs),
    done.signal,
  ]);
  probe.record();
  try {
    const res = await fetchUndecoded(url, { ...init, signal });
    const { bytes, truncated } = await readCappedBytes(res, spec.maxBytes);
    return {
      sent: true,
      reply: {
        status: res.status,
        headers: res.headers,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        bytes,
        truncated,
      },
    };
  } catch (err) {
    return {
      sent: true,
      error: err instanceof Error ? err.name || "Error" : "Error",
    };
  } finally {
    done.abort();
  }
}

const text = (r: Reply) => new TextDecoder().decode(r.bytes);

/** `/wp-json/wp/v2/users`: a JSON array of user objects with an id and a slug. Returns the count. */
export function readRestUsers(r: Reply): number | null {
  if (r.status < 200 || r.status >= 300 || r.truncated) return null;
  if (r.contentType.includes("html")) return null;
  let json: unknown;
  try {
    json = JSON.parse(text(r));
  } catch {
    return null;
  }
  if (!Array.isArray(json) || json.length === 0) return null;
  const users = json.filter(
    (u) =>
      typeof u === "object" &&
      u !== null &&
      typeof (u as { id?: unknown }).id === "number" &&
      typeof (u as { slug?: unknown }).slug === "string"
  );
  return users.length === json.length ? users.length : null;
}

/** `/?author=1`: a redirect whose target is `/author/<name>/`, the username. */
export function readAuthorRedirect(r: Reply, origin: string): boolean {
  if (r.status < 300 || r.status >= 400) return false;
  const loc = r.headers.get("location");
  if (!loc) return false;
  try {
    const u = new URL(loc, origin);
    return u.origin === origin && /^\/author\/[^/]{1,256}\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

// WordPress has shipped readme.html with this title since 2.x. Releases since
// 3.x dropped the "Version N" line, so the title alone identifies the file, and
// a served readme.html is the disclosure even when it names no version: it
// still confirms WordPress and dates the install to a release line.
const README_TITLE_RE =
  /<title>\s{0,16}WordPress\s{0,8}(?:&#8250;|&rsaquo;|\u203A)\s{0,8}ReadMe\s{0,16}<\/title>/i;
const README_VERSION_RE =
  /<br\s{0,8}\/?>\s{0,64}Version\s{1,8}(\d{1,3}(?:\.\d{1,3}){1,3})/i;

/**
 * `/readme.html`: WordPress's own readme. Null when the reply is not that file;
 * otherwise the version it names, or null `version` for the current readme,
 * which names none.
 */
export function readReadme(r: Reply): { version: string | null } | null {
  if (r.status < 200 || r.status >= 300) return null;
  const body = text(r);
  const head = body.slice(0, 4096);
  const version = README_VERSION_RE.exec(body)?.[1] ?? null;
  if (README_TITLE_RE.test(head)) return { version };
  // An old readme whose title differs still has the version line.
  if (version && /wordpress/i.test(head)) return { version };
  return null;
}

/** `/xmlrpc.php`: the answer a GET to an enabled endpoint gets. */
export function isXmlrpcEnabled(r: Reply): boolean {
  if (r.status >= 500 || r.status === 404) return false;
  return /XML-RPC server accepts POST requests only/i.test(text(r));
}

// ── the rule ───────────────────────────────────────────────────────

export const wordpressExposureRule: Rule = {
  meta: {
    id: "security/wordpress-exposure",
    name: "WordPress user enumeration, version and xmlrpc exposure",
    description:
      "On a site detected as WordPress, probes with read-only GET requests for usernames exposed by the wp-json users endpoint or the ?author= redirect, the version disclosed by readme.html, and an enabled xmlrpc.php. readme.html and xmlrpc.php need probing active or aggressive; the username probes are loud and need aggressive.",
    solution:
      "Deny /xmlrpc.php at the web server unless you need it (nginx `location = /xmlrpc.php { deny all; }`, or a `<Files xmlrpc.php>` deny in .htaccess): the `xmlrpc_enabled` filter turns off only authenticated methods and leaves pingback.ping answering. Restrict /wp-json/wp/v2/users to signed-in users (a `rest_authentication_errors` filter), block `?author=N` redirects, and delete readme.html (and license.txt). Use login names that differ from author slugs, and rate limit wp-login.php.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 5,
    checks: FAMILIES.flatMap((f) => [
      { name: CHECKS[f].exposed, outcome: "problem" as const },
      {
        name: CHECKS[f].closed,
        outcome: "clean" as const,
        clears: [CHECKS[f].exposed],
      },
      { name: CHECKS[f].notChecked, outcome: "skipped" as const },
    ]),
  },

  run(ctx: RuleContext): Promise<RuleResult> {
    return runWordpressExposure(ctx);
  },
};

interface Found {
  probe: ProbeSpec;
  evidence: string;
  detail?: string;
}

export async function runWordpressExposure(
  ctx: RuleContext,
  timing: WordpressTiming = DEFAULT_WORDPRESS_TIMING
): Promise<RuleResult> {
  if (!isWordpressSite(ctx)) return { checks: [] };
  const checks: CheckResult[] = [];
  const probe = ctx.probe;
  if (!probe || probe.level === "passive") {
    for (const f of FAMILIES)
      checks.push({
        name: CHECKS[f].notChecked,
        status: "skipped",
        skipReason: "probing-passive",
        message: `Probing is passive, so ${FAMILY_LABEL[f]} was not probed. Run with --probe active (readme.html, xmlrpc.php) or --probe aggressive (usernames) to check.`,
      });
    return { checks };
  }
  const origin = siteOrigin(ctx.site?.baseUrl);
  if (!origin) return { checks: [] };

  const aggressive = probe.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const deadline = Date.now() + timing.totalBudgetMs;
  const found: Found[] = [];
  const answered = new Set<ProbeId>();
  const unchecked = new Map<ProbeId, string>();
  let stop: string | null = null;

  for (const spec of WORDPRESS_PROBES) {
    if (stop) {
      unchecked.set(spec.id, stop);
      continue;
    }
    if (spec.kind === "loud" && !aggressive) {
      unchecked.set(spec.id, "probe-level-too-low");
      continue;
    }
    if (
      !aggressive &&
      isRobotsTxtDisallowed(`${origin}${spec.path}`, robotsTxt, "*")
    ) {
      unchecked.set(spec.id, "robots-disallowed");
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      stop = PROBE_INCOMPLETE_SKIP_REASON;
      unchecked.set(spec.id, stop);
      continue;
    }
    const out = await send(
      ctx,
      origin,
      spec,
      Math.min(timing.requestTimeoutMs, remaining)
    );
    if (!out.sent) {
      stop = "probe-budget";
      unchecked.set(spec.id, stop);
      continue;
    }
    if ("error" in out) {
      unchecked.set(spec.id, "probe-errors");
      continue;
    }
    const r = out.reply;
    const reply = { status: r.status, headers: r.headers, text: text(r) };
    if (isThrottledOrChallenged(reply)) {
      stop = PROBE_INCOMPLETE_SKIP_REASON;
      unchecked.set(spec.id, stop);
      continue;
    }
    if (r.status >= 500) {
      unchecked.set(spec.id, PROBE_INCOMPLETE_SKIP_REASON);
      continue;
    }
    answered.add(spec.id);
    if (spec.id === "rest-users") {
      const n = readRestUsers(r);
      if (n !== null)
        found.push({
          probe: spec,
          evidence: "rest-users-listing",
          detail: `${n} user(s) listed`,
        });
    } else if (spec.id === "author-redirect") {
      if (readAuthorRedirect(r, origin))
        found.push({ probe: spec, evidence: "author-redirect-to-username" });
    } else if (spec.id === "readme") {
      const readme = readReadme(r);
      if (readme)
        found.push({
          probe: spec,
          evidence: readme.version ? "readme-version" : "readme-served",
          ...(readme.version ? { detail: `version ${readme.version}` } : {}),
        });
    } else if (isXmlrpcEnabled(r)) {
      found.push({ probe: spec, evidence: "xmlrpc-post-only-banner" });
    }
  }

  const details = {
    requests: answered.size,
    maxRequests: MAX_WORDPRESS_REQUESTS,
  };
  for (const f of FAMILIES) {
    const specs = WORDPRESS_PROBES.filter((p) => p.family === f);
    const hits = found.filter((h) => h.probe.family === f);
    const urlOf = (h: Found) => `${origin}${h.probe.path}`;
    const missed = specs.filter((p) => unchecked.has(p.id));
    if (hits.length > 0) {
      checks.push({
        name: CHECKS[f].exposed,
        status: "warn",
        message: `${FAMILY_LABEL[f]}: ${hits
          .map(
            (h) =>
              `${urlOf(h)} (${h.evidence}${h.detail ? `, ${h.detail}` : ""})`
          )
          .join(", ")}. ${RISK[f]}`,
        items: hits.map((h) => ({
          id: urlOf(h),
          label: `${urlOf(h)}: ${h.evidence}`,
          meta: {
            evidence: h.evidence,
            ...(h.detail ? { detail: h.detail } : {}),
          },
        })),
        details,
      });
    } else if (missed.length > 0) {
      const reasons = new Set(missed.map((p) => unchecked.get(p.id)!));
      const reason =
        reasons.size === 1 ? [...reasons][0]! : PROBE_INCOMPLETE_SKIP_REASON;
      checks.push({
        name: CHECKS[f].notChecked,
        status: "skipped",
        skipReason: reason,
        message: `${FAMILY_LABEL[f]} not checked: ${missed.map((p) => `${origin}${p.path} (${unchecked.get(p.id)})`).join(", ")}.`,
        details,
      });
    } else {
      checks.push({
        name: CHECKS[f].closed,
        status: "pass",
        message: `${FAMILY_LABEL[f]} not found (${specs.length} request(s))`,
        details,
      });
    }
  }
  return { checks };
}
