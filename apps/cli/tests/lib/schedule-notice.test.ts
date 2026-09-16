// What the CLI says after a publish about the site's recurring audits (#2184).
//
// Recurring audits are ON BY DEFAULT now: a website's first completed cloud
// audit switches a weekly schedule on with nobody asking for it. A recurring
// credit charge that starts silently is what got #493 reverted, so the CLI owes
// its user three facts at the one moment it knows them — publish time — and a
// half-printed version of them is worse than none.
//
// The notice is SERVER-BUILT for the #2183 reason: the cadence wording and the
// settings link both depend on things the CLI cannot know, and a client that
// composed either would drift from the dashboard and the email about the same
// site. So what is pinned here is the rendering and the refusals, not a URL the
// CLI invented.

import { describe, expect, test } from "bun:test";

import {
  isScheduleNotice,
  scheduleNoticeLine,
} from "../../src/lib/schedule-notice";

const SETTINGS_URL =
  "https://app.squirrelscan.com/acme/website/web_1/settings/schedule";

const NOTICE = {
  enabled: true,
  frequency: "weekly",
  frequencyLabel: "every week",
  settingsUrl: SETTINGS_URL,
};

describe("the post-publish schedule line", () => {
  test("says it recurs, how often, that it costs credits, and where to stop it", () => {
    const line = scheduleNoticeLine(NOTICE)!;

    expect(line).toContain("re-audited every week");
    expect(line).toContain("costs credits");
    expect(line).toContain("Turn it off");
    expect(line).toContain(SETTINGS_URL);
  });

  test("renders the server's cadence wording rather than deriving one", () => {
    // A plan that clamps a daily request to weekly is exactly the case a
    // client-side label would get wrong, so the label is whatever arrived.
    const line = scheduleNoticeLine({
      ...NOTICE,
      frequency: "monthly",
      frequencyLabel: "every month",
    })!;

    expect(line).toContain("re-audited every month");
    expect(line).not.toContain("every week");
  });

  test("is one line", () => {
    expect(scheduleNoticeLine(NOTICE)!.split("\n")).toHaveLength(1);
  });

  test("uses no em-dash — public copy never does", () => {
    expect(scheduleNoticeLine(NOTICE)!).not.toContain("—");
  });

  test("says nothing when the schedule is off", () => {
    expect(scheduleNoticeLine({ ...NOTICE, enabled: false })).toBeNull();
  });

  // Absence means "the server said nothing", which covers an older API and a
  // publish that linked no website at all. It must never read as "there is a
  // schedule" or as "there is none".
  test("says nothing when the server sent no notice", () => {
    expect(scheduleNoticeLine(undefined)).toBeNull();
    expect(scheduleNoticeLine(null)).toBeNull();
  });
});

/**
 * The publish response is a cast over `response.json()`, never validated, so
 * every field is checked before anything is printed. A partial notice is
 * rejected whole: naming a recurring charge and then failing to say where to
 * stop it is the one outcome worse than silence.
 */
describe("isScheduleNotice", () => {
  test("accepts a complete notice", () => {
    expect(isScheduleNotice(NOTICE)).toBe(true);
  });

  test("rejects a missing field", () => {
    for (const key of Object.keys(NOTICE)) {
      const partial = { ...NOTICE } as Record<string, unknown>;
      delete partial[key];
      expect(isScheduleNotice(partial), `missing ${key} was accepted`).toBe(
        false
      );
    }
  });

  test("rejects an empty label or an empty link", () => {
    expect(isScheduleNotice({ ...NOTICE, frequencyLabel: "" })).toBe(false);
    expect(isScheduleNotice({ ...NOTICE, settingsUrl: "" })).toBe(false);
  });

  test("rejects a wrongly-typed field", () => {
    expect(isScheduleNotice({ ...NOTICE, enabled: "true" })).toBe(false);
    expect(isScheduleNotice({ ...NOTICE, settingsUrl: 42 })).toBe(false);
  });

  test("rejects the things that are not objects at all", () => {
    for (const value of [null, undefined, "weekly", 1, true, []]) {
      expect(isScheduleNotice(value), `${String(value)} was accepted`).toBe(
        false
      );
    }
  });

  // A partial notice reaching the renderer is the failure this guard exists to
  // stop, so the two are pinned together.
  test("a rejected notice prints nothing", () => {
    expect(
      scheduleNoticeLine({ enabled: true, frequency: "weekly" })
    ).toBeNull();
    expect(scheduleNoticeLine({ ...NOTICE, settingsUrl: "" })).toBeNull();
  });
});
