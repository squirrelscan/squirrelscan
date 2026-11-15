// crawl/custom-404 - how the site answers a URL that does not exist.
//
// The crawl cannot judge this. It stores no body for a 4xx page, and a crawled
// site only meets a 404 where it links to a dead page. So the rule asks the site
// one question: one GET for a random path that cannot exist, a quiet probe that
// needs `--probe active`. Below that, or with no request tool (`squirrel analyze`),
// it reports skipped, never pass: a site whose error handling was not exercised is
// not credited.
//
// Split with crawl/soft-404: that rule judges pages the crawl fetched (a "not
// found" body on a 2xx page). This rule judges the site's answer to a path that
// was never linked, which is where a catch-all route or a rewrite to the
// homepage shows up, and it judges the quality of the real 404 page:
//   - the status is 404 or 410 (a 2xx is a soft 404, a redirect is a soft 404 by
//     another route);
//   - the page is not a bare server default (no site chrome, no nav, no search);
//   - the page offers a route back into the site;
//   - the page is noindex (a 404 status already keeps it out of the index, so
//     this is the cheapest guard against a template that sometimes answers 200).

import {
  PROBE_INCOMPLETE_SKIP_REASON,
  PROBE_LEVEL_TOO_LOW_SKIP_REASON,
} from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { parseHTML } from "linkedom";

import { readCappedBytes } from "../security/probe-http";
import { hasRequestTool } from "../tools";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const SOFT = "custom-404-soft";
const REDIRECT = "custom-404-redirect";
const DEFAULT_PAGE = "custom-404-default";
const NO_ROUTE = "custom-404-no-route";
const INDEXABLE = "custom-404-indexable";
const OK = "custom-404-ok";
const NOT_CHECKED = "custom-404-not-checked";

const PROBLEMS = [SOFT, REDIRECT, DEFAULT_PAGE, NO_ROUTE, INDEXABLE];

/** Per-request timeout, on top of the shared probe budget's deadline. */
export const CUSTOM_404_PROBE_TIMEOUT_MS = 10_000;
/** Bytes of the 404 page read. A real error page is small; the cap bounds a hostile one. */
export const CUSTOM_404_READ_CAP = 262_144;
/** A page with less visible text than this and no chrome is a bare server default. */
const BARE_TEXT_LIMIT = 400;

const ENABLE_HINT = "Run with --probe active to check, on a site you own or may test.";

/** Text the stock error pages of common servers and frameworks carry. */
const DEFAULT_SIGNATURES: Array<{ name: string; pattern: RegExp }> = [
  { name: "nginx", pattern: /<center>\s*nginx(?:\/[\d.]+)?\s*<\/center>/i },
  { name: "Apache", pattern: /the requested url (?:\S+ )?was not found on this server/i },
  { name: "IIS", pattern: /the resource you are looking for has been removed, had its name changed/i },
  { name: "Express", pattern: /<pre>cannot (?:get|post|put|delete|head) [^<]*<\/pre>/i },
  { name: "Spring Boot", pattern: /whitelabel error page/i },
  { name: "Tomcat", pattern: /apache tomcat\/[\d.]+/i },
];

export interface NotFoundAnswer {
  status: number;
  contentType: string;
  headers: Headers;
  html: string;
}


type ProbeOutcome =
  | { kind: "not-allowed" }
  | { kind: "error" }
  | { kind: "answer"; answer: NotFoundAnswer; url: string };

function siteOrigin(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function randomMissingPath(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `/squirrelscan-missing-page-${hex}`;
}

/** The exact URL and init of the probe. Exported so tests can pin what is sent. */
export function buildNotFoundProbe(origin: string, path: string): { url: string; init: RequestInit } {
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin) throw new Error("custom-404: probe left the audited origin");
  return {
    url: url.href,
    init: {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: { Accept: "text/html,*/*;q=0.8", "User-Agent": SQUIRRELSCAN_USER_AGENT },
    },
  };
}

async function sendProbe(ctx: RuleContext, origin: string): Promise<ProbeOutcome> {
  const probe = ctx.probe;
  if (!probe || !probe.allows("quiet")) return { kind: "not-allowed" };
  const { url, init } = buildNotFoundProbe(origin, randomMissingPath());
  const done = new AbortController();
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(CUSTOM_404_PROBE_TIMEOUT_MS),
    done.signal,
  ]);
  probe.record();
  try {
    const res = await fetchUndecoded(url, { ...init, signal });
    const { bytes } = await readCappedBytes(res, CUSTOM_404_READ_CAP);
    return {
      kind: "answer",
      url,
      answer: {
        status: res.status,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        headers: res.headers,
        html: new TextDecoder().decode(bytes),
      },
    };
  } catch {
    return { kind: "error" };
  } finally {
    done.abort();
  }
}

export interface ErrorPageReading {
  /** Name of the server or framework whose stock page this is, when it is one. */
  defaultServer: string | null;
  hasNav: boolean;
  hasSearch: boolean;
  /** Links to another path on the same site (a bare `#` or a fragment-only link is not a route). */
  siteLinks: number;
  hasStylesheet: boolean;
  textLength: number;
  noindex: boolean;
}

const NOINDEX = /(?:^|[\s,])(?:noindex|none)(?:[\s,]|$)/i;

/** What an HTML 404 page offers. Pure, so tests can feed it fixtures directly. */
export function readErrorPage(html: string, origin: string, headers: Headers): ErrorPageReading {
  const defaultServer = DEFAULT_SIGNATURES.find((s) => s.pattern.test(html))?.name ?? null;
  const { document } = parseHTML(html);

  const metaNoindex = [...document.querySelectorAll("meta[name]")].some((m) => {
    const name = (m.getAttribute("name") ?? "").toLowerCase();
    return (name === "robots" || name === "googlebot") && NOINDEX.test(m.getAttribute("content") ?? "");
  });
  const noindex = metaNoindex || NOINDEX.test(headers.get("x-robots-tag") ?? "");

  let siteLinks = 0;
  for (const a of document.querySelectorAll("a[href]")) {
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href || href.startsWith("#")) continue;
    try {
      const u = new URL(href, `${origin}/`);
      if (u.origin === origin && (u.protocol === "http:" || u.protocol === "https:")) siteLinks++;
    } catch {
      // Not a URL: not a route.
    }
  }

  const hasSearch =
    document.querySelector(
      'input[type="search"], [role="search"], form[action*="search" i], input[name="q" i], input[name="s" i], input[name="query" i]'
    ) !== null;
  const hasNav =
    document.querySelector('nav, [role="navigation"]') !== null ||
    document.querySelector("header a[href], footer a[href]") !== null;

  const body = document.body;
  const textLength = (body?.textContent ?? "").replace(/\s+/g, " ").trim().length;
  return {
    defaultServer,
    hasNav,
    hasSearch,
    siteLinks,
    hasStylesheet: document.querySelector('link[rel~="stylesheet"], style') !== null,
    textLength,
    noindex,
  };
}

/** A stock server page, or a bare page with no chrome of any kind. */
export function isDefaultErrorPage(r: ErrorPageReading): boolean {
  if (r.defaultServer) return true;
  return !r.hasNav && !r.hasSearch && r.siteLinks === 0 && !r.hasStylesheet && r.textLength < BARE_TEXT_LIMIT;
}

function skipped(message: string, skipReason: string | undefined, details?: Record<string, unknown>): RuleResult {
  return {
    checks: [
      {
        name: NOT_CHECKED,
        status: "skipped",
        ...(skipReason ? { skipReason } : {}),
        message,
        value: "not-checked",
        ...(details ? { details } : {}),
      },
    ],
  };
}

export const custom404Rule: Rule = {
  meta: {
    id: "crawl/custom-404",
    name: "Custom 404 Page",
    description:
      "Requests one URL that cannot exist and judges the answer: a real 404 or 410 status (not a 200 or a redirect to the homepage), a branded page rather than a bare server default, a route back into the site, and noindex. Runs only when probing is active or higher.",
    solution:
      "Serve missing URLs with a real 404 (or 410 for removed pages), never a 200 or a redirect to the homepage: search engines treat those as soft 404s, spend crawl budget on them and can index them as thin duplicates. Replace the server's stock error page with one in your site template: the header and navigation, a search box, and links to the homepage and the main sections, so a visitor or an agent that lands on a dead URL has somewhere to go. Add `<meta name=\"robots\" content=\"noindex\">` (or an `X-Robots-Tag: noindex` header) to the 404 template so it can never be indexed if a misconfiguration serves it with a 200. Check it with `curl -I https://your-site/some-missing-page`.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 4,
    checks: [
      ...PROBLEMS.map((name) => ({ name, outcome: "problem" as const })),
      { name: OK, outcome: "clean" as const, clears: PROBLEMS },
      { name: NOT_CHECKED, outcome: "skipped" as const },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const level = ctx.probe?.level ?? "passive";
    if (level === "passive") {
      return skipped(
        `404 handling not checked: probing is passive, and this rule sends one request at active. ${ENABLE_HINT}`,
        PROBE_LEVEL_TOO_LOW_SKIP_REASON,
        { probeLevel: level, requiredLevel: "active" }
      );
    }
    // `squirrel analyze` re-reads stored data and must not touch the site.
    if (!hasRequestTool()) {
      return skipped(
        "404 handling not checked: analyze runs offline; run `squirrel audit` to probe",
        "analyze-offline"
      );
    }
    const origin = siteOrigin(ctx.site?.baseUrl);
    if (!origin) return skipped("404 handling not checked: invalid base URL", undefined);

    const outcome = await sendProbe(ctx, origin);
    if (outcome.kind === "not-allowed") {
      return skipped(
        "404 handling not checked: the probe budget ran out before the request was sent",
        PROBE_INCOMPLETE_SKIP_REASON
      );
    }
    if (outcome.kind === "error") {
      return skipped(
        "404 handling not checked: the request for a missing URL failed with a network error or timeout, so no 404 response was observed",
        PROBE_INCOMPLETE_SKIP_REASON
      );
    }

    const { answer, url } = outcome;
    const { status } = answer;
    const details = { probeUrl: url, status };

    if (status === 429 || status === 430 || status === 403 || status === 401 || status >= 500) {
      return skipped(
        `404 handling not checked: the site answered the missing URL with HTTP ${status} (throttling, a bot wall or a server error), not a 404`,
        PROBE_INCOMPLETE_SKIP_REASON,
        details
      );
    }

    const checks: CheckResult[] = [];

    if (status >= 200 && status < 300) {
      checks.push({
        name: SOFT,
        status: "fail",
        message: `A URL that does not exist answered HTTP ${status} instead of 404 (${url}): the site serves soft 404s for any missing path`,
        value: `HTTP ${status}`,
        details,
      });
      return { checks };
    }
    if (status >= 300 && status < 400) {
      const location = answer.headers.get("location") ?? "";
      checks.push({
        name: REDIRECT,
        status: "warn",
        message: `A URL that does not exist redirects (HTTP ${status}${location ? ` to ${location}` : ""}) instead of answering 404 (${url}): crawlers read a redirect of missing pages as a soft 404`,
        value: `HTTP ${status}`,
        details: { ...details, ...(location ? { location } : {}) },
      });
      return { checks };
    }
    if (status !== 404 && status !== 410) {
      return skipped(
        `404 handling not checked: the missing URL answered HTTP ${status}, which is neither a 404 nor a 410`,
        PROBE_INCOMPLETE_SKIP_REASON,
        details
      );
    }

    // A real 404 or 410. Judge the page, when it is a page.
    if (!answer.contentType.includes("html") && answer.contentType !== "") {
      return skipped(
        `404 handling not checked: the missing URL answered ${status} with a ${answer.contentType.split(";")[0]} body, not an HTML error page`,
        undefined,
        details
      );
    }
    const reading = readErrorPage(answer.html, origin, answer.headers);
    const readingDetails = {
      ...details,
      navigation: reading.hasNav,
      search: reading.hasSearch,
      siteLinks: reading.siteLinks,
      noindex: reading.noindex,
    };

    if (isDefaultErrorPage(reading)) {
      checks.push({
        name: DEFAULT_PAGE,
        status: "warn",
        message: `The 404 page is a bare default${reading.defaultServer ? ` (${reading.defaultServer} stock page)` : ""}: no site chrome, no navigation, no search and no way back into the site (${url})`,
        value: `HTTP ${status}`,
        details: { ...readingDetails, defaultServer: reading.defaultServer },
      });
    } else if (reading.siteLinks === 0) {
      checks.push({
        name: NO_ROUTE,
        status: "warn",
        message: `The 404 page has no link back into the site: add navigation, a search box or a link to the homepage (${url})`,
        value: `HTTP ${status}`,
        details: readingDetails,
      });
    }
    if (!reading.noindex) {
      checks.push({
        name: INDEXABLE,
        status: "warn",
        message: `The 404 page is indexable: it has no noindex meta tag or X-Robots-Tag header, so a template that ever answers 200 would be indexed (${url})`,
        value: `HTTP ${status}`,
        details: readingDetails,
      });
    }

    if (checks.length === 0) {
      checks.push({
        name: OK,
        status: "pass",
        message: `Missing URLs answer HTTP ${status} with a branded page that has navigation and is noindex`,
        value: `HTTP ${status}`,
        details: readingDetails,
      });
    }
    return { checks };
  },
};
