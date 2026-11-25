// security/sitemap-sensitive-urls - sensitive or internal looking URLs a
// sitemap names that actually answer
//
// A sitemap is a public, machine-readable list. Entries such as /admin/,
// /staging/ or /backup/ tell anyone where to look. A sensitive-looking path is
// only a finding when it resolves, so each one is probed and a 404, a
// redirect, a login wall (401, 403) or a soft 404 is dropped.
//
// A probing rule: it runs its probes only when the probing intensity allows
// it (`ctx.probe`, see probe-budget.ts). Reading the sitemap entries sends
// nothing, so a sitemap with no sensitive-looking entry passes on any level.
//
// What may be probed, all enforced by `selectSensitiveEntries`:
//  - Same origin as the audited base URL (scheme, host and port).
//  - A path with a whole segment from SENSITIVE_WORDS.
//  - Not disallowed by robots.txt, unless the run is aggressive.
//  - At most MAX_SENSITIVE_PROBES URLs, one GET each.
//
// What is sent: GET, no cookies, no Authorization, no redirect following. At
// most PROBE_BODY_CAP decoded bytes are read. One extra GET to a random
// path on the origin shows whether the site answers 200 for everything (a
// single-page app): an entry whose answer matches it is not reported.

import { PROBE_INCOMPLETE_SKIP_REASON } from "@squirrelscan/core-contracts";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { isRobotsTxtDisallowed } from "@squirrelscan/utils/robots-txt";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import {
  ANONYMOUS_GET_TIMEOUT_MS,
  isUnverifiedReply,
  readCapped,
} from "./probe-http";

export const SITEMAP_SENSITIVE_URLS_RULE_ID = "security/sitemap-sensitive-urls";

const CHECK_PROBLEM = "sitemap-sensitive-urls";
const CHECK_CLEAN = "sitemap-sensitive-urls-clean";
const CHECK_SKIPPED = "sitemap-sensitive-urls-not-checked";

/** URLs probed per run, the soft-404 canary excluded. */
export const MAX_SENSITIVE_PROBES = 10;
/** Decoded response bytes read per probe. */
export const PROBE_BODY_CAP = 8 * 1024;
/** Sitemaps named per reachable URL. */
const MAX_SITEMAPS_PER_URL = 3;
/** Longest URL examined, so one hostile entry cannot bloat a finding. */
const MAX_URL_CHARS = 2048;

/**
 * Whole path segments that mark a URL as sensitive. A segment is matched
 * whole, so a slug that merely contains a word (`/blog/draft-post-staging`,
 * `/admin-tools`) is an ordinary content page, not a sensitive one.
 */
export const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "staging",
  "draft",
  "drafts",
  "preview",
  "backup",
  "backups",
  "internal",
  "private",
  "uat",
  "debug",
]);

/** The path segments that are sensitive words, in order, deduped. */
export function sensitiveWords(pathname: string): string[] {
  const found: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw === "") continue;
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // Keep the raw segment when it is not valid percent-encoding.
    }
    const word = segment.toLowerCase();
    if (SENSITIVE_WORDS.has(word) && !found.includes(word)) found.push(word);
  }
  return found;
}

export interface SensitiveEntry {
  url: string;
  words: string[];
  /** Sitemaps that list the URL (capped). */
  sitemaps: string[];
}

export interface SensitiveSelection {
  entries: SensitiveEntry[];
  /** Sensitive-looking entries on the audited origin, before the cap and robots filter. */
  total: number;
  skippedRobots: number;
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

/** The sensitive-looking same-origin sitemap entries this rule may probe. Pure: sends nothing. */
export function selectSensitiveEntries(
  ctx: Pick<RuleContext, "site" | "probe">
): SensitiveSelection {
  const sel: SensitiveSelection = {
    entries: [],
    total: 0,
    skippedRobots: 0,
    skippedCap: 0,
  };
  const baseUrl = ctx.site?.baseUrl;
  const siteOrigin = baseUrl ? originOf(baseUrl) : null;
  if (!siteOrigin) return sel;
  const aggressive = ctx.probe?.level === "aggressive";
  const robotsTxt = ctx.site?.robotsTxt ?? null;
  const byUrl = new Map<string, SensitiveEntry>();

  for (const sitemap of ctx.site?.sitemaps?.discovered ?? []) {
    for (const entry of sitemap.urls) {
      if (typeof entry.loc !== "string" || entry.loc.length > MAX_URL_CHARS)
        continue;
      let u: URL;
      try {
        u = new URL(entry.loc.trim());
      } catch {
        continue;
      }
      if (originOf(u.href) !== siteOrigin || u.username || u.password) continue;
      u.hash = "";
      const words = sensitiveWords(u.pathname);
      if (words.length === 0) continue;
      const existing = byUrl.get(u.href);
      if (existing) {
        if (
          existing.sitemaps.length < MAX_SITEMAPS_PER_URL &&
          !existing.sitemaps.includes(sitemap.url)
        )
          existing.sitemaps.push(sitemap.url);
        continue;
      }
      byUrl.set(u.href, { url: u.href, words, sitemaps: [sitemap.url] });
    }
  }

  sel.total = byUrl.size;
  for (const entry of byUrl.values()) {
    if (!aggressive && isRobotsTxtDisallowed(entry.url, robotsTxt, "*")) {
      sel.skippedRobots++;
      continue;
    }
    if (sel.entries.length >= MAX_SENSITIVE_PROBES) {
      sel.skippedCap++;
      continue;
    }
    sel.entries.push(entry);
  }
  return sel;
}

// ── sending ─────────────────────────────────────────────────────────

interface Answer {
  status: number;
  body: string;
  headers: Headers;
}

type Outcome =
  | { kind: "answer"; answer: Answer }
  | { kind: "error" }
  | { kind: "not-sent" };

/** The init for every probe. Exported so tests can pin what is sent. */
export function buildProbeInit(): RequestInit {
  return {
    method: "GET",
    credentials: "omit",
    redirect: "manual",
    headers: {
      Accept: "text/html, */*;q=0.1",
      "User-Agent": SQUIRRELSCAN_USER_AGENT,
    },
  };
}

async function send(ctx: RuleContext, url: string): Promise<Outcome> {
  const probe = ctx.probe;
  if (!probe || !probe.allows("quiet")) return { kind: "not-sent" };
  probe.record();
  const done = new AbortController();
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(ANONYMOUS_GET_TIMEOUT_MS),
    done.signal,
  ]);
  try {
    const res = await fetchUndecoded(url, { ...buildProbeInit(), signal });
    const { text } = await readCapped(res, PROBE_BODY_CAP);
    return {
      kind: "answer",
      answer: { status: res.status, body: text, headers: res.headers },
    };
  } catch {
    return { kind: "error" };
  } finally {
    done.abort();
  }
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function canaryUrl(origin: string): string {
  const token = Math.random().toString(36).slice(2, 12);
  return `${origin}/squirrelscan-canary-${token}`;
}

export const sitemapSensitiveUrlsRule: Rule = {
  meta: {
    id: SITEMAP_SENSITIVE_URLS_RULE_ID,
    name: "Sitemap Sensitive URLs",
    description:
      "Reads the sitemap entries the crawl fetched, picks the same-origin URLs whose path looks sensitive or internal (admin, staging, draft, preview, backup, internal and similar), probes each with a GET that carries no credentials, and reports the ones that answer. Runs its probes only when probing is active or aggressive.",
    solution:
      "Remove admin, staging, draft, preview, backup and internal URLs from the sitemap: a sitemap is public and advertises every entry. Then make sure the pages are not reachable by anyone: put them behind authentication or an IP allowlist, or take them off the production server. Robots.txt and noindex hide a page from search engines only; they do not protect it.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 5,
    checks: [
      { name: CHECK_PROBLEM, outcome: "problem" },
      { name: CHECK_CLEAN, outcome: "clean", clears: [CHECK_PROBLEM] },
      { name: CHECK_SKIPPED, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const checks: CheckResult[] = [];
    const sitemaps = ctx.site?.sitemaps;
    if (!sitemaps || sitemaps.discovered.length === 0) {
      checks.push({
        name: CHECK_SKIPPED,
        status: "skipped",
        skipReason: "no-sitemap",
        message: "No sitemap was read, so no entry was checked",
      });
      return { checks };
    }

    const selection = selectSensitiveEntries(ctx);
    const details = {
      sensitiveEntries: selection.total,
      skippedRobots: selection.skippedRobots,
      skippedCap: selection.skippedCap,
    };
    const siteOrigin = originOf(ctx.site?.baseUrl ?? "");
    const sitemapComplete =
      sitemaps.truncated !== true &&
      (sitemaps.readState === undefined || sitemaps.readState === "complete");

    if (selection.total === 0) {
      if (sitemapComplete) {
        checks.push({
          name: CHECK_CLEAN,
          status: "pass",
          message: "No sitemap entry has a sensitive or internal looking path",
          details,
        });
      } else {
        checks.push({
          name: CHECK_SKIPPED,
          status: "skipped",
          skipReason: PROBE_INCOMPLETE_SKIP_REASON,
          message:
            "The sitemaps were only partly read, and none of the entries read has a sensitive looking path. The rest were not checked",
          details,
        });
      }
      return { checks };
    }

    if (!ctx.probe || ctx.probe.level === "passive") {
      checks.push({
        name: CHECK_SKIPPED,
        status: "skipped",
        skipReason: "probing-passive",
        message: `${selection.total} sitemap entr${selection.total === 1 ? "y has" : "ies have"} a sensitive or internal looking path, but probing is passive, so none was requested. Run with --probe active to check which ones answer.`,
        details,
      });
      return { checks };
    }

    if (selection.entries.length === 0 || !siteOrigin) {
      checks.push({
        name: CHECK_SKIPPED,
        status: "skipped",
        skipReason: "robots-disallowed",
        message: `${selection.total} sensitive looking sitemap entr${selection.total === 1 ? "y is" : "ies are"} disallowed by robots.txt, so none was requested`,
        details,
      });
      return { checks };
    }

    // The canary says whether the site answers 200 for any path.
    const canary = await send(ctx, canaryUrl(siteOrigin));
    const canaryBody =
      canary.kind === "answer" && is2xx(canary.answer.status)
        ? canary.answer.body
        : undefined;

    const reachable: Array<{ entry: SensitiveEntry; status: number }> = [];
    let probed = 0;
    let errored = 0;
    let unverified = 0;
    let budgetStopped = false;
    let pushback = false;
    for (const entry of selection.entries) {
      if (pushback) break;
      const out = await send(ctx, entry.url);
      if (out.kind === "not-sent") {
        budgetStopped = true;
        break;
      }
      probed++;
      if (out.kind === "error") {
        errored++;
        continue;
      }
      const { answer } = out;
      const reply = {
        status: answer.status,
        headers: answer.headers,
        text: answer.body,
      };
      if (isUnverifiedReply(reply)) {
        unverified++;
        if (answer.status === 429) pushback = true;
        continue;
      }
      // 3xx, 401, 403 and 404 are protected or absent. A 2xx that matches the
      // site's answer for a random path is a catch-all page, not the entry.
      if (!is2xx(answer.status)) continue;
      if (canaryBody !== undefined && answer.body === canaryBody) continue;
      reachable.push({ entry, status: answer.status });
    }

    const runDetails = {
      ...details,
      probed,
      errored,
      unverified,
      budgetStopped,
      pushback,
    };

    if (reachable.length > 0) {
      checks.push({
        name: CHECK_PROBLEM,
        status: "fail",
        message: `${reachable.length} sensitive or internal looking URL${reachable.length === 1 ? "" : "s"} listed in the sitemap answer without credentials`,
        items: reachable.map(({ entry, status }) => ({
          id: entry.url,
          label: entry.url,
          meta: {
            url: entry.url,
            status,
            words: entry.words,
            sitemaps: entry.sitemaps,
          },
        })),
        details: { ...runDetails, reachable: reachable.length },
      });
    }

    const notChecked =
      selection.total - probed + errored + unverified + selection.skippedRobots;
    if (reachable.length === 0) {
      if (probed === 0 || errored === probed) {
        checks.push({
          name: CHECK_SKIPPED,
          status: "skipped",
          skipReason: probed === 0 ? "probe-budget" : "probe-errors",
          message:
            probed === 0
              ? "The probe budget ran out before any sitemap entry was probed"
              : `Every probe failed with a network error or timeout (${probed} URL(s)), so nothing was checked`,
          details: runDetails,
        });
      } else if (notChecked > 0 || !sitemapComplete) {
        checks.push({
          name: CHECK_SKIPPED,
          status: "skipped",
          skipReason: PROBE_INCOMPLETE_SKIP_REASON,
          message: `Sitemap URL check incomplete: ${probed} of ${selection.total} sensitive looking entries were probed and none answered; the rest were not checked (robots.txt, the probe cap, the budget, throttling or errors)`,
          value: "not-checked",
          details: runDetails,
        });
      } else {
        checks.push({
          name: CHECK_CLEAN,
          status: "pass",
          message: `None of the ${probed} sensitive looking sitemap URL(s) answered without credentials`,
          details: runDetails,
        });
      }
    }
    return { checks };
  },
};
