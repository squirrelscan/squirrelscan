// What the CLI says about a site's recurring audits after a publish (#2184, #2225).
//
// Recurring audits are ON BY DEFAULT now: a website's first completed cloud
// audit switches a weekly schedule on with no user action. That is a recurring
// credit charge nobody explicitly asked for, so every surface that reports a
// completed audit owes the owner the same three facts, and this is the CLI's
// copy of them.
//
//   1. this site is re-audited automatically, and how often;
//   2. each run costs credits;
//   3. where one click turns it off.
//
// The API BUILDS the summary and the CLI renders it, the same rule #2183 applied
// to the upgrade offer. Everything in it depends on something the CLI cannot
// know: the cadence the plan clamped the site to, the org slug the dashboard
// route needs, the plan's scheduled-site allowance. A client that composed any
// of it would be one release away from disagreeing with the dashboard and the
// email about the same website.
//
// ── ONE renderer, one line ───────────────────────────────────────────────
//
// `scheduleSummaryLine` is the single seam that turns a summary into terminal
// output, and it answers at most ONE line for any state. #2225 added the
// `capped` branch HERE rather than at the call sites: two call sites each
// printing their own state's line is how a publish ends up saying two things
// about one schedule. Whoever adds `unschedulable` or `paused` adds a branch
// below, and its fields to `hasStateFields`, in the same change.
//
// ── The capped case ──────────────────────────────────────────────────────
//
// `capped` is the state a free-plan user actually meets: the site WANTS a
// schedule, the plan's scheduled-website slots are spent, and until #2225 both
// the dashboard and the CLI said nothing at all about it. Over 100 sites sat in
// that state believing they were on a weekly schedule. The line names the
// allowance and the way out, and it is the server's `cap` and `upgradeUrl` that
// say what those are.

import type { WebsiteScheduleSummary } from "@squirrelscan/cloud-client";

import { fmt } from "@/cli/format";

/** A capped summary that carries the link its line ends with. */
interface CappedScheduleSummary extends WebsiteScheduleSummary {
  state: "capped";
  upgradeUrl: string;
}

/**
 * The fields a given state's line renders BEYOND the three every summary
 * carries, checked before anything is printed.
 *
 * One function, called from both the wire guard and the renderer, so the
 * refusal cannot be true in one place and false in the other. `active` reads
 * nothing extra, which is why widening this for `capped` cannot make an older
 * server's active summary go silent.
 */
function hasStateFields(s: { state?: unknown; upgradeUrl?: unknown }): boolean {
  // The capped line's whole point is the next step. A line that ends
  // "Upgrade: undefined" is worse than no line at all.
  if (s.state !== "capped") return true;
  return typeof s.upgradeUrl === "string" && s.upgradeUrl.length > 0;
}

/**
 * Whether a value off the wire is a summary we can print.
 *
 * The publish response is parsed as JSON and cast, never validated, so the
 * fields this renderer actually READS are checked here rather than trusted. A
 * summary missing one of them is treated as no summary at all: telling somebody
 * a recurring charge has started and then failing to say where to stop it is
 * worse than saying nothing.
 *
 * Deliberately narrow. It validates what is rendered, not the whole contract:
 * requiring fields the CLI never touches (`nextRunAt`, `pauseUrl`, `requested`)
 * would make an older or a partially-populated server silent for no reason, and
 * the server owns those fields' meaning anyway.
 *
 * "What is rendered" is per state, not global: see {@link hasStateFields}.
 * Whoever adds the next branch to {@link scheduleSummaryLine} adds its fields
 * there in the same change, or the new line prints `undefined` at the one place
 * a reader is meant to click.
 */
export function isScheduleSummary(
  value: unknown
): value is WebsiteScheduleSummary {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<Record<keyof WebsiteScheduleSummary, unknown>>;
  return (
    typeof s.state === "string" &&
    s.state.length > 0 &&
    typeof s.cadenceLabel === "string" &&
    s.cadenceLabel.length > 0 &&
    typeof s.settingsUrl === "string" &&
    s.settingsUrl.length > 0 &&
    hasStateFields(s)
  );
}

/** The same requirement, as the narrowing the capped branch needs. */
function isCappedSummary(
  summary: WebsiteScheduleSummary
): summary is CappedScheduleSummary {
  return summary.state === "capped" && hasStateFields(summary);
}

/**
 * How the capped line names the plan's allowance.
 *
 * `cap` is the server's count, and a missing or nonsensical one is not worth
 * losing the upgrade link over: the sentence drops the number and keeps the
 * fact. A negative limit means the plan caps nothing, which cannot be the
 * reason this site is capped, so it is read as no count rather than printed.
 */
function planAllowance(cap: WebsiteScheduleSummary["cap"]): string {
  const limit = cap?.limit;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
    return "your plan's scheduled websites are all in use";
  }
  return `your plan schedules ${limit} website${limit === 1 ? "" : "s"}`;
}

/**
 * The one line the CLI prints after a published audit, or null when there is
 * nothing to say.
 *
 * ONE line, dim, and printed on every publish rather than once. A disclosure
 * seen once is one that can be missed, and the cost of repeating it is a single
 * dim line under a URL the reader is already looking at.
 *
 * Null for every state but `active` and `capped`. A site that is off has
 * nothing to opt out of; `unschedulable` and `paused` each still need their own
 * sentence and their own next step, and they belong in THIS function. The
 * trailing null is what keeps an unrecognised state from being rendered with
 * the active wording, which would claim a schedule that is not running: the one
 * error this line must never make.
 */
export function scheduleSummaryLine(summary: unknown): string | null {
  if (!isScheduleSummary(summary)) return null;
  if (isCappedSummary(summary)) {
    return fmt.dim(
      `Scheduled audits: this site is not scheduled, ${planAllowance(summary.cap)}. Upgrade: ${summary.upgradeUrl}`
    );
  }
  if (summary.state === "active") {
    return fmt.dim(
      `Scheduled audits: ${summary.cadenceLabel}, and each run costs credits. Turn it off: ${summary.settingsUrl}`
    );
  }
  return null;
}
