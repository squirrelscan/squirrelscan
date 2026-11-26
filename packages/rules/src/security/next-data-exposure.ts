// security/next-data-exposure - sensitive data in Next.js `_next/data` payloads
//
// A Next.js pages-router page that uses getServerSideProps or getStaticProps
// serves the props it returns as JSON at /_next/data/<buildId>/<path>.json, and
// embeds the same props in its HTML. Props that carry a token, a password hash
// or another user's record are readable by anyone, whatever the page renders.
//
// A probing rule: it runs only when the probing intensity allows it
// (`ctx.probe`) and sends nothing on a passive run.
//
// What may be requested:
//  - The buildId (and the locale, on an i18n site) comes from the crawled
//    page's own `__NEXT_DATA__` script, and only for a page that script marks
//    as server-rendered (`gssp` or `gsp`), since an auto-exported page has no
//    data file. No path is guessed.
//  - Same origin as the audited base URL, checked again here.
//  - Not disallowed by robots.txt (the crawl's robots group, as
//    security/graphql-probe reads it), unless the run is aggressive.
//  - At most MAX_NEXT_DATA_PAGES pages per run, one GET each, no cookies, no
//    redirects followed, through the shared probe budget and the JSON probe's
//    capped reader.
//
// What is flagged is what security/json-sensitive-fields flags, using the same
// walker and secret matchers, applied to `pageProps`: a credential is a fail,
// bulk personal data a warn. Values never reach the report.
//
// Not checked is never clean (#1920): a throttle, bot challenge, 5xx, timeout,
// an answer over the read cap, an exhausted budget, or a reply that is not a
// JSON data file (a 404 after a redeploy changed the buildId, a redirect, an
// HTML page), or a data file left out by the per-run cap or by robots.txt,
// leaves the run not checked. A pass needs every data file of every crawled
// server-rendered page read as JSON.

import {
  type CheckItem,
  PROBE_INCOMPLETE_SKIP_REASON,
} from "@squirrelscan/core-contracts";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { isSuccessStatus } from "./graphql-probe";
import {
  isBulkPii,
  leakedSecretKinds,
  looksLikeJson,
  piiSummary,
  scanJsonValue,
  sendJsonProbe,
  sensitiveItems,
  type JsonProbeResponse,
  type SensitiveFinding,
} from "./json-sensitive-fields";
import { isThrottledOrChallenged, isUnverifiedReply } from "./probe-http";

export const NEXT_DATA_EXPOSURE_RULE_ID = "security/next-data-exposure";

const CHECK_SENSITIVE = "next-data-sensitive-fields";
const CHECK_BULK_PII = "next-data-bulk-pii";
const CHECK_CLEAN = "next-data-exposure";

/** Pages whose data file is requested per run. */
export const MAX_NEXT_DATA_PAGES = 10;
/** Longest buildId accepted. Real ones are 21 characters or a short hash. */
const MAX_BUILD_ID_CHARS = 64;
/** Largest `__NEXT_DATA__` script parsed. */
const MAX_NEXT_DATA_CHARS = 2 * 1024 * 1024;
const BUILD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** BCP 47 shaped: letters, digits and `-`, short enough for any real tag. */
const LOCALE_RE = /^[A-Za-z0-9-]{1,35}$/;

export interface NextDataCandidate {
  /** The crawled page the data file belongs to. */
  page: string;
  /** The `_next/data` URL requested. */
  url: string;
  buildId: string;
}

export interface NextDataInfo {
  buildId: string;
  /** Active locale on an i18n site, or null. Part of the data file path. */
  locale: string | null;
}

export interface NextDataSelection {
  candidates: NextDataCandidate[];
  skippedRobots: number;
  skippedCap: number;
  /** Crawled pages carrying a `__NEXT_DATA__` script, server-rendered or not. */
  nextPages: number;
}

type SitePage = NonNullable<RuleContext["site"]>["pages"][number];

/**
 * buildId and locale from a document's `__NEXT_DATA__` script, when the page's
 * props are server-rendered, or null. Called page-time by the streaming engine's
 * signal collector (the site pass sees no DOM) and by the legacy fallback below.
 */
export function readNextDataFromDocument(
  doc: Document | null | undefined
): NextDataInfo | null {
  if (!doc) return null;
  let el: Element | null;
  try {
    el = doc.getElementById("__NEXT_DATA__");
  } catch {
    return null;
  }
  const text = el?.textContent ?? "";
  if (text.length === 0 || text.length > MAX_NEXT_DATA_CHARS) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const rec = data as Record<string, unknown>;
  const id = rec.buildId;
  if (
    typeof id !== "string" ||
    id.length > MAX_BUILD_ID_CHARS ||
    !BUILD_ID_RE.test(id)
  )
    return null;
  // Auto-exported pages have no data file to request.
  if (rec.gssp !== true && rec.gsp !== true) return null;
  // On an i18n site the data file sits under the locale, so a page whose
  // locale cannot be used safely is not requested rather than guessed.
  let locale: string | null = null;
  if (rec.locale !== undefined && rec.locale !== null) {
    if (typeof rec.locale !== "string" || !LOCALE_RE.test(rec.locale))
      return null;
    locale = rec.locale;
  }
  return { buildId: id, locale };
}

/** buildId and locale of a page whose props are server-rendered, or null. */
export function readServerRenderedNextData(
  page: SitePage
): NextDataInfo | null {
  return readNextDataFromDocument(page.parsed?.document);
}

/**
 * The data file path, as Next.js builds it: `/` becomes `/index.json`,
 * `/blog/post/` becomes `/blog/post.json`. With a locale, the locale prefix of
 * the page URL (absent for the default locale) is replaced by the locale
 * itself: `/fr/about` and `/about` with locale `fr` become `/fr/about.json`,
 * and `/` with locale `en` becomes `/en.json`.
 */
export function nextDataPath(
  pathname: string,
  buildId: string,
  locale: string | null = null
): string {
  let trimmed = pathname.replace(/\/+$/, "");
  if (locale !== null) {
    const prefix = `/${locale}`.toLowerCase();
    const lower = trimmed.toLowerCase();
    if (lower === prefix) trimmed = "";
    else if (lower.startsWith(`${prefix}/`))
      trimmed = trimmed.slice(prefix.length);
    trimmed = `/${locale}${trimmed}`;
  }
  return `/_next/data/${buildId}${trimmed === "" ? "/index" : trimmed}.json`;
}

function isNextInternalPath(pathname: string): boolean {
  return pathname === "/_next" || pathname.startsWith("/_next/");
}

/** The data files the rule may request, in crawl order. Pure: sends nothing. */
export function selectNextDataCandidates(
  ctx: Pick<RuleContext, "site" | "probe" | "collectedSignals">
): NextDataSelection {
  const selection: NextDataSelection = {
    candidates: [],
    skippedRobots: 0,
    skippedCap: 0,
    nextPages: 0,
  };
  const baseUrl = ctx.site?.baseUrl;
  let siteOrigin: string;
  try {
    siteOrigin = new URL(baseUrl ?? "").origin;
  } catch {
    return selection;
  }
  const aggressive = ctx.probe?.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  // The robots.txt group the crawl was matched as, as security/graphql-probe reads it.
  const robotsAgent = ctx.site?.robotsUserAgent || "*";
  const seen = new Set<string>();
  // The streaming engine detaches every DOM before the site pass, so the
  // `__NEXT_DATA__` read is taken page-time into the collected signals. A record
  // without the field (none should exist: the collector id was bumped with it)
  // falls back to the page's own document.
  const collected = new Map<string, NextDataInfo | null>();
  for (const rec of ctx.collectedSignals?.pages ?? []) {
    if (rec.nextData !== undefined) collected.set(rec.url, rec.nextData);
  }

  for (const page of ctx.site?.pages ?? []) {
    if (page.redirectSource || page.statusCode < 200 || page.statusCode > 299)
      continue;
    let u: URL;
    try {
      u = new URL(page.finalUrl ?? page.url);
    } catch {
      continue;
    }
    if (u.origin !== siteOrigin || u.username || u.password) continue;
    if (isNextInternalPath(u.pathname)) continue;
    const next = collected.has(page.url)
      ? (collected.get(page.url) ?? null)
      : readServerRenderedNextData(page);
    if (next === null) continue;
    const { buildId } = next;
    selection.nextPages++;
    const url = `${u.origin}${nextDataPath(u.pathname, buildId, next.locale)}`;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!aggressive && isRobotsTxtDisallowed(url, robotsTxt, robotsAgent)) {
      selection.skippedRobots++;
      continue;
    }
    if (selection.candidates.length >= MAX_NEXT_DATA_PAGES) {
      selection.skippedCap++;
      continue;
    }
    selection.candidates.push({ page: u.href, url, buildId });
  }
  return selection;
}

export interface NextDataScan {
  sensitive: SensitiveFinding[];
  pii: ReturnType<typeof scanJsonValue>["pii"];
  walkTruncated: boolean;
}

/**
 * Scan one 2xx data file's `pageProps`, or null when it is not JSON. Only
 * `pageProps` is judged: the rest of the envelope is Next.js bookkeeping.
 */
export function scanNextDataResponse(
  response: JsonProbeResponse,
  url: string
): NextDataScan | null {
  if (!isSuccessStatus(response.status) || !looksLikeJson(response))
    return null;
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const props = (json as Record<string, unknown>).pageProps;
  if (typeof props !== "object" || props === null) return null;
  const walked = scanJsonValue(props);
  const text = JSON.stringify(props);
  return {
    sensitive: [
      ...walked.sensitive.map((f) => ({
        ...f,
        path: `pageProps${f.path.startsWith("$") ? f.path.slice(1) : `.${f.path}`}`,
      })),
      ...leakedSecretKinds(text, url, walked.flaggedValues),
    ],
    pii: walked.pii,
    walkTruncated: walked.walkTruncated,
  };
}

export const nextDataExposureRule: Rule = {
  meta: {
    id: NEXT_DATA_EXPOSURE_RULE_ID,
    name: "Sensitive Data in Next.js Data Files",
    description:
      "Requests the /_next/data JSON file of each crawled server-rendered Next.js page, without cookies, and flags pageProps that hand an anonymous caller tokens, secrets, password hashes or personal data for many records. Runs only when probing is active or aggressive.",
    solution:
      "Return only what the page renders from getServerSideProps and getStaticProps. Pick fields explicitly instead of passing a whole database row or session object as props, because everything in props is serialized into the HTML and into the /_next/data file for anyone to read. Keep tokens, secrets and other users' data on the server, and rotate any secret that was served. This check sees only what an anonymous request gets back, so test authorization with two accounts as well.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 7,
    checks: [
      { name: CHECK_SENSITIVE, outcome: "problem" },
      { name: CHECK_BULK_PII, outcome: "problem" },
      {
        name: CHECK_CLEAN,
        outcome: "clean",
        clears: [CHECK_SENSITIVE, CHECK_BULK_PII],
      },
      { name: CHECK_CLEAN, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];

    if (!ctx.probe || ctx.probe.level === "passive") {
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: "probing-passive",
        message:
          "Probing is passive, so no Next.js data file was requested. Run with --probe active to check pageProps for sensitive data.",
      });
      return { checks };
    }

    const selection = selectNextDataCandidates(ctx);
    const details = {
      nextPages: selection.nextPages,
      skippedRobots: selection.skippedRobots,
      skippedCap: selection.skippedCap,
    };
    const leftOut = selection.skippedRobots + selection.skippedCap;
    if (selection.candidates.length === 0 && leftOut > 0) {
      // Server-rendered pages were found but none of their data files may be
      // requested: that is not checked, not "no Next.js page".
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: PROBE_INCOMPLETE_SKIP_REASON,
        message: `Not checked: robots.txt disallows the data file(s) of ${selection.skippedRobots} server-rendered Next.js page(s), so nothing was requested. Run with --probe aggressive to request them anyway`,
        value: "not-checked",
        details,
      });
      return { checks };
    }
    if (selection.candidates.length === 0) {
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: "no-next-data",
        message:
          "Not checked: no crawled page is a server-rendered Next.js page with a readable buildId, so nothing was requested",
        details,
      });
      return { checks };
    }

    let probed = 0;
    let errored = 0;
    let serverErrors = 0;
    let truncated = 0;
    let jsonAnswers = 0;
    let notJson = 0;
    let budgetStopped = false;
    let pushback = false;
    let flagged = 0;

    for (const candidate of selection.candidates) {
      const outcome = await sendJsonProbe(ctx.probe, candidate.url);
      if (!outcome.sent) {
        budgetStopped = true;
        break;
      }
      probed++;
      if ("error" in outcome) {
        errored++;
        continue;
      }
      const { response } = outcome;
      const reply = {
        status: response.status,
        headers: response.headers,
        text: response.body,
      };
      if (isThrottledOrChallenged(reply)) {
        pushback = true;
        break;
      }
      if (isUnverifiedReply(reply)) {
        serverErrors++;
        continue;
      }
      // A body over the read cap cannot be parsed, so it is not judged.
      if (response.truncated) {
        truncated++;
        continue;
      }
      // A 404 (stale buildId), a redirect or an HTML page says nothing about
      // the props, so the file is not verified.
      const scan = scanNextDataResponse(response, candidate.url);
      if (!scan) {
        notJson++;
        continue;
      }
      jsonAnswers++;
      const meta = {
        endpoint: candidate.url,
        page: candidate.page,
        status: response.status,
        ...(scan.walkTruncated ? { walkTruncated: true } : {}),
      };

      if (scan.sensitive.length > 0) {
        flagged++;
        const kinds = [...new Set(scan.sensitive.map((f) => f.kind))];
        const more =
          kinds.length > 4 ? ` and ${kinds.length - 4} more kind(s)` : "";
        checks.push({
          name: CHECK_SENSITIVE,
          status: "fail",
          message: `${candidate.url} carries ${kinds.slice(0, 4).join(", ")}${more} in pageProps, readable without credentials`,
          items: sensitiveItems(candidate.url, scan.sensitive),
          details: { ...meta, fields: scan.sensitive.length },
        });
      }

      if (isBulkPii(scan.pii)) {
        flagged++;
        const items: CheckItem[] = (
          scan.pii.paths.length > 0 ? scan.pii.paths : ["pageProps"]
        ).map((path) => ({
          id: `${candidate.url} ${path}`,
          label: path,
          snippet: `${path} = <redacted>`,
          meta: { endpoint: candidate.url, path },
        }));
        checks.push({
          name: CHECK_BULK_PII,
          status: "warn",
          message: `${candidate.url} carries personal data for many records in pageProps, readable without credentials: ${piiSummary(scan.pii)}`,
          items,
          details: {
            ...meta,
            distinctEmails: scan.pii.distinctEmails,
            distinctPhones: scan.pii.distinctPhones,
            personalRecords: scan.pii.personalRecords,
            privilegeFields: scan.pii.privilegeFields,
          },
        });
      }
    }

    if (probed === 0) {
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: "probe-budget",
        message:
          "The probe budget ran out before any Next.js data file was requested",
        details,
      });
      return { checks };
    }

    const total = selection.candidates.length;
    const verified =
      probed -
      errored -
      serverErrors -
      truncated -
      notJson -
      (pushback ? 1 : 0);
    // Data files left out by the per-run cap or by robots.txt were never read,
    // so they count as not verified, never as clean.
    const unverified = total - verified + leftOut;
    const runDetails = {
      ...details,
      probed,
      jsonAnswers,
      notJson,
      errored,
      serverErrors,
      truncated,
      pushback,
      budgetStopped,
      verified,
      unverified,
    };
    if (unverified > 0) {
      const why: string[] = [];
      if (pushback)
        why.push(
          `the site throttled the requests (HTTP 429) or answered with a bot challenge after ${probed} of ${total} data file(s), so no further request was sent`
        );
      if (budgetStopped)
        why.push(
          `the probe budget ran out after ${probed} of ${total} data file(s)`
        );
      if (errored > 0)
        why.push(
          `${errored} request(s) failed with a network error or timeout`
        );
      if (serverErrors > 0)
        why.push(
          `${serverErrors} data file(s) answered with a server error (5xx)`
        );
      if (truncated > 0)
        why.push(`${truncated} data file(s) were too large to read in full`);
      if (notJson > 0)
        why.push(
          `${notJson} data file(s) did not answer with JSON pageProps (a 404, a redirect or an HTML page, for example after a redeploy changed the buildId)`
        );
      if (selection.skippedCap > 0)
        why.push(
          `${selection.skippedCap} more data file(s) were not requested because the rule requests at most ${MAX_NEXT_DATA_PAGES} per run`
        );
      if (selection.skippedRobots > 0)
        why.push(
          `${selection.skippedRobots} data file(s) were not requested because robots.txt disallows them (run with --probe aggressive to request them)`
        );
      const onlyBudget =
        budgetStopped &&
        !pushback &&
        errored === 0 &&
        serverErrors === 0 &&
        truncated === 0 &&
        notJson === 0 &&
        leftOut === 0;
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: onlyBudget ? "probe-budget" : PROBE_INCOMPLETE_SKIP_REASON,
        message: `Next.js data files check incomplete: ${why.join("; ")}. ${unverified} of ${total + leftOut} data file(s) were not verified and may be leaking`,
        value: "not-checked",
        details: runDetails,
      });
    } else if (flagged === 0) {
      checks.push({
        name: CHECK_CLEAN,
        status: "pass",
        message: `No Next.js data file carried sensitive fields or bulk personal data in pageProps (${probed} requested, ${jsonAnswers} answered with JSON)`,
        details: runDetails,
      });
    }
    return { checks };
  },
};
