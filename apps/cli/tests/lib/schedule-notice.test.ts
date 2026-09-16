// What the CLI says after a publish about the site's recurring audits (#2184).
//
// Recurring audits are ON BY DEFAULT now: a website's first completed cloud
// audit switches a weekly schedule on with nobody asking for it. A recurring
// credit charge that starts silently is what got #493 reverted, so the CLI owes
// its user three facts at the one moment it knows them, and a half-printed
// version of them is worse than none.
//
// The summary is SERVER-BUILT for the #2183 reason, so what is pinned here is
// the rendering and the refusals, not a URL or a cadence the CLI invented.
//
// ONE LINE, ONE RENDERER. `scheduleSummaryLine` answers at most one line for
// any state, and #2225 adds the `capped` branch to it rather than to a second
// call site. The "every other state is silent" tests below are what stop that
// branch being added somewhere else.

import type { WebsiteScheduleSummary } from "@squirrelscan/cloud-client";

import { describe, expect, test } from "bun:test";

import {
  isScheduleSummary,
  scheduleSummaryLine,
} from "../../src/lib/schedule-notice";

const SETTINGS_URL =
  "https://app.squirrelscan.com/acme/website/web_1/settings/schedule";

const ACTIVE: WebsiteScheduleSummary = {
  kind: "recurring",
  frequency: "weekly",
  requested: true,
  state: "active",
  stateReason: null,
  nextRunAt: "2026-09-23T04:41:00.000Z",
  cadenceLabel: "every week",
  settingsUrl: SETTINGS_URL,
  pauseUrl: "https://api.squirrelscan.com/v1/schedules/pause?s=a&t=b",
  cap: { limit: 1, used: 1 },
  upgradeUrl: null,
};

describe("the post-publish schedule line", () => {
  test("says it recurs, how often, that it costs credits, and where to stop it", () => {
    const line = scheduleSummaryLine(ACTIVE)!;

    expect(line).toContain("every week");
    expect(line).toContain("costs credits");
    expect(line).toContain("Turn it off");
    expect(line).toContain(SETTINGS_URL);
  });

  test("renders the server's cadence wording rather than deriving one", () => {
    // A plan that clamps a daily request to weekly is exactly the case a
    // client-side label would get wrong, so the label is whatever arrived.
    const line = scheduleSummaryLine({
      ...ACTIVE,
      frequency: "monthly",
      cadenceLabel: "every month",
    })!;

    expect(line).toContain("every month");
    expect(line).not.toContain("every week");
  });

  test("is one line", () => {
    expect(scheduleSummaryLine(ACTIVE)!.split("\n")).toHaveLength(1);
  });

  test("uses no em-dash — public copy never does", () => {
    expect(scheduleSummaryLine(ACTIVE)!).not.toContain("—");
  });

  // Only `active` has something running to disclose. Every other state needs
  // its own sentence and its own next step, and #2225 adds those to this same
  // function — rendering one of them with the active wording would claim a
  // schedule that is not running, the one error this line must never make.
  test.each([["off"], ["capped"], ["unschedulable"], ["paused"]])(
    "state %p renders nothing yet",
    (state) => {
      expect(
        scheduleSummaryLine({
          ...ACTIVE,
          state: state as WebsiteScheduleSummary["state"],
        })
      ).toBeNull();
    }
  );

  test("an unrecognised state renders nothing rather than the active line", () => {
    expect(
      scheduleSummaryLine({ ...ACTIVE, state: "something_new" })
    ).toBeNull();
  });

  // Absence means "the server said nothing", which covers an older API and a
  // publish that linked no website at all. It must never read as "there is a
  // schedule" or as "there is none".
  test("says nothing when the server sent no summary", () => {
    expect(scheduleSummaryLine(undefined)).toBeNull();
    expect(scheduleSummaryLine(null)).toBeNull();
  });
});

/**
 * The publish response is a cast over `response.json()`, never validated, so
 * the fields this renderer READS are checked before anything is printed.
 *
 * Deliberately narrow: it validates what is rendered, not the whole contract.
 * Requiring fields the CLI never touches would make a server that populates
 * them later silently print nothing, for no reader-visible gain.
 */
describe("isScheduleSummary", () => {
  test("accepts a complete summary", () => {
    expect(isScheduleSummary(ACTIVE)).toBe(true);
  });

  test("accepts a summary whose unrendered fields are absent", () => {
    // The three fields the line reads, and nothing else.
    expect(
      isScheduleSummary({
        state: "active",
        cadenceLabel: "every week",
        settingsUrl: SETTINGS_URL,
      })
    ).toBe(true);
  });

  test("rejects a missing rendered field", () => {
    for (const key of ["state", "cadenceLabel", "settingsUrl"] as const) {
      const partial = { ...ACTIVE } as Record<string, unknown>;
      delete partial[key];
      expect(isScheduleSummary(partial), `missing ${key} was accepted`).toBe(
        false
      );
    }
  });

  test("rejects an empty label or an empty link", () => {
    expect(isScheduleSummary({ ...ACTIVE, cadenceLabel: "" })).toBe(false);
    expect(isScheduleSummary({ ...ACTIVE, settingsUrl: "" })).toBe(false);
    expect(isScheduleSummary({ ...ACTIVE, state: "" })).toBe(false);
  });

  test("rejects a wrongly-typed field", () => {
    expect(isScheduleSummary({ ...ACTIVE, state: 1 })).toBe(false);
    expect(isScheduleSummary({ ...ACTIVE, settingsUrl: 42 })).toBe(false);
  });

  test("rejects the things that are not objects at all", () => {
    for (const value of [null, undefined, "weekly", 1, true, []]) {
      expect(isScheduleSummary(value), `${String(value)} was accepted`).toBe(
        false
      );
    }
  });

  // A partial summary reaching the renderer is the failure this guard exists to
  // stop, so the two are pinned together.
  test("a rejected summary prints nothing", () => {
    expect(scheduleSummaryLine({ state: "active" })).toBeNull();
    expect(scheduleSummaryLine({ ...ACTIVE, settingsUrl: "" })).toBeNull();
  });
});
