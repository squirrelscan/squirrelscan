// security/directory-listing - open directory listings in the folders that hold
// the site's assets (#2336)
//
// A loud probing rule: it requests a handful of folder URLs, so it runs only on
// an aggressive run (`--probe aggressive` or `--pentest`). Below aggressive, or
// with no `ctx.probe`, it sends nothing and reports a not-checked line.
//
// Which folders. The immediate parent folder of every same-origin stylesheet,
// script, image and font the crawl referenced (`site.scripts`,
// `site.resourceSizes`), deduplicated, ordered shallowest first and capped at
// MAX_LISTING_FOLDERS. The site root is never probed (it is the home page). A
// folder URL is built from the audited origin plus the asset's path, so no
// request leaves the origin, and a redirect is never followed.
//
// What is sent: one GET to a random folder that cannot exist (the baseline),
// then one GET per folder, each admitted by the shared probe budget, with its
// own timeout and a read capped at LISTING_READ_CAP bytes after decoding.
//
// What counts as a hit: a 200 whose body the shared classifier
// (directory-listing-classifier.ts) reads as an Apache, nginx, IIS or Tomcat
// autoindex page with several file rows. A catch-all (SPA shell, themed 404
// served with 200) has no such rows and is never a hit; a hit is also dropped
// when the baseline folder answered with a listing or with the same bytes.
//
// Stops: a 429 or bot challenge stops the run at once; so does the budget
// running out. Hits already confirmed are still reported.

import {
  PROBE_INCOMPLETE_SKIP_REASON,
  PROBE_LEVEL_TOO_LOW_SKIP_REASON,
} from "@squirrelscan/core-contracts";
import { clampItemId } from "@squirrelscan/core-contracts/clamp";
import { SQUIRRELSCAN_USER_AGENT } from "@squirrelscan/utils/constants";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { hasRequestTool } from "../tools";
import {
  classifyDirectoryListing,
  type DirectoryListing,
} from "./directory-listing-classifier";
import { isThrottledOrChallenged, readCappedBytes } from "./probe-http";

const CHECK = "directory-listing";
const CLEAN = "directory-listing-none";
const NOT_CHECKED = "directory-listing-not-checked";
const INCOMPLETE = "directory-listing-incomplete";

/** Folders probed per audit, after deduplication. */
export const MAX_LISTING_FOLDERS = 20;
/** Per-request timeout, on top of the shared probe budget's deadline. */
export const LISTING_PROBE_TIMEOUT_MS = 10_000;
/** Decoded bytes read from one answer. */
export const LISTING_READ_CAP = 64 * 1024;
/** Longest folder path probed. */
const MAX_FOLDER_PATH_CHARS = 256;

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

/**
 * The folder paths to probe: the parent folder of each same-origin asset URL,
 * deduplicated, shallowest first (then alphabetical, so the cap is stable) and
 * at most `cap`. Never the root, and never a URL on another origin.
 */
export function selectListingFolders(
  origin: string,
  assetUrls: Iterable<string>,
  cap: number = MAX_LISTING_FOLDERS
): string[] {
  const folders = new Set<string>();
  for (const raw of assetUrls) {
    let u: URL;
    try {
      u = new URL(raw, `${origin}/`);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    const slash = u.pathname.lastIndexOf("/");
    if (slash <= 0) continue;
    const folder = u.pathname.slice(0, slash + 1);
    if (folder === "/" || folder.length > MAX_FOLDER_PATH_CHARS) continue;
    folders.add(folder);
  }
  const depth = (p: string) => p.split("/").length;
  return [...folders]
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, Math.max(0, cap));
}

function assetUrlsOf(ctx: RuleContext): string[] {
  const site = ctx.site;
  if (!site) return [];
  const urls: string[] = [];
  for (const s of site.scripts ?? []) urls.push(s.url);
  const sizes = site.resourceSizes;
  for (const r of sizes?.css ?? []) urls.push(r.url);
  for (const r of sizes?.images ?? []) urls.push(r.url);
  for (const r of sizes?.fonts ?? []) urls.push(r.url);
  return urls;
}

/** The exact URL and init for one probe. Exported so tests can pin what is sent. */
export function buildListingProbe(
  origin: string,
  folderPath: string
): { url: string; init: RequestInit } {
  // Set the path rather than resolving it: a folder such as `//wp-content/`
  // would otherwise resolve as a network-path reference to another host.
  const url = new URL(origin);
  url.pathname = folderPath;
  if (url.origin !== origin)
    throw new Error("directory-listing: probe left the audited origin");
  url.search = "";
  url.hash = "";
  return {
    url: url.href,
    init: {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      headers: {
        Accept: "text/html,*/*;q=0.5",
        "User-Agent": SQUIRRELSCAN_USER_AGENT,
      },
    },
  };
}

interface Answer {
  status: number;
  headers: Headers;
  text: string;
}

type Outcome =
  | { kind: "not-allowed" }
  | { kind: "error" }
  | { kind: "answer"; url: string; answer: Answer };

async function sendProbe(
  ctx: RuleContext,
  origin: string,
  folderPath: string
): Promise<Outcome> {
  const probe = ctx.probe;
  if (!probe || !probe.allows("loud")) return { kind: "not-allowed" };
  const done = new AbortController();
  const signal = AbortSignal.any([
    probe.signal(),
    AbortSignal.timeout(LISTING_PROBE_TIMEOUT_MS),
    done.signal,
  ]);
  try {
    // A path that cannot be probed is one failed probe, not a rule error that
    // would drop the listings already found.
    const { url, init } = buildListingProbe(origin, folderPath);
    probe.record();
    const res = await fetchUndecoded(url, { ...init, signal });
    const { bytes } = await readCappedBytes(res, LISTING_READ_CAP);
    return {
      kind: "answer",
      url,
      answer: {
        status: res.status,
        headers: res.headers,
        text: new TextDecoder().decode(bytes),
      },
    };
  } catch {
    return { kind: "error" };
  } finally {
    done.abort();
  }
}

function randomBaselineFolder(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `/squirrelscan-baseline-${hex}/`;
}

interface Hit {
  url: string;
  path: string;
  listing: DirectoryListing;
}

function hitCheck(hits: Hit[]): CheckResult {
  const urls = hits.map((h) => h.url);
  return {
    name: CHECK,
    status: "warn",
    message: `${hits.length} folder(s) list their files to anyone: ${urls.join(", ")}`,
    items: hits.map((h) => ({
      id: clampItemId(h.url),
      label: `${h.url}: ${h.listing.server} directory listing${h.listing.files.length > 0 ? `, showing ${h.listing.files.join(", ")}` : ""}`,
      meta: {
        path: h.path,
        server: h.listing.server,
        rows: h.listing.rows,
        files: h.listing.files,
      },
    })),
    details: { exposed: hits.length, folders: urls },
  };
}

export const directoryListingRule: Rule = {
  meta: {
    id: "security/directory-listing",
    name: "Open Directory Listings",
    description:
      "Requests the parent folders of the stylesheets, scripts, images and fonts the crawl found, and flags each folder where the server shows an Apache, nginx, IIS or Tomcat file index instead of refusing. A hit needs the server's own index markup and several file rows, not just a 200. Runs only when probing is aggressive.",
    solution:
      "Turn directory indexes off. nginx: remove `autoindex on;` (or set `autoindex off;`) for the location. Apache: `Options -Indexes` in the vhost or .htaccess. IIS: disable Directory Browsing in the site's settings. Tomcat: set the DefaultServlet `listings` parameter to false in web.xml. Then check what the listing showed: if a backup, source map, dump or private file sat in the folder, remove it and treat its contents as leaked.",
    category: "security",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    weight: 5,
    checks: [
      { name: CHECK, outcome: "problem" },
      { name: CLEAN, outcome: "clean", clears: [CHECK] },
      { name: NOT_CHECKED, outcome: "skipped" },
      { name: INCOMPLETE, outcome: "skipped" },
    ],
  },

  async run(ctx: RuleContext): Promise<RuleResult> {
    const level = ctx.probe?.level ?? "passive";
    if (level !== "aggressive") {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            skipReason: PROBE_LEVEL_TOO_LOW_SKIP_REASON,
            message: `Directory listings not checked: probing is ${level}, and this rule only probes at aggressive.`,
            value: "not-checked",
            details: { probeLevel: level, requiredLevel: "aggressive" },
          },
        ],
      };
    }
    if (!hasRequestTool()) {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            skipReason: "analyze-offline",
            message:
              "Directory listings not checked: analyze runs offline; run `squirrel audit` to probe",
            value: "not-checked",
          },
        ],
      };
    }
    const origin = siteOrigin(ctx.site?.baseUrl);
    if (!origin) {
      return {
        checks: [
          { name: NOT_CHECKED, status: "skipped", message: "Invalid base URL" },
        ],
      };
    }

    const folders = selectListingFolders(origin, assetUrlsOf(ctx));
    if (folders.length === 0) {
      return {
        checks: [
          {
            name: NOT_CHECKED,
            status: "skipped",
            skipReason: "no-asset-folders",
            message:
              "Directory listings not checked: the crawl found no same-origin asset in a folder to probe",
            value: "not-checked",
          },
        ],
      };
    }

    let stopped: "budget" | "pushback" | null = null;
    let probed = 0;
    let errored = 0;
    let serverErrors = 0;
    let baselineText: string | null = null;

    const baselineOutcome = await sendProbe(
      ctx,
      origin,
      randomBaselineFolder()
    );
    if (baselineOutcome.kind === "not-allowed") stopped = "budget";
    else if (baselineOutcome.kind === "answer") {
      if (isThrottledOrChallenged(baselineOutcome.answer)) stopped = "pushback";
      else if (
        baselineOutcome.answer.status >= 200 &&
        baselineOutcome.answer.status < 300
      )
        baselineText = baselineOutcome.answer.text;
    }
    // A server that lists a folder that cannot exist is not telling us about
    // our folders: nothing can be concluded from a listing it gives.
    const baselineIsListing =
      baselineText !== null && classifyDirectoryListing(baselineText) !== null;

    const hits: Hit[] = [];
    if (!stopped && !baselineIsListing) {
      for (const path of folders) {
        const outcome = await sendProbe(ctx, origin, path);
        if (outcome.kind === "not-allowed") {
          stopped = "budget";
          break;
        }
        probed++;
        if (outcome.kind === "error") {
          errored++;
          continue;
        }
        const { answer, url } = outcome;
        if (isThrottledOrChallenged(answer)) {
          stopped = "pushback";
          break;
        }
        if (answer.status >= 500) {
          serverErrors++;
          continue;
        }
        if (answer.status !== 200) continue;
        if (baselineText !== null && answer.text === baselineText) continue;
        const listing = classifyDirectoryListing(answer.text);
        if (listing) hits.push({ url, path, listing });
      }
    }

    const checks: CheckResult[] = [];
    if (hits.length > 0) checks.push(hitCheck(hits));

    const total = folders.length;
    const unverified = baselineIsListing
      ? total
      : total -
        (probed -
          errored -
          serverErrors -
          (stopped === "pushback" && probed > 0 ? 1 : 0));
    const runDetails = {
      folders: total,
      probed,
      errored,
      serverErrors,
      exposed: hits.length,
      unverified,
    };

    if (unverified > 0) {
      const why: string[] = [];
      if (baselineIsListing)
        why.push(
          "the server showed a file index for a folder that does not exist, so a listing proves nothing about the real folders"
        );
      if (stopped === "pushback")
        why.push(
          `the site throttled the probes (HTTP 429) or answered with a bot challenge after ${probed} of ${total} folder(s), so no further request was sent`
        );
      if (stopped === "budget")
        why.push(
          `the probe budget ran out after ${probed} of ${total} folder(s)`
        );
      if (errored > 0)
        why.push(`${errored} probe(s) failed with a network error or timeout`);
      if (serverErrors > 0)
        why.push(
          `${serverErrors} folder(s) answered with a server error (5xx)`
        );
      checks.push({
        name: INCOMPLETE,
        status: "skipped",
        skipReason: PROBE_INCOMPLETE_SKIP_REASON,
        message: `Directory listing check incomplete: ${why.join("; ")}. ${unverified} of ${total} folder(s) were not verified and may list their files`,
        value: "not-checked",
        details: {
          ...runDetails,
          stoppedBy: baselineIsListing
            ? "catch-all-listing"
            : (stopped ?? (errored > 0 ? "errors" : "server-errors")),
        },
      });
      return { checks };
    }

    if (hits.length === 0) {
      checks.push({
        name: CLEAN,
        status: "pass",
        message: `None of the ${total} asset folder(s) probed lists its files`,
        details: runDetails,
      });
    }
    return { checks };
  },
};
