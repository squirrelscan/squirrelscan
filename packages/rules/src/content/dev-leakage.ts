// content/dev-leakage - development, staging and preview hosts left on a production origin
//
// The shape of the bug: a URL that was correct on someone's laptop, or on a
// preview deploy, got baked into content or into a template and shipped. The
// reader sees `http://localhost:3000/api`, a link to `staging.example.com`, or
// an image served from a Vercel preview that will 404 the moment the deployment
// is garbage-collected.

import { getDomain } from "tldts";

import type { Element } from "linkedom";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import { getRenderedProseText } from "./text-content";

/**
 * Platforms whose hostnames are, by construction, a deployment rather than a
 * brand. A production page pointing at one of these is pointing at something
 * ephemeral.
 *
 * `ngrok.app` and `ngrok-free.app` ride along with the issue's `ngrok.io`: same
 * vendor, and `.io` is the legacy domain every current tunnel has moved off, so
 * matching only the old one would miss the tunnels people actually open today.
 *
 * `pages.dev` and `vercel.app` also host plenty of REAL production sites, which
 * is why the seed skip below exists and why a preview host that does not look
 * like this site's own project only ever warns.
 */
const PREVIEW_HOST_SUFFIXES = [
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "trycloudflare.com",
] as const;

/** Leftmost labels that name a non-production tier of the site's own domain. */
const DEV_SUBDOMAIN_LABELS = new Set(["staging", "dev", "test"]);

/**
 * Work cap on the prose scan. This rule is a yes/no signal about whether a dev
 * URL shipped, and no real page needs half a megabyte of copy to demonstrate
 * that. Bounds the cost on a hostile or machine-generated page.
 */
const MAX_SCANNED_CHARS = 500_000;

/** Elements whose attributes are read. Bounds the DOM pass on a hostile page. */
const MAX_ELEMENTS_SCANNED = 50_000;

/** Per kind, so one pathological page cannot allocate an unbounded hit list. */
const MAX_HITS_PER_KIND = 200;

/** Reports get these verbatim, so no newline and no unbounded site-controlled string. */
const MAX_SAMPLE_LENGTH = 120;

export type DevLeakageKind =
  | "localhost"
  | "private-ip"
  | "dev-subdomain"
  | "preview-host"
  | "insecure-self-link";

/** Where the reference was found: a live `href`/`src`, or copy a reader sees. */
export type DevLeakageSource = "attribute" | "text";

export interface DevLeakageHit {
  kind: DevLeakageKind;
  source: DevLeakageSource;
  /** Lowercased host that triggered the hit. */
  host: string;
  /** Short, single-line excerpt safe to put in a report. */
  sample: string;
  /**
   * True when the host is unambiguously an artifact of THIS site: a loopback or
   * private address, a non-production tier of the site's own apex, or a preview
   * deployment that carries the site's own name. False only for a preview-
   * platform host that could belong to anyone.
   */
  own: boolean;
}

/** The audited origin, resolved once per page. */
export interface SiteOrigin {
  /** Registrable domain (eTLD+1) of the page, lowercased. */
  apex: string;
  /** Leftmost label of `apex`, or "" when it is too short to match a preview on. */
  apexLabel: string;
  /** The page's own host, lowercased. */
  host: string;
  /** True when the page itself was served over HTTPS. */
  secure: boolean;
}

/**
 * eTLD+1 via the Public Suffix List, the same helper shape `integrity/signals`
 * uses. A string suffix test is not a substitute: `notdev.example.com` ends with
 * `dev.example.com`, and `example.co.uk` is not a subdomain of `co.uk`.
 *
 * `allowPrivateDomains` is on so PRIVATE-section suffixes count as public and
 * `a.vercel.app` and `b.vercel.app` resolve to DISTINCT registrable domains
 * instead of collapsing to `vercel.app`. That is what stops a site hosted on
 * `acme.pages.dev` from treating every other tenant of `pages.dev` as its own.
 *
 * Falls back to the lowercased, trailing-dot-stripped host whenever tldts
 * cannot derive one (an IP literal, `localhost`, a bare public suffix), so both
 * sides of a comparison still normalize identically.
 */
export function registrableDomain(host: string): string {
  const normalized = host.replace(/\.$/, "").toLowerCase();
  return getDomain(normalized, { allowPrivateDomains: true }) ?? normalized;
}

/** The four octets of a dotted-quad, or null if `host` is not one. */
function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Length first: `Number("")` is 0 and `Number(" 1")` is 1, so the numeric
    // test alone would accept `10...` and `10. 0.0.1` as addresses.
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** `localhost`, any `*.localhost`, the IPv6 loopback, or `127.0.0.0/8`. */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  // 0.0.0.0 is the unspecified address, not loopback, but it reaches a page only
  // by being copied out of a dev server's "listening on" line, which is the same
  // bug with the same fix.
  if (host === "0.0.0.0") return true;
  const octets = ipv4Octets(host);
  return octets !== null && octets[0] === 127;
}

/** RFC 1918: `10/8`, `172.16/12`, `192.168/16`. */
export function isPrivateIpHost(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b >= 16 && b <= 31;
}

/** A host on one of the ephemeral-deployment platforms. */
export function isPreviewHost(host: string): boolean {
  return PREVIEW_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/**
 * True when `host` is a `staging.`/`dev.`/`test.` tier of `apex`.
 *
 * Both halves are load-bearing. The registrable-domain equality is what keeps
 * `dev.someoneelse.com` out; the leftmost-label test is what keeps
 * `notdev.example.com` and `development.example.com` out, since neither is the
 * site's dev tier and a suffix test would call both one.
 */
export function isDevSubdomainOf(host: string, apex: string): boolean {
  if (!apex || host === apex) return false;
  if (registrableDomain(host) !== apex) return false;
  const leftmost = host.split(".")[0] ?? "";
  return DEV_SUBDOMAIN_LABELS.has(leftmost);
}

/**
 * True when a preview host carries the audited site's own name, e.g.
 * `acme-git-main-team.vercel.app` for `acme.com`.
 *
 * Everything on `vercel.app` and `pages.dev` looks alike from the outside, and
 * a production page may legitimately link to somebody else's project there. The
 * name test is what separates "your own preview deployment leaked" (a bug you
 * can act on) from "you linked to a site that happens to be on Vercel".
 */
export function looksLikeOwnPreview(host: string, apexLabel: string): boolean {
  // Two characters match far too much — `wp-abc.vercel.app` would "contain" the
  // apex label of `wp.com`.
  if (apexLabel.length < 3) return false;
  const leftmost = host.split(".")[0] ?? "";
  return leftmost.includes(apexLabel);
}

/** True for a host that means "this audit is not of a production origin". */
export function isNonProductionSeedHost(host: string): boolean {
  if (isLoopbackHost(host) || isPrivateIpHost(host) || isPreviewHost(host)) return true;
  // A seed whose OWN leftmost label names a tier: auditing `staging.example.com`
  // is auditing staging, and every internal link on it is a staging link.
  return DEV_SUBDOMAIN_LABELS.has(host.split(".")[0] ?? "");
}

/** Which family `host` belongs to, and whether it is this site's own artifact. */
export function classifyHost(
  host: string,
  site: SiteOrigin,
): { kind: DevLeakageKind; own: boolean } | null {
  if (isLoopbackHost(host)) return { kind: "localhost", own: true };
  if (isPrivateIpHost(host)) return { kind: "private-ip", own: true };
  if (isPreviewHost(host)) {
    return { kind: "preview-host", own: looksLikeOwnPreview(host, site.apexLabel) };
  }
  if (isDevSubdomainOf(host, site.apex)) return { kind: "dev-subdomain", own: true };
  return null;
}

/** Resolve the audited origin from a page URL. */
export function siteOriginOf(pageUrl: string): SiteOrigin | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const apex = registrableDomain(host);
  return {
    apex,
    apexLabel: apex.split(".")[0] ?? "",
    host,
    secure: url.protocol === "https:",
  };
}

function toSample(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SAMPLE_LENGTH ? `${flat.slice(0, MAX_SAMPLE_LENGTH - 1)}…` : flat;
}

/** Escape a host for literal use inside a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Prose scanning
// ---------------------------------------------------------------------------

/**
 * The character before a host has to be one that cannot be part of one, or
 * `notdev.example.com` matches on `dev.example.com` and `v10.0.0.1` matches on
 * `10.0.0.1`. Consumed rather than looked behind: the capture groups carry
 * everything the report needs, so nothing depends on `match[0]`.
 */
const LEFT_BOUNDARY = String.raw`(?:^|[^A-Za-z0-9.\-_])`;

/** Nothing may follow the host that could have been part of it. */
const RIGHT_BOUNDARY = String.raw`(?![A-Za-z0-9.\-])`;

const OPTIONAL_SCHEME = String.raw`(?:(https?):\/\/)?`;
const OPTIONAL_PORT = String.raw`(?::(\d{1,5}))?`;

/**
 * A path, if one follows. One bounded character class, never two adjacent
 * quantifiers, so a long run cannot re-partition itself. Closing punctuation is
 * excluded so a URL at the end of a parenthetical does not swallow the bracket.
 */
const OPTIONAL_PATH = String.raw`((?:\/[^\s<>"'\)\]]{0,200})?)`;

/** Up to ten leading labels, each ending in a literal dot, so partitioning is unique. */
const LEADING_LABELS = String.raw`(?:[a-z0-9-]{1,63}\.){0,10}`;

const LOCALHOST_TEXT_RE = new RegExp(
  `${LEFT_BOUNDARY}${OPTIONAL_SCHEME}(${LEADING_LABELS}localhost)${RIGHT_BOUNDARY}${OPTIONAL_PORT}${OPTIONAL_PATH}`,
  "gi",
);

const IPV4_TEXT_RE = new RegExp(
  `${LEFT_BOUNDARY}${OPTIONAL_SCHEME}(\\d{1,3}(?:\\.\\d{1,3}){3})${RIGHT_BOUNDARY}${OPTIONAL_PORT}${OPTIONAL_PATH}`,
  "gi",
);

/**
 * At least one leading label is REQUIRED. A page that writes "we deploy to
 * pages.dev" is naming a platform, not leaking a deployment; `abc123.pages.dev`
 * is a deployment.
 */
const PREVIEW_TEXT_RE = new RegExp(
  `${LEFT_BOUNDARY}${OPTIONAL_SCHEME}((?:[a-z0-9-]{1,63}\\.){1,10}(?:${PREVIEW_HOST_SUFFIXES.map(
    escapeForRegExp,
  ).join("|")}))${RIGHT_BOUNDARY}${OPTIONAL_PORT}${OPTIONAL_PATH}`,
  "gi",
);

/** `http://` spelled out in copy, host left open so the apex test can judge it. */
const INSECURE_URL_TEXT_RE = new RegExp(
  `${LEFT_BOUNDARY}(http):\\/\\/([a-z0-9][a-z0-9.\\-]{0,253})${RIGHT_BOUNDARY}${OPTIONAL_PORT}${OPTIONAL_PATH}`,
  "gi",
);

interface UrlishMatch {
  scheme: string | undefined;
  host: string;
  port: string | undefined;
  path: string;
  /** Scheme, host, port and path reassembled — the text a reader actually sees. */
  text: string;
}

/**
 * Every URL-shaped occurrence of `re` in `text`.
 *
 * `re` is module-level and `g`-flagged, so `lastIndex` is reset on both sides:
 * a stale one would silently skip the head of the next page's text.
 */
function scanUrlish(re: RegExp, text: string, limit: number): UrlishMatch[] {
  re.lastIndex = 0;
  const out: UrlishMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const host = (match[2] ?? "").toLowerCase();
    const scheme = match[1]?.toLowerCase();
    const port = match[3];
    const path = match[4] ?? "";
    out.push({
      scheme,
      host,
      port,
      path,
      text: `${scheme ? `${scheme}://` : ""}${host}${port ? `:${port}` : ""}${path}`,
    });
    if (out.length >= limit) break;
    // None of these patterns can match empty, but a zero-length match would spin
    // forever and the alternative to this guard is a hung audit.
    if (match.index === re.lastIndex) re.lastIndex++;
  }
  re.lastIndex = 0;
  return out;
}

/** True when the occurrence was written as a URL rather than as a bare word. */
const hasUrlContext = (m: UrlishMatch): boolean =>
  m.scheme !== undefined || m.port !== undefined || m.path.length > 0;

/**
 * Every dev-host reference in `text`, which must already be VISIBLE prose with
 * code-like subtrees removed.
 *
 * Two families need URL context before they count, because a bare occurrence of
 * either has an innocent second reading in ordinary prose:
 *
 * - A bare `localhost`. "Open the app on localhost" is a sentence people write;
 *   `localhost:3000` and `http://localhost` are not. A qualified host
 *   (`api.acme.localhost`) has no second reading and counts on its own.
 * - A bare address in `10.0.0.0/8`. Four dotted numbers starting at 10 is also
 *   how enterprise software spells a version, and a rule that calls a version
 *   number a leak is worse than one that misses it. `192.168.*`, `172.16-31.*`
 *   and `127.*` have no such reading and count bare.
 */
export function findDevHostsInText(text: string, site: SiteOrigin): DevLeakageHit[] {
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const hits: DevLeakageHit[] = [];

  const add = (kind: DevLeakageKind, own: boolean, m: UrlishMatch): void => {
    hits.push({ kind, source: "text", host: m.host, sample: toSample(m.text), own });
  };

  for (const m of scanUrlish(LOCALHOST_TEXT_RE, scanned, MAX_HITS_PER_KIND)) {
    const qualified = m.host !== "localhost";
    if (!qualified && !hasUrlContext(m)) continue;
    add("localhost", true, m);
  }

  for (const m of scanUrlish(IPV4_TEXT_RE, scanned, MAX_HITS_PER_KIND * 2)) {
    if (isLoopbackHost(m.host)) {
      add("localhost", true, m);
      continue;
    }
    if (!isPrivateIpHost(m.host)) continue;
    if (m.host.startsWith("10.") && !hasUrlContext(m)) continue;
    add("private-ip", true, m);
  }

  for (const m of scanUrlish(PREVIEW_TEXT_RE, scanned, MAX_HITS_PER_KIND)) {
    add("preview-host", looksLikeOwnPreview(m.host, site.apexLabel), m);
  }

  if (site.apex) {
    const devSubdomainRe = new RegExp(
      `${LEFT_BOUNDARY}${OPTIONAL_SCHEME}((?:staging|dev|test)\\.${LEADING_LABELS}${escapeForRegExp(
        site.apex,
      )})${RIGHT_BOUNDARY}${OPTIONAL_PORT}${OPTIONAL_PATH}`,
      "gi",
    );
    for (const m of scanUrlish(devSubdomainRe, scanned, MAX_HITS_PER_KIND)) {
      add("dev-subdomain", true, m);
    }
  }

  // Only on an HTTPS page, and only for the site's own domain: a printed
  // `http://` URL for somebody else's site is their transport problem, and
  // `links/https-downgrade` already owns the page-level downgrade story.
  if (site.secure && site.apex) {
    for (const m of scanUrlish(INSECURE_URL_TEXT_RE, scanned, MAX_HITS_PER_KIND)) {
      if (registrableDomain(m.host) !== site.apex) continue;
      // A dev host that happens to be reachable over http is already reported as
      // what it is; saying it twice would double-count the same string.
      if (classifyHost(m.host, site)) continue;
      add("insecure-self-link", true, m);
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Attribute scanning
// ---------------------------------------------------------------------------

/**
 * Every `href`/`src` value on the page, in document order.
 *
 * Attribute names are folded from `el.attributes` rather than looked up by
 * name: `getAttribute` follows the HTML case rules only through the parser's
 * patched DOM, and reading the list once is cheaper than two by-name lookups
 * per element, each of which walks that same list.
 */
export function collectUrlAttributes(root: Element): string[] {
  const out: string[] = [];
  let seen = 0;
  for (const el of root.querySelectorAll("*")) {
    if (++seen > MAX_ELEMENTS_SCANNED) break;
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name !== "href" && name !== "src") continue;
      const value = attr.value?.trim();
      if (value) out.push(value);
    }
  }
  return out;
}

/**
 * The dev-leakage hit for one `href`/`src` value, or null.
 *
 * A value that will not parse is skipped rather than reported: a malformed URL
 * is `links/invalid-links`'s finding, and restating it here would put the same
 * defect in two categories under two different names.
 */
export function classifyUrlAttribute(
  raw: string,
  pageUrl: string,
  site: SiteOrigin,
): DevLeakageHit | null {
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  // The canonical form, never the raw attribute: `url.href` is what the browser
  // would actually request, and it is percent-encoded, so a site-controlled
  // attribute cannot smuggle markup or a newline into the report through it.
  const sample = toSample(url.href);

  const classified = classifyHost(host, site);
  if (classified) {
    return { kind: classified.kind, source: "attribute", host, sample, own: classified.own };
  }
  if (site.secure && url.protocol === "http:" && registrableDomain(host) === site.apex) {
    return { kind: "insecure-self-link", source: "attribute", host, sample, own: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** One row per kind, with the count and the first sample, in report order. */
export interface DevLeakageSummaryRow {
  kind: DevLeakageKind;
  sample: string;
  count: number;
  /** True when at least one occurrence of this kind came from an `href`/`src`. */
  inAttribute: boolean;
}

/**
 * `insecure-self-link` is the one kind `links/https-downgrade` also speaks
 * about, so it is never allowed to decide this rule's status on its own and
 * never escalates to `fail`. See the doc page for the full overlap story.
 */
const SOFT_KINDS = new Set<DevLeakageKind>(["insecure-self-link"]);

export function summarize(hits: DevLeakageHit[]): DevLeakageSummaryRow[] {
  const rows = new Map<DevLeakageKind, DevLeakageSummaryRow>();
  for (const hit of hits) {
    const existing = rows.get(hit.kind);
    if (!existing) {
      rows.set(hit.kind, {
        kind: hit.kind,
        sample: hit.sample,
        count: 1,
        inAttribute: hit.source === "attribute",
      });
      continue;
    }
    existing.count += 1;
    // Prefer an attribute sample: a live reference is stronger evidence than a
    // mention, and it is the one a reader can click to reproduce the bug.
    if (hit.source === "attribute" && !existing.inAttribute) {
      existing.inAttribute = true;
      existing.sample = hit.sample;
    }
  }
  return [...rows.values()];
}

export const devLeakageRule: Rule = {
  meta: {
    id: "content/dev-leakage",
    name: "Development Host Leakage",
    description: "Detects localhost, private, staging and preview hosts on a production page",
    solution:
      "A URL that was correct in development shipped to production. Find where it is stored, not just the page it appears on: a link or image pointing at localhost, a private address, or a preview deployment is usually a hard-coded value in a template, a CMS field written while working locally, or a base-URL environment variable that never got a production value, so the same URL is on every page that renders that component. Replace the origin with a relative path where the target is on this site, which is what makes the link correct in every environment at once. For a staging or preview host, point the link at the production equivalent and check whether the staging site is publicly indexable while you are there. For an `http://` link back to your own site, make it relative or `https://`, since the redirect it currently costs every visitor is avoidable.",
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 6,
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const name = "dev-leakage";
    const doc = ctx.parsed.document;
    if (!doc) {
      checks.push({
        name,
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    const site = siteOriginOf(ctx.page.url);
    if (!site) {
      checks.push({
        name,
        status: "skipped",
        message: "Page URL could not be parsed",
        skipReason: "unparseable-page-url",
      });
      return { checks };
    }

    // The audited origin, which is the SEED when the runner supplied site data
    // and the page's own URL otherwise. Both are checked: a seed on a preview
    // host means the whole audit is of a preview, and a page that redirected
    // onto one means this page is.
    const seedHost = ctx.site?.baseUrl ? siteOriginOf(ctx.site.baseUrl)?.host : undefined;
    const nonProductionHost = [seedHost, site.host].find(
      (h): h is string => h !== undefined && isNonProductionSeedHost(h),
    );
    if (nonProductionHost) {
      checks.push({
        name,
        status: "skipped",
        message: `Audited origin is itself a non-production host (${nonProductionHost}), so its own URLs are not leakage`,
        skipReason: "non-production-origin",
      });
      return { checks };
    }

    const body = doc.querySelector("body");
    if (!body) {
      checks.push({
        name,
        status: "skipped",
        message: "No body element to read visible text from",
        skipReason: "no-body",
      });
      return { checks };
    }

    const hits: DevLeakageHit[] = [];
    for (const raw of collectUrlAttributes(body)) {
      const hit = classifyUrlAttribute(raw, ctx.page.url, site);
      if (hit) hits.push(hit);
    }
    // Prose only, and never the raw HTML. `getRenderedProseText` drops `<code>`,
    // `<pre>`, `<template>` and highlighter containers, which is what lets a
    // tutorial print `http://localhost:3000` in a code sample and stay clean —
    // the single largest false-positive class this rule has.
    hits.push(...findDevHostsInText(getRenderedProseText(body), site));

    if (hits.length === 0) {
      checks.push({
        name,
        status: "pass",
        message: "No development, private or preview hosts referenced",
      });
      return { checks };
    }

    const rows = summarize(hits);
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    const kinds = rows.map((r) => r.kind).join(", ");

    // A live `href`/`src` at a host that is unmistakably this site's own dev
    // artifact is a broken reference a visitor can hit right now, so it fails. A
    // mention in copy is embarrassing rather than broken, and a preview host
    // that could belong to anyone is a judgement call, so both warn.
    const broken = hits.some(
      (h) => h.source === "attribute" && h.own && !SOFT_KINDS.has(h.kind),
    );
    const status = broken ? "fail" : "warn";

    // Lead with the row that decided the status, so the example line is the
    // clickable reference rather than whichever mention came first.
    const leading =
      rows.find((r) => r.inAttribute && !SOFT_KINDS.has(r.kind)) ?? (rows[0] as DevLeakageSummaryRow);

    checks.push({
      name,
      status,
      message: `${total} development host reference(s) on a production page (${kinds}): example ${leading.sample}`,
      value: total,
      items: rows.map((r) => ({
        id: r.sample,
        label: r.kind,
        meta: { count: r.count, inAttribute: r.inAttribute },
      })),
      details: {
        kinds: rows.map((r) => ({
          kind: r.kind,
          sample: r.sample,
          count: r.count,
          inAttribute: r.inAttribute,
        })),
      },
    });
    return { checks };
  },
};
