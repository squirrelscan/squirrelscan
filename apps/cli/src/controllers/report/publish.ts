/**
 * Report publishing controller - publishes audit reports to reports.squirrelscan.com
 */

import type { ResolutionSignal } from "@squirrelscan/core-contracts";

import { computeLockedRules } from "@squirrelscan/audit-engine";
import {
  REPORT_LIMITS,
  PUBLISH_LIMITS,
  PUBLISH_DEGRADE_LIMITS,
} from "@squirrelscan/core-contracts/limits";
import {
  buildResolutionSignal,
  clampReportPagesToBudget,
  degradeAndRebuild,
  foldOverflowChecks,
  sampleChecksForPublish,
  DEFAULT_PUBLISH_SAMPLE,
  type PublishSampleLimits,
} from "@squirrelscan/rules";
import { byteLength } from "@squirrelscan/utils/bytes";
import { Effect } from "effect";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { AuditReport, CheckResult } from "@/types";

import { type Result, ok, err, commandError } from "@/controllers/types";
import { getGlobalContentStore } from "@/crawler/storage/content-store";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { cliApi } from "@/lib/api-client";
import { teamPlanRequiredMessage } from "@/lib/plan-messages";
import {
  API_TOKEN_ENV_VAR,
  envTokenRejectedMessage,
  resolveCredential,
} from "@/self/credentials";
import { getProjectsPath } from "@/self/paths";

import { version } from "../../../package.json";

// Cloud-/Pro-gated rules that produced no real result this run — the report's
// "locked" Pro upsell. Single implementation in audit-engine (#656 de-duped the
// old vendored twin here): its duck-typed report parameter is satisfied
// structurally by the CLI's AuditReport, so this is a plain re-export.
export { computeLockedRules };

export type ReportVisibility = "public" | "unlisted" | "private";

export interface PublishOptions {
  visibility?: ReportVisibility;
  // Pre-registered audit linkage (epic #271). When a signed-in run registered a
  // skeleton audit at start, publish passes that audit's id (+ the agent_run id
  // and website id) so the server UPDATES the existing audit in place instead of
  // minting a duplicate, and keeps it on the registered website. Absent for
  // unregistered publishes (offline-then-manual, old runs).
  auditId?: string;
  runId?: string;
  websiteId?: string;
  // #1167: surface a non-fatal notice (e.g. the degrade pass clipped detail to
  // fit the publish limit). The audit command passes its `log`; absent → silent.
  onWarn?: (message: string) => void;
}

export interface PublishResult {
  id: string;
  url: string;
  visibility: ReportVisibility;
  createdAt: string;
  // #1179: the server's AUTHORITATIVE post-merge score/counts (it re-merges the
  // published payload against the cross-audit finding store and can differ from
  // the CLI's local pre-publish estimate). The caller stamps these into
  // agent_runs so every surface agrees. Absent from older servers (undefined) →
  // caller falls back to the local report numbers. null score = failed/blocked.
  healthScore?: number | null;
  issuesFound?: number;
  totalPages?: number;
}

interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    issues?: Array<{ path: string; message: string }>;
    threats?: Array<{
      path: string;
      value: string;
      pattern: string;
      category: string;
    }>;
  };
}

interface ApiSuccessResponse {
  id: string;
  url: string;
  visibility: string;
  createdAt: string;
  // #1179: present on current servers; optional so an older server (or the
  // internal route shape) parses without these into undefined.
  healthScore?: number | null;
  issuesFound?: number;
  totalPages?: number;
}

const PUBLISH_TIMEOUT_MS = 30_000;
const PUBLISH_MAX_ATTEMPTS = 3;

/**
 * Publish an audit report to the API
 */
export async function publishReport(
  report: AuditReport,
  options: PublishOptions = {}
): Promise<Result<PublishResult>> {
  // Resolve credential: SQUIRRELSCAN_API_KEY env (or its SQUIRREL_API_TOKEN
  // alias) → settings.json login session. Local expiry is already enforced
  // for the login token by resolveCredential.
  const credential = resolveCredential();
  if (!credential) {
    return err(
      commandError(
        "NOT_AUTHENTICATED",
        `You must be authenticated to publish reports.\nSet ${API_TOKEN_ENV_VAR} or run 'squirrel auth login'.`
      )
    );
  }

  const visibility = options.visibility ?? "public";

  const maxMB = REPORT_LIMITS.maxPayloadBytes / 1024 / 1024;
  const linkage = {
    // Link to the pre-registered audit (#271) so publish updates that skeleton
    // rather than creating a duplicate DO audit, and keeps it on the registered
    // website. Omitted when not registered.
    ...(options.auditId ? { auditId: options.auditId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.websiteId ? { websiteId: options.websiteId } : {}),
  };
  // #1185: the signal is built from PRE-sample data, so it's identical for the
  // primary and degrade passes — build it once. Rebuilding it inside the
  // degrade pass would redo O(rules × pages) work on exactly the pathological
  // large-site path that triggered the degrade.
  const precomputed = {
    resolutionSignal: buildResolutionSignal(
      report.ruleResults,
      report.pages.map((p) => p.url)
    ),
  };
  const wrapBody = (slimmed: ReturnType<typeof slimForPublish>): string =>
    JSON.stringify({
      report: slimmed,
      visibility,
      ...linkage,
    });

  // Slim the report before publishing — strip bulky data not needed for rendering,
  // then SAMPLE every check to the primary publish caps (#1167). Keep the slimmed
  // report so the degrade pass can re-sample IT harder in place rather than redo
  // the O(rules × pages) slim from scratch.
  const slimmed = slimForPublish(report, undefined, precomputed);
  let body = wrapBody(slimmed);

  // #1167/#1172 degrade pass: with the primary per-check sample caps in place a
  // published report is O(rules × sample_cap) and can't realistically exceed the
  // 20MB gate — but rather than hard-fail an AUTO-publish (the local report already
  // succeeded + printed), re-sample the SLIMMED report with the harder
  // PUBLISH_DEGRADE_LIMITS via the shared helper (worker-agent uses the same one)
  // and warn. Only error if STILL over, which should be unreachable post-caps.
  //
  // Degrading the primary-slimmed report (vs re-slimming the original at the
  // harder caps) is equivalent for every reachable input: pages/items kept are
  // first-N, pagesTruncated is preserved-if-larger, and additional is additive
  // (see degradeAndRebuild). It skips slimForPublish's clampReportPagesToBudget
  // byte backstop on the degrade pass, which is safe: the primary slim already
  // clamped total check pages ≤ its budget and the degrade sample only shrinks
  // them further, so the re-slim can't 413 where this doesn't. The sole
  // divergence is a pathological >budget-of-URLs report where the primary clamp
  // clipped a check below the 25-page degrade cap — there this cites fewer (never
  // more) affected-page URLs, with pagesTruncated carrying the true count. A
  // strictly-safer clip, not a lost signal.
  // #1275: gate on the UTF-8 WIRE size, not `body.length` (UTF-16 code units) —
  // a multi-byte (CJK/emoji) report can exceed maxPayloadBytes in real bytes
  // while its `.length` reads under it, so the degrade pass must key off bytes.
  if (byteLength(body) > REPORT_LIMITS.maxPayloadBytes) {
    degradeAndRebuild(slimmed, PUBLISH_DEGRADE_LIMITS);
    body = wrapBody(slimmed);
    options.onWarn?.(
      `Report detail clipped to fit the ${maxMB}MB publish limit ` +
        `(${PUBLISH_DEGRADE_LIMITS.maxPagesPerCheck} affected pages per finding).`
    );
    if (byteLength(body) > REPORT_LIMITS.maxPayloadBytes) {
      const sizeMB = (byteLength(body) / 1024 / 1024).toFixed(2);
      return err(
        commandError(
          "PAYLOAD_TOO_LARGE",
          `Report size (${sizeMB}MB) exceeds maximum allowed (${maxMB}MB).\nTry reducing the number of pages audited.`
        )
      );
    }
  }

  try {
    // cliApi.fetch keeps publish's transport contract: a hard timeout + retry on
    // CONNECTION errors only (the POST isn't idempotent; HTTP errors never retry).
    // Bespoke status mapping below stays here — publish needs field-level errors.
    const response = await cliApi.fetch(
      "/v1/reports",
      {
        method: "POST",
        headers: cliApi.headers(credential.token),
        body,
      },
      { timeoutMs: PUBLISH_TIMEOUT_MS, retries: PUBLISH_MAX_ATTEMPTS - 1 }
    );

    if (!response.ok) {
      // Handle specific error codes
      if (response.status === 401) {
        // Fail-closed for env-supplied tokens: envTokenRejectedMessage names
        // the actual active env var as authoritative rather than telling the
        // user to log in.
        return err(
          commandError(
            "TOKEN_INVALID",
            credential.source === "env"
              ? envTokenRejectedMessage().replace(/^Error: /, "")
              : "Your authentication token is invalid or revoked.\nRun 'squirrel auth login' to re-authenticate."
          )
        );
      }

      if (response.status === 413) {
        return err(
          commandError(
            "PAYLOAD_TOO_LARGE",
            `Report exceeds maximum allowed size (${maxMB}MB).\nTry reducing the number of pages audited.`
          )
        );
      }

      // #1168: any server 5xx is a server-verifiable failure — classify it with a
      // stable PUBLISH_SERVER_ERROR code (the audit succeeded; the server dropped
      // the publish) so finalize refunds the whole audit. Checked BEFORE the
      // structured-body branch below: a 5xx often carries a JSON `error.code`
      // (e.g. PUBLISH_FAILED) that isn't in the refundable allowlist, so status
      // must win over the body for the refund classification.
      if (response.status >= 500) {
        return err(
          commandError(
            "PUBLISH_SERVER_ERROR",
            `Failed to publish report: ${response.status} ${response.statusText}`
          )
        );
      }

      // Try to parse error response
      let errorData: ApiErrorResponse | undefined;
      try {
        errorData = (await response.json()) as ApiErrorResponse;
      } catch {
        // Ignore parse errors
      }

      if (errorData?.error) {
        const error = errorData.error;

        // Handle security violations specially
        if (error.code === "SECURITY_VIOLATION" && error.threats) {
          const threatSummary = error.threats
            .slice(0, 3)
            .map((t) => `  - ${t.path}: ${t.pattern}`)
            .join("\n");
          return err(
            commandError(
              "SECURITY_VIOLATION",
              `Report contains potentially malicious content:\n${threatSummary}${error.threats.length > 3 ? `\n  ... and ${error.threats.length - 3} more` : ""}`
            )
          );
        }

        // Handle validation errors — surface field-level detail when the
        // server provides it (otherwise the user has no way to self-diagnose)
        if (error.code === "VALIDATION_ERROR") {
          const issueLines = error.issues
            ?.slice(0, 5)
            .map((i) => `  - ${i.path}: ${i.message}`)
            .join("\n");
          return err(
            commandError(
              "VALIDATION_ERROR",
              issueLines
                ? `Report failed server validation:\n${issueLines}`
                : `Report failed server validation: ${error.message}`
            )
          );
        }

        // No active org → public publish 403s (#184); point to the unlisted workaround.
        if (error.code === "NO_ORG") {
          return err(
            commandError(
              "NO_ORG",
              "Publishing a public report requires an active organization.\n" +
                "Use --visibility unlisted to publish without one, or set up your org at squirrelscan.com."
            )
          );
        }

        // Team-plan-gated actions (#739) — currently only org invites return
        // this, but any command hitting a Team-gated endpoint funnels through
        // the same message via teamPlanRequiredMessage().
        if (error.code === "team_plan_required") {
          return err(
            commandError("team_plan_required", teamPlanRequiredMessage())
          );
        }

        return err(commandError(error.code, error.message));
      }

      return err(
        commandError(
          "API_ERROR",
          `Failed to publish report: ${response.status} ${response.statusText}`
        )
      );
    }

    const data = (await response.json()) as ApiSuccessResponse;

    return ok({
      id: data.id,
      url: data.url,
      visibility: data.visibility as ReportVisibility,
      createdAt: data.createdAt,
      // #1179: forward the server's post-merge score/counts (undefined on older
      // servers → caller keeps the local estimate).
      healthScore: data.healthScore,
      issuesFound: data.issuesFound,
      totalPages: data.totalPages,
    });
  } catch (error) {
    return err(
      commandError(
        "NETWORK_ERROR",
        `Failed to connect to API: ${(error as Error).message}`
      )
    );
  }
}

/**
 * Get all project storage paths
 */
function getProjectStoragePaths(): string[] {
  const projectsDir = getProjectsPath();
  if (!existsSync(projectsDir)) return [];

  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(projectsDir, d.name, "project.db"))
    .filter((p) => existsSync(p));
}

/**
 * Save published report info to local storage for tracking
 * This allows showing published status in `squirrel report --list`
 */
export async function savePublishedReportInfo(
  crawlId: string,
  reportId: string,
  url: string,
  visibility: ReportVisibility
): Promise<void> {
  const dbPaths = getProjectStoragePaths();

  // Search for the crawlId in all project databases
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;

    const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
    try {
      const found = await Effect.runPromise(
        Effect.gen(function* () {
          yield* storage.init();
          const crawl = yield* storage.getCrawl(crawlId);
          if (!crawl) {
            return false;
          }
          // Found the crawl - save published info
          yield* storage.savePublishedReport(
            crawlId,
            reportId,
            url,
            visibility,
            new Date().toISOString()
          );
          return true;
        })
      );

      if (found) {
        await Effect.runPromise(
          storage.close().pipe(Effect.catchAll(() => Effect.void))
        );
        return;
      }
    } catch {
      // Continue to next database
    } finally {
      await Effect.runPromise(
        storage.close().pipe(Effect.catchAll(() => Effect.void))
      );
    }
  }
}

/** Tiny home-page summary carried through publish so the API can stamp the
 * website's title/description (the rest of pages[] is dropped). */
export type HomepageSummary = {
  title: string | null;
  description: string | null;
};

/**
 * Pick the home page's <title>/<meta description> from the full report before
 * pages[] is stripped, so the published payload can still seed the website
 * record (the old cloud-agent sync did this; deterministic CLI runs lost it).
 * Exported for unit testing the origin-guarded fallback.
 */
export function pickHomepageSummary(
  report: AuditReport
): HomepageSummary | undefined {
  const pages = report.pages ?? [];
  if (pages.length === 0) return undefined;
  let home = pages[0];
  try {
    // Require the root candidate to share the audited origin — a multi-domain
    // crawl (allowedDomains) can include another site's "/" page, and stamping
    // the website with a sibling domain's title/description would be wrong.
    // Mirrors the server-side picker in apps/api/src/pipeline/helpers.ts.
    const baseOrigin = new URL(report.baseUrl).origin;
    home =
      pages.find((p) => {
        try {
          const u = new URL(p.url);
          return (
            u.origin === baseOrigin && (u.pathname === "/" || u.pathname === "")
          );
        } catch {
          return false;
        }
      }) ??
      pages.find((p) => p.url === report.baseUrl) ??
      pages[0];
  } catch {
    // baseUrl unparseable — fall back to the first crawled page.
  }
  const title = home.meta?.title ?? home.og?.title ?? null;
  const description = home.meta?.description ?? home.og?.description ?? null;
  if (!title && !description) return undefined;
  return { title, description };
}

/**
 * Strip bulky data from report before publishing to API.
 *
 * Renderers only use ruleResults + healthScore + summary metadata.
 * The pages[] array (links, images, textContent, headers, checks per page)
 * is the main bloat source and is never rendered.
 */
// Exported for tests (publish-slim.test.ts) — not part of the module's API.
// `sampleLimits` selects the per-check SAMPLE caps (#1167): the default primary
// caps, or PUBLISH_DEGRADE_LIMITS for the publish.ts degrade pass (a harder re-slim
// when the primary-capped body still exceeds maxPayloadBytes).
export function slimForPublish(
  report: AuditReport,
  sampleLimits: PublishSampleLimits = DEFAULT_PUBLISH_SAMPLE,
  // Lets the caller build the (sampling-independent) signal once across the
  // primary and degrade passes. Omit it and one is built here.
  precomputed?: { resolutionSignal: ResolutionSignal | undefined }
): Omit<AuditReport, "pages"> & {
  pages: [];
  homepage?: HomepageSummary;
  resolutionSignal?: ResolutionSignal;
} {
  // #1185: build the UNSAMPLED resolution signal from the pre-sample rule
  // results + the full crawled-page list, BEFORE sampling clips pages[] below
  // — the server merge uses it to resolve findings on pages crawled clean this
  // run that the sample would otherwise leave carried forever.
  const resolutionSignal = precomputed
    ? precomputed.resolutionSignal
    : buildResolutionSignal(
        report.ruleResults,
        report.pages.map((p) => p.url)
      );
  // robots.txt content clamp helper (see below).
  const truncate = (value: string | undefined, max: number) =>
    value !== undefined && value.length > max ? value.slice(0, max) : value;

  // Trim ruleResults: fold over-cap check arrays, then SAMPLE each check (#1167).
  const ruleResults: Record<
    string,
    { meta: AuditReport["ruleResults"][string]["meta"]; checks: CheckResult[] }
  > = {};
  for (const [ruleId, result] of Object.entries(report.ruleResults)) {
    // Fresh-audit reports arrive pre-folded (adapter), but reports rebuilt
    // from storage (`squirrel report` republish) don't — fold here too so no
    // publish path can overflow maxChecksPerRule into silent schema slicing
    // (#910). Idempotent: under-cap arrays pass through untouched.
    //
    // sampleChecksForPublish (#1167) then bounds every check to a fixed SAMPLE:
    // pages[] → maxPagesPerCheck (stamping details.pagesTruncated so the sample is
    // non-authoritative for the smart-audits merge), items → maxItems (details.
    // additional), and each item's id/label + sourcePages. Post-sampling the
    // payload is O(rules × sample_cap), flat regardless of crawl size.
    // Spread into a slimForPublish-OWNED array: the byte-budget backstop below
    // may clone-replace an element, and sampleChecksForPublish/foldOverflowChecks
    // can return the source report's own array when nothing overran — reslicing
    // that in place would corrupt `report` for the degrade re-slim (#1167).
    ruleResults[ruleId] = {
      meta: result.meta,
      checks: [
        ...sampleChecksForPublish(
          foldOverflowChecks(result.checks),
          sampleLimits
        ),
      ],
    };
  }

  // #918/#1167: byte-budget backstop. Post-sampling the largest pages[] is
  // maxPagesPerCheck (100) so this should never engage, but a pathological
  // rule count could still push pages[] bytes toward the 20MB gate — clip the
  // largest arrays under a byte budget, preserving the true pre-sample count in
  // details.pagesTruncated (a 413 rejects the WHOLE publish, strictly worse).
  clampReportPagesToBudget(ruleResults);

  // Trim summary arrays
  const summary = {
    missingTitles: report.summary.missingTitles.slice(
      0,
      PUBLISH_LIMITS.maxSummary
    ),
    missingDescriptions: report.summary.missingDescriptions.slice(
      0,
      PUBLISH_LIMITS.maxSummary
    ),
    missingOgTags: report.summary.missingOgTags.slice(
      0,
      PUBLISH_LIMITS.maxSummary
    ),
    missingTwitterCards: report.summary.missingTwitterCards.slice(
      0,
      PUBLISH_LIMITS.maxSummary
    ),
    missingSchemas: report.summary.missingSchemas.slice(
      0,
      PUBLISH_LIMITS.maxSummary
    ),
    missingAltText: report.summary.missingAltText.slice(
      0,
      PUBLISH_LIMITS.maxSummary
    ),
    multipleH1s: report.summary.multipleH1s.slice(0, PUBLISH_LIMITS.maxSummary),
    thinContentPages: report.summary.thinContentPages.slice(
      0,
      PUBLISH_LIMITS.maxSummary
    ),
    urlIssues: report.summary.urlIssues.slice(0, PUBLISH_LIMITS.maxSummary),
    redirectChains: report.summary.redirectChains.slice(
      0,
      PUBLISH_LIMITS.maxSummary
    ),
    securityIssues: report.summary.securityIssues.slice(
      0,
      PUBLISH_LIMITS.maxSummary
    ),
  };

  // Trim sitemap URLs (can be 50,000+). Mega-site sitemap indexes can list
  // thousands of children (techcrunch: 2057) — the API caps both the
  // discovered list and each childSitemaps array at maxSitemapEntries.
  const sitemaps = report.sitemaps
    ? {
        ...report.sitemaps,
        discovered: report.sitemaps.discovered
          .slice(0, REPORT_LIMITS.maxSitemapEntries)
          .map((s) => ({
            ...s,
            urls: s.urls.slice(0, PUBLISH_LIMITS.maxSitemapUrls),
            ...(s.childSitemaps
              ? {
                  childSitemaps: s.childSitemaps.slice(
                    0,
                    REPORT_LIMITS.maxSitemapEntries
                  ),
                }
              : {}),
          })),
        orphanPages: report.sitemaps.orphanPages.slice(
          0,
          PUBLISH_LIMITS.maxSummary
        ),
        missingPages: report.sitemaps.missingPages.slice(
          0,
          PUBLISH_LIMITS.maxSummary
        ),
      }
    : undefined;

  // Trim siteChecks the same way (#1167): sitemap-orphans can carry 6000+ items
  // and site-wide rules a huge pages[]; sampleChecksForPublish caps both + stamps
  // the truncation markers so the merge treats the page list as a sample.
  const siteChecks = sampleChecksForPublish(report.siteChecks, sampleLimits);

  // robots.txt content is capped at the API's long-string limit — mega-sites
  // (nytimes) ship robots files well past 5000 chars.
  const robotsTxt = report.robotsTxt
    ? {
        ...report.robotsTxt,
        content:
          report.robotsTxt.content != null
            ? truncate(report.robotsTxt.content, REPORT_LIMITS.maxLongString)!
            : report.robotsTxt.content,
      }
    : report.robotsTxt;

  // Smart-audits cloud (#195): the server-side finding merge needs to know which
  // pages 404/410'd this run so it can STALE their carried findings rather than
  // carry them forever. 200 pages are implied by their ruleResults checks, so we
  // send ONLY non-2xx statuses — tiny, and adds NOTHING (omitted entirely) for a
  // healthy site, so it can't regress the publish payload size when there are no
  // broken pages. URLs are re-normalized server-side.
  // REPORT_LIMITS.maxPages here and the API schema's REPORT_LIMITS.MAX_PAGES both
  // resolve to the SAME core-contracts `maxPages` (the API object aliases it), so
  // the cap can't drift out from under the publish schema's `.max(MAX_PAGES)`.
  const pageStatuses = report.pages
    .filter((p) => p.statusCode < 200 || p.statusCode >= 300)
    .map((p) => ({ url: p.url, status: p.statusCode }))
    .slice(0, REPORT_LIMITS.maxPages);

  return {
    ...report,
    pages: [], // Drop all page-level data — renderers use ruleResults only
    generatorVersion: version, // stamp the CLI version for the report footer
    lockedRules: computeLockedRules(report), // cloud/Pro checks not run → upsell
    ...(pageStatuses.length > 0 ? { pageStatuses } : {}),
    ...(resolutionSignal ? { resolutionSignal } : {}),
    // ...but keep a tiny home-page title/description so the API can seed the
    // website record (full pages[] is gone).
    homepage: pickHomepageSummary(report),
    siteChecks,
    summary,
    sitemaps,
    robotsTxt,
    sitemapUrlStatuses: report.sitemapUrlStatuses?.slice(
      0,
      PUBLISH_LIMITS.maxSitemapUrls
    ),
    ruleResults,
  };
}
