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
//  - The buildId comes from the crawled page's own `__NEXT_DATA__` script, and
//    only for a page that script marks as server-rendered (`gssp` or `gsp`),
//    since an auto-exported page has no data file. No path is guessed.
//  - Same origin as the audited base URL, checked again here.
//  - Not disallowed by robots.txt, unless the run is aggressive.
//  - At most MAX_NEXT_DATA_PAGES pages per run, one GET each, no cookies, no
//    redirects followed, through the shared probe budget and the JSON probe's
//    capped reader.
//
// What is flagged is what security/json-sensitive-fields flags, using the same
// walker and secret matchers, applied to `pageProps`: a credential is a fail,
// bulk personal data a warn. Values never reach the report.
//
// Not checked is never clean (#1920): a throttle, bot challenge, 5xx, timeout,
// an answer over the read cap or an exhausted budget leaves the run not checked.

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

export interface NextDataCandidate {
  /** The crawled page the data file belongs to. */
  page: string;
  /** The `_next/data` URL requested. */
  url: string;
  buildId: string;
}

export interface NextDataSelection {
  candidates: NextDataCandidate[];
  skippedRobots: number;
  skippedCap: number;
  /** Crawled pages carrying a `__NEXT_DATA__` script, server-rendered or not. */
  nextPages: number;
}

type SitePage = NonNullable<RuleContext["site"]>["pages"][number];

/** buildId of a page whose props are server-rendered, or null. */
export function readServerRenderedBuildId(page: SitePage): string | null {
  const doc = page.parsed?.document;
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
  return id;
}

/** `/` becomes `/index.json`, `/blog/post/` becomes `/blog/post.json`. */
export function nextDataPath(pathname: string, buildId: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return `/_next/data/${buildId}${trimmed === "" ? "/index" : trimmed}.json`;
}

function isNextInternalPath(pathname: string): boolean {
  return pathname === "/_next" || pathname.startsWith("/_next/");
}

/** The data files the rule may request, in crawl order. Pure: sends nothing. */
export function selectNextDataCandidates(
  ctx: Pick<RuleContext, "site" | "probe">
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
  const seen = new Set<string>();

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
    const buildId = readServerRenderedBuildId(page);
    if (buildId === null) continue;
    selection.nextPages++;
    const url = `${u.origin}${nextDataPath(u.pathname, buildId)}`;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!aggressive && isRobotsTxtDisallowed(url, robotsTxt, "*")) {
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
      const scan = scanNextDataResponse(response, candidate.url);
      if (!scan) continue;
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
      probed - errored - serverErrors - truncated - (pushback ? 1 : 0);
    const unverified = total - verified;
    const runDetails = {
      ...details,
      probed,
      jsonAnswers,
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
      const onlyBudget =
        budgetStopped &&
        !pushback &&
        errored === 0 &&
        serverErrors === 0 &&
        truncated === 0;
      checks.push({
        name: CHECK_CLEAN,
        status: "skipped",
        skipReason: onlyBudget ? "probe-budget" : PROBE_INCOMPLETE_SKIP_REASON,
        message: `Next.js data files check incomplete: ${why.join("; ")}. ${unverified} of ${total} data file(s) were not verified and may be leaking`,
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
