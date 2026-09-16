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
// The API BUILDS the notice and the CLI renders it, the same rule #2183 applied
// to the upgrade offer. Both the cadence wording and the settings link depend on
// things the CLI cannot know (which cadence the plan clamped the site to, and
// the org slug the dashboard route needs), and a client that composed either
// would be one release away from disagreeing with the dashboard and the email
// about the same website.

import type { ScheduleNotice } from "@squirrelscan/cloud-client";

import { fmt } from "@/cli/format";

/**
 * Whether a value off the wire is a notice we can print.
 *
 * The publish response is parsed as JSON and cast, never validated, so every
 * field is checked here rather than trusted. A half-populated notice is treated
 * as no notice at all: telling somebody a recurring charge has started and then
 * failing to say where to stop it is worse than saying nothing.
 */
export function isScheduleNotice(value: unknown): value is ScheduleNotice {
  if (!value || typeof value !== "object") return false;
  const n = value as Partial<Record<keyof ScheduleNotice, unknown>>;
  return (
    typeof n.enabled === "boolean" &&
    typeof n.frequency === "string" &&
    typeof n.frequencyLabel === "string" &&
    n.frequencyLabel.length > 0 &&
    typeof n.settingsUrl === "string" &&
    n.settingsUrl.length > 0
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
 * Null when the schedule is off. The CLI never announces a schedule that is not
 * running, and it never pitches one either: that belongs to the dashboard,
 * which knows what the plan funds and which of its slots are free.
 */
export function scheduleNoticeLine(notice: unknown): string | null {
  if (!isScheduleNotice(notice) || !notice.enabled) return null;
  return fmt.dim(
    `This site is re-audited ${notice.frequencyLabel} and each run costs credits. Turn it off: ${notice.settingsUrl}`
  );
}
