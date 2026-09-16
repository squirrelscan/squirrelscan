// What the CLI says about a site's recurring audits after a publish (#2184).
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
// output, and it answers at most ONE line for any state. #2225 adds the `capped`
// branch here rather than at the call sites: two call sites each printing their
// own state's line is how a publish ends up saying two things about one
// schedule.

import type { WebsiteScheduleSummary } from "@squirrelscan/cloud-client";

import { fmt } from "@/cli/format";

/** The states this CLI renders today. Everything else is silent until #2225. */
const RENDERED_STATES = new Set(["active"]);

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
 * requiring fields the CLI never touches (`nextRunAt`, `cap`, `pauseUrl`) would
 * make an older or a partially-populated server silent for no reason, and the
 * server owns those fields' meaning anyway.
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
    s.settingsUrl.length > 0
  );
}

/**
 * The one line the CLI prints after a published audit, or null when there is
 * nothing to say.
 *
 * ONE line, dim, and printed on every publish rather than once. A disclosure
 * seen once is one that can be missed, and the cost of repeating it is a single
 * dim line under a URL the reader is already looking at.
 *
 * Null for every state but `active`. A site that is off has nothing to opt out
 * of; `capped`, `unschedulable` and `paused` each need their own sentence and
 * their own next step, and #2225 adds them to THIS function. Rendering an
 * unrecognised state with the active wording would claim a schedule that is not
 * running, which is the one error this line must never make.
 */
export function scheduleSummaryLine(summary: unknown): string | null {
  if (!isScheduleSummary(summary)) return null;
  if (!RENDERED_STATES.has(summary.state)) return null;
  return fmt.dim(
    `Scheduled audits: ${summary.cadenceLabel}, and each run costs credits. Turn it off: ${summary.settingsUrl}`
  );
}
