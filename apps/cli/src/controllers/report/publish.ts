/**
 * Report publishing controller - publishes audit reports to reports.squirrelscan.com
 */

import type { WebsiteScheduleSummary } from "@squirrelscan/cloud-client";

import { computeLockedRules } from "@squirrelscan/audit-engine";
import {
  capReportForPublish,
  PublishedReportTooLargeError,
  type CappedReport,
} from "@squirrelscan/audit-engine/publish-cap";
import { clampItemString } from "@squirrelscan/core-contracts/clamp";
import {
  PUBLISHED_REPORT_MAX_BYTES,
  REPORT_LIMITS,
} from "@squirrelscan/core-contracts/limits";
import { Effect } from "effect";
import { existsSync } from "node:fs";

import type { AuditReport, CheckResult } from "@/types";

import { hasEverPublished } from "@/cli/publish-nudge";
import { REPORTS_BASE_URL } from "@/constants";
import { type Result, ok, err, commandError } from "@/controllers/types";
import { getGlobalContentStore } from "@/crawler/storage/content-store";
import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { cliApi } from "@/lib/api-client";
import { teamPlanRequiredMessage } from "@/lib/plan-messages";
import { runPath } from "@/lib/run-tracker";
import { isScheduleSummary } from "@/lib/schedule-notice";
import { DEFAULT_API_URL, getApiUrl } from "@/self/api";
import {
  API_TOKEN_ENV_VAR,
  envTokenRejectedMessage,
  resolveCredential,
} from "@/self/credentials";
import { loadUserSettings, updateSettings } from "@/self/settings";

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
  // #2184: what the server says about this website's recurring audits, or
  // undefined when it said nothing (an older server, or a publish that linked
  // no website). Absence means "say nothing", never "there is no schedule".
  schedule?: WebsiteScheduleSummary;
  // #1179: the server's AUTHORITATIVE post-merge score/counts (it re-merges the
  // published payload against the cross-audit finding store and can differ from
  // the CLI's local pre-publish estimate). The caller stamps these into
  // agent_runs so every surface agrees. Absent from older servers (undefined) →
  // caller falls back to the local report numbers. null score = failed/blocked.
  healthScore?: number | null;
  issuesFound?: number;
  totalPages?: number;
}

/** The server's sentence without its final period, to end it with ours. */
const trimPeriod = (text: string): string => text.replace(/\.+$/, "");

interface ApiErrorResponse {
  /** The bare-string shape: a role refusal ("forbidden_role") with `message` beside it. */
  message?: string;
  error:
    | string
    | {
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
  // #2184: optional, and validated rather than trusted — this whole object is
  // a cast over `response.json()`, so a partial notice would otherwise reach
  // the renderer as a half-printed sentence.
  schedule?: unknown;
  // #1179: present on current servers; optional so an older server (or the
  // internal route shape) parses without these into undefined.
  healthScore?: number | null;
  issuesFound?: number;
  totalPages?: number;
}

const PUBLISH_TIMEOUT_MS = 30_000;
const PUBLISH_MAX_ATTEMPTS = 3;
const RECOVERY_TIMEOUT_MS = 10_000;
// The pre-POST snapshot runs on every publish, so it is bounded tightly: an
// unreadable snapshot only disables recovery (fails closed), never the publish.
const SNAPSHOT_TIMEOUT_MS = 3_000;

/** The report still holds its crawled page list. */
function hasCrawledPages(report: AuditReport): boolean {
  return Array.isArray(report.pages) && report.pages.length > 0;
}

/**
 * Any rule holds a page check: one with a `pageUrl`, or a folded aggregate of
 * them. Reads an `--input` file as loaded, unvalidated, so it never throws on
 * a malformed one (the capper then refuses that with a clear error).
 */
function hasPageChecks(report: AuditReport): boolean {
  const rules = report.ruleResults;
  if (!rules || typeof rules !== "object") return false;
  for (const rule of Object.values(rules)) {
    const checks: unknown = rule?.checks;
    if (!Array.isArray(checks)) continue;
    for (const check of checks as Array<
      Partial<CheckResult> | null | undefined
    >) {
      if (check?.pageUrl) return true;
      if (
        check?.details?.aggregated === true &&
        Array.isArray(check.pages) &&
        check.pages.length > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * What the user reads when a report is too large to publish, whether the
 * capper refused it before the POST or the API refused the body (413).
 */
export function payloadTooLargeMessage(): string {
  return `Report exceeds maximum allowed size (${PUBLISHED_REPORT_MAX_BYTES / 1024 / 1024}MB).\nTry reducing the number of pages audited.`;
}

/**
 * Stamp the FIRST publish (#2182). Non-fatal by construction: the report IS
 * published, and a failed settings write must not turn it into an error.
 */
function stampFirstPublish(): void {
  const settings = loadUserSettings();
  if (settings.ok && !hasEverPublished(settings.data)) {
    updateSettings({ first_publish_at: new Date().toISOString() });
  }
}

/**
 * Read the `reportId` the server has linked to a run (`agent_runs.report_id`,
 * set at publish). Returns undefined when the run cannot be read, null when it
 * has no linked report. Uses the same base as the lifecycle calls: org API keys
 * (`sq_`) are rejected on the userId-scoped route.
 */
async function readRunReportId(
  runId: string,
  token: string,
  timeoutMs: number = RECOVERY_TIMEOUT_MS
): Promise<string | null | undefined> {
  try {
    const run = await cliApi.request<{ reportId?: string | null }>(
      runPath(runId),
      { token, timeoutMs }
    );
    if (!run.ok) return undefined;
    const reportId = run.data?.reportId;
    return typeof reportId === "string" && reportId ? reportId : null;
  } catch {
    return undefined;
  }
}

/**
 * After a publish 5xx, decide whether the report landed anyway. A 5xx can be a
 * worker kill AFTER the report was written and linked to the run, so a run
 * whose `reportId` is set now is the answer, but only if it was NOT already set
 * before this attempt: a re-publish on a run that already had a report would
 * otherwise "recover" the OLD report. When the pre-publish state is unknown
 * (`before === undefined`) we cannot tell, so we keep the failure. Never
 * re-POSTs: a retry would mint a second report row and orphan its R2 objects.
 */
async function findLinkedReportId(
  runId: string,
  token: string,
  before: string | null | undefined
): Promise<string | null> {
  if (before === undefined) return null;
  const after = await readRunReportId(runId, token);
  return after && after !== before ? after : null;
}

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

  // Snapshot the run's linked report BEFORE the POST so a 5xx recovery can tell
  // a report this attempt wrote from one a previous publish left behind. Started
  // now so the round trip overlaps payload building; awaited just before the POST.
  const reportIdBeforePromise: Promise<string | null | undefined> =
    options.runId
      ? readRunReportId(options.runId, credential.token, SNAPSHOT_TIMEOUT_MS)
      : Promise.resolve(null);

  const maxMB = PUBLISHED_REPORT_MAX_BYTES / 1024 / 1024;
  const linkage = {
    // Link to the pre-registered audit (#271) so publish updates that skeleton
    // rather than creating a duplicate DO audit, and keeps it on the registered
    // website. Omitted when not registered.
    ...(options.auditId ? { auditId: options.auditId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.websiteId ? { websiteId: options.websiteId } : {}),
  };

  // A report with page checks but no crawled page list (a published or slimmed
  // JSON loaded with `--input`) cannot be capped soundly: the capper drops its
  // pass rows into tallies that the server reads only beside a resolution
  // signal, which it builds from `pages[]`, so the score would collapse to the
  // failures alone. Refused before any request.
  if (!hasCrawledPages(report) && hasPageChecks(report)) {
    return err(
      commandError(
        "PUBLISH_PREPARE_FAILED",
        "This report has no crawled page list (an exported, published or slimmed copy), " +
          "so it cannot be published without losing its score.\n" +
          "Publish the audit from its project with `squirrel report <audit-id> --publish`, " +
          "or re-run the audit to publish it."
      )
    );
  }

  // repo#2667: the published report is the engine's capped summary, at most
  // PUBLISHED_REPORT_MAX_BYTES whatever the crawl size (the capper's own
  // budget leaves room for this envelope). The full per-page detail stays in
  // the local project database. The capper refuses only a report whose
  // skeleton alone is over the budget, which no real shape comes near.
  let slimmed: ReturnType<typeof slimForPublish>;
  try {
    slimmed = slimForPublish(report);
  } catch (error) {
    // Too large: the same message as the API's refusal of the body below.
    if (error instanceof PublishedReportTooLargeError) {
      return err(commandError("PAYLOAD_TOO_LARGE", payloadTooLargeMessage()));
    }
    // A stored report the capper cannot read (a malformed or much older one,
    // republished with `squirrel report --publish`): say so and send nothing.
    return err(
      commandError(
        "PUBLISH_PREPARE_FAILED",
        `Could not prepare this report for publishing (${error instanceof Error ? error.message : String(error)}).\n` +
          "It is still saved locally: view it with `squirrel report`."
      )
    );
  }
  if (slimmed.detail.tier > 0) {
    options.onWarn?.(
      `Published report samples reduced to fit the ${maxMB}MB ` +
        "publish limit; the full detail stays local (`squirrel report --format json`)."
    );
  }
  const body = JSON.stringify({ report: slimmed, visibility, ...linkage });

  const reportIdBefore = await reportIdBeforePromise;

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
        return err(commandError("PAYLOAD_TOO_LARGE", payloadTooLargeMessage()));
      }

      // #1168: any server 5xx is a server-verifiable failure — classify it with a
      // stable PUBLISH_SERVER_ERROR code (the audit succeeded; the server dropped
      // the publish) so finalize refunds the whole audit. Checked BEFORE the
      // structured-body branch below: a 5xx often carries a JSON `error.code`
      // (e.g. PUBLISH_FAILED) that isn't in the refundable allowlist, so status
      // must win over the body for the refund classification.
      if (response.status >= 500) {
        // #1340: the 5xx may have hit AFTER the report was written. Only runs
        // registered at start (runId) can be checked; others keep the failure.
        // Only the production API is recoverable: the link is built from the
        // production reports host, and a staging or self-hosted API serves its
        // reports from its own base, which the CLI cannot discover.
        const recoveredId =
          options.runId && getApiUrl() === DEFAULT_API_URL
            ? await findLinkedReportId(
                options.runId,
                credential.token,
                reportIdBefore
              )
            : null;
        if (recoveredId) {
          // Only the id is known: visibility is what we asked for, and the
          // schedule notice / server-merged score are unavailable, so the caller
          // keeps its local estimate (the run's own finalize handles refunds).
          stampFirstPublish();
          return ok({
            id: recoveredId,
            url: `${REPORTS_BASE_URL}/${recoveredId}`,
            visibility,
            createdAt: new Date().toISOString(),
          });
        }
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

      // A role refusal (the org's role matrix: a viewer or billing member
      // cannot publish) comes as a bare `error: "forbidden_role"` with its
      // message beside it, or as the typed envelope (cloud #3409); an API key
      // without the scope gets `missing_scope` in the envelope.
      const envelopeCode =
        typeof errorData?.error === "object" ? errorData.error.code : undefined;
      if (
        errorData?.error === "forbidden_role" ||
        envelopeCode === "forbidden_role"
      ) {
        const said =
          typeof errorData?.error === "object"
            ? errorData.error.message
            : errorData?.message;
        return err(
          commandError(
            "forbidden_role",
            `${trimPeriod(said ?? "Your role in this organization cannot publish reports")}.\n` +
              "Ask an owner or admin for a role that runs audits, or run with --no-publish to keep the report local."
          )
        );
      }
      if (
        envelopeCode === "missing_scope" &&
        typeof errorData?.error === "object"
      ) {
        return err(
          commandError(
            "missing_scope",
            `${trimPeriod(errorData.error.message)}.\n` +
              "Use an API key with the audits:write scope (squirrel keys create), or run with --no-publish to keep the report local."
          )
        );
      }
      if (typeof errorData?.error === "string") {
        return err(
          commandError(
            "API_ERROR",
            `Failed to publish report: ${response.status} ${errorData.error}`
          )
        );
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

    // #2182: stamp the FIRST publish, here and nowhere else. Every publish path
    // in the CLI funnels through this function — auto-publish at the end of an
    // audit, and `squirrel report --publish` — so one write covers both, and no
    // future third caller can forget it. The one-time "kept local" nudge reads
    // this flag, and "never again after their first publish" has to hold for a
    // user who published before the nudge ever had a chance to print.
    //
    // Non-fatal by construction: the report IS published, and a settings write
    // that fails must not turn a successful publish into an error. The worst
    // case is one extra nudge line on a later run.
    stampFirstPublish();

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
      // #2184: forwarded only when the server sent a complete one.
      ...(isScheduleSummary(data.schedule) ? { schedule: data.schedule } : {}),
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
 * Mark a crawl as published in its project's database, so `squirrel report
 * --list` shows the hosted report next to it.
 *
 * `dbPath` is that project's `project.db`, which every caller already knows: the
 * audit just wrote to it, or the report was loaded from it. #625: this used to
 * open and initialise every database under `~/.squirrel/projects` until one held
 * the crawl, so the end of an audit stalled on a large store (17,248 databases on
 * one machine) after the report url had already printed.
 *
 * Non-fatal by construction, as before: the report IS published. A database that
 * is missing, does not hold the crawl or fails to open only skips the local mark.
 */
export async function savePublishedReportInfo(
  dbPath: string,
  crawlId: string,
  reportId: string,
  url: string,
  visibility: ReportVisibility
): Promise<void> {
  if (!existsSync(dbPath)) return;

  const storage = new SQLiteStorage(dbPath, getGlobalContentStore());
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const crawl = yield* storage.getCrawl(crawlId);
        if (!crawl) return;
        yield* storage.savePublishedReport(
          crawlId,
          reportId,
          url,
          visibility,
          new Date().toISOString()
        );
      })
    );
  } catch {
    // The publish succeeded; only the local "published" mark is lost.
  } finally {
    await Effect.runPromise(
      storage.close().pipe(Effect.catchAll(() => Effect.void))
    );
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
    // Mirrors the hosted API's homepage picker.
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
  // Site-controlled text, bounded as the API bounds it: the capper keeps the
  // field whole, so an unbounded title alone could push a report past its budget.
  return {
    title:
      title === null
        ? null
        : clampItemString(title, REPORT_LIMITS.maxMediumString),
    description:
      description === null
        ? null
        : clampItemString(description, REPORT_LIMITS.maxMetaDescriptionString),
  };
}

/** What the CLI adds to a report before it is capped for publish. */
type CliPublishReport = AuditReport & {
  generatorVersion: string;
  lockedRules: ReturnType<typeof computeLockedRules>;
  homepage?: HomepageSummary;
};

/**
 * The report body the CLI publishes (repo#2667): the engine's capped summary,
 * built by the same `capReportForPublish` the cloud container publishes with,
 * so the two bodies cannot drift.
 *
 * The capper drops `pages[]`, the per-page pass rows (their counts ride in
 * `checkTallies`, which the server rescores from), the raw resolution signal and
 * the local `rulesCache`. It samples each issue class with its true counts,
 * builds the compact signal and `pageStatuses` from the FULL report within their
 * byte share, and stamps `detail` (`fullDetail: "local"`: the per-page detail is
 * in this machine's project database). It never mutates `report`, so a
 * `--format json` export of the same run keeps every row.
 *
 * What only the CLI knows rides along: its version for the report footer, the
 * cloud-only rules it did not run (the report's upsell) and a home-page title
 * and description, so the API can seed the website record. All three are read
 * from the full report, before the capper drops its pages.
 *
 * Throws `PublishedReportTooLargeError` when even the report's skeleton does
 * not fit the budget.
 */
// Exported for tests (publish-slim.test.ts) — not part of the module's API.
export function slimForPublish(
  report: AuditReport
): CappedReport<CliPublishReport> {
  const homepage = pickHomepageSummary(report);
  return capReportForPublish<CliPublishReport>(
    {
      ...report,
      generatorVersion: version,
      lockedRules: computeLockedRules(report),
      ...(homepage ? { homepage } : {}),
    },
    { fullDetail: "local" }
  );
}
