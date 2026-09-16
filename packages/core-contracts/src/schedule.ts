/**
 * The one shape every surface reads a website's recurring audits from (#2184).
 *
 * Recurring audits switch themselves on after a website's first completed cloud
 * audit, with nobody asking for it, so the CLI, the MCP tools, the dashboard and
 * the completion email all have to say the same three things: the site is
 * re-audited, how often, and where one click stops it. They said nothing, or
 * three different things.
 *
 * The API BUILDS this and every client RENDERS it. That is the rule #2183
 * established for the upgrade offer, and it exists because the alternative was
 * measured: three surfaces composed their own upgrade URL and one of them had
 * never been a route. Everything here depends on something a client cannot
 * derive — which cadence the plan actually clamped the site to, the org slug the
 * dashboard route needs, a signed pause token, how many scheduled-site slots the
 * plan funds and how many are spent.
 *
 * ── Why one type rather than a field per surface ─────────────────────────
 *
 * Because the states are not all "on". A site can be unscheduled because its
 * plan's slots are spent (#1704), because its host can never resolve (#1605), or
 * because a failure streak paused it (#1705), and each of those needs a
 * different sentence and a different next step. A notice typed only for the
 * active case forces every consumer that meets one of the others to invent its
 * own shape, which is the drift this type exists to stop.
 *
 * Field names are a CONTRACT across #2184 and #2225. Add states and populate
 * more fields; never rename one.
 */

import type { ScheduledAuditFrequency } from "./index";

/**
 * Why a website is, or is not, being re-audited.
 *
 * `off` and `paused` are different on purpose: `off` is a choice somebody made
 * and a client may offer to reverse, while `paused` is something the system did
 * to the site and usually needs the underlying cause fixed first.
 */
export type WebsiteScheduleState =
  /** Nothing recurring is set up, and nothing is stopping one. */
  | "off"
  /** Recurring audits are running. */
  | "active"
  /** Wanted, but the plan's scheduled-website slots are spent (#1704). */
  | "capped"
  /** Wanted, but this host can never be audited from the cloud (#1605/#1841). */
  | "unschedulable"
  /** Was running; stopped by the system (a failure streak, or credits — #1705). */
  | "paused";

/**
 * What a website's recurring audits are doing, as one server-rendered object.
 *
 * Every string field is ready to print. A client that reformats `cadenceLabel`,
 * recomputes a URL or maps `state` to its own wording is reintroducing the drift
 * this type prevents.
 */
export interface WebsiteScheduleSummary {
  /**
   * `recurring` is the cadence-driven schedule. `always_on` is reserved for
   * continuous monitoring, which has no cadence and therefore a null
   * `frequency`; nothing populates it yet.
   */
  kind: "recurring" | "always_on";
  /** The cadence that actually fires. Null for `always_on`, and for a site with none. */
  frequency: ScheduledAuditFrequency | null;
  /**
   * What the OWNER asked for, which is not always what they got: a site can want
   * a schedule and be refused one by the plan cap or its own host. Read with
   * `state` — `requested: true, state: "capped"` is the case worth a sentence.
   */
  requested: boolean;
  state: WebsiteScheduleState;
  /**
   * Machine-readable cause behind a non-`active` state — `plan_cap`,
   * `reserved_host`, `plan_no_schedule`, `consecutive_failures`,
   * `insufficient_credits`. Null when `state` says everything there is to say.
   *
   * Deliberately an open string rather than a union: the producers grow reasons
   * faster than consumers can branch on them, and a client that meets an unknown
   * one should fall back to `state` rather than fail to parse.
   */
  stateReason: string | null;
  /** ISO timestamp of the next run. Null unless an active recurring schedule. */
  nextRunAt: string | null;
  /**
   * The cadence as it reads in a sentence: "every week", "off", "always on".
   * Server-rendered so a CLI line, an email and a dashboard chip cannot describe
   * the same site differently.
   */
  cadenceLabel: string;
  /** This website's schedule settings page in the dashboard. Always present. */
  settingsUrl: string;
  /**
   * Signed, no-login, one-click pause link — the same token the digest email
   * carries. Null unless there is something running to pause.
   */
  pauseUrl: string | null;
  /**
   * The plan's scheduled-website allowance and what the org has spent of it.
   * Null on a plan that caps nothing.
   */
  cap: { limit: number; used: number } | null;
  /** Where to buy a way out of `capped` or `plan_no_schedule`. Null otherwise. */
  upgradeUrl: string | null;
}
