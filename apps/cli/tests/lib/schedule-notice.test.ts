// What the CLI says after a publish about the site's recurring audits (#2184,
// #2225).
//
// Recurring audits are ON BY DEFAULT now: a website's first completed cloud
// audit switches a weekly schedule on with nobody asking for it. A recurring
// credit charge that starts silently is what got #493 reverted, so the CLI owes
// its user three facts at the one moment it knows them, and a half-printed
// version of them is worse than none.
//
// #2225 added the second state a user actually meets: `capped`, where the site
// wants a schedule and the plan's slots are spent. Saying nothing there is how
// over 100 sites came to believe they were on a weekly schedule.
//
// The summary is SERVER-BUILT for the #2183 reason, so what is pinned here is
// the rendering and the refusals, not a URL, a cadence or an allowance the CLI
// invented.
//
// ONE LINE, ONE RENDERER. `scheduleSummaryLine` answers at most one line for
// any state, and the `capped` branch went into it rather than into a second
// call site. The "every other state is silent" tests below are what stop the
// next branch being added somewhere else.

import type { WebsiteScheduleSummary } from "@squirrelscan/cloud-client";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { fmt } from "../../src/cli/format";
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

const UPGRADE_URL = "https://app.squirrelscan.com/acme/settings/billing";

/**
 * The site wants a schedule and the plan has no slot left for it (#1704).
 *
 * `requested: true` with `state: "capped"` is the whole case: the intent is
 * kept, nothing is running, and the site becomes active by itself the moment a
 * slot frees. `cap` is the plan's allowance as the server counted it, and
 * `upgradeUrl` is the only way out, so the line is refused without it.
 */
const CAPPED: WebsiteScheduleSummary = {
  ...ACTIVE,
  frequency: null,
  state: "capped",
  stateReason: "plan_cap",
  nextRunAt: null,
  cadenceLabel: "off",
  pauseUrl: null,
  cap: { limit: 1, used: 1 },
  upgradeUrl: UPGRADE_URL,
};

/**
 * The line without its dim escape codes.
 *
 * `fmt.dim` colours only on a TTY, and `bun test` has one when a developer runs
 * it in a terminal and not when CI pipes it. Byte-exact assertions have to hold
 * in both, and stripping is the only way they do.
 */
const plain = (line: string) =>
  // oxlint-disable-next-line no-control-regex -- ANSI escapes are control chars
  line.replace(/\u001b\[[0-9;]*m/g, "");

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

  // The capped branch shares this function, so the active line is pinned BYTE
  // FOR BYTE rather than by `toContain`: a clause appended for the new state
  // would satisfy every "contains" assertion above it. The summary carries an
  // `upgradeUrl` here on purpose, which is the field the capped branch reads.
  test("reads exactly as it did before the capped branch existed", () => {
    expect(
      plain(scheduleSummaryLine({ ...ACTIVE, upgradeUrl: UPGRADE_URL })!)
    ).toBe(
      `Scheduled audits: every week, and each run costs credits. Turn it off: ${SETTINGS_URL}`
    );
  });

  test("never offers an upgrade on a schedule that is running", () => {
    expect(
      scheduleSummaryLine({ ...ACTIVE, upgradeUrl: UPGRADE_URL })
    ).not.toContain("Upgrade:");
  });

  test("uses no em-dash — public copy never does", () => {
    expect(scheduleSummaryLine(ACTIVE)!).not.toContain("—");
  });

  // `active` and `capped` are the two states with something to say. The rest
  // still need their own sentence and their own next step, and they belong in
  // the same function: rendering one of them with the active wording would
  // claim a schedule that is not running, the one error this line must never
  // make.
  test.each([["off"], ["unschedulable"], ["paused"]])(
    "state %p renders nothing yet",
    (state) => {
      expect(
        scheduleSummaryLine({
          ...ACTIVE,
          state: state as WebsiteScheduleSummary["state"],
          upgradeUrl: UPGRADE_URL,
        })
      ).toBeNull();
    }
  );

  // THE TABLE. Every state the contract defines, crossed with both schedule
  // kinds, read off one renderer. `always_on` is the kind #2225 reserved: it
  // has no cadence, and it must not change which states speak.
  test.each([
    ["recurring" as const, "off", false],
    ["recurring" as const, "active", true],
    ["recurring" as const, "capped", true],
    ["recurring" as const, "unschedulable", false],
    ["recurring" as const, "paused", false],
    ["always_on" as const, "off", false],
    ["always_on" as const, "active", true],
    ["always_on" as const, "capped", true],
    ["always_on" as const, "unschedulable", false],
    ["always_on" as const, "paused", false],
  ])("a %p schedule in state %p speaks: %p", (kind, state, speaks) => {
    const line = scheduleSummaryLine({
      ...ACTIVE,
      kind,
      frequency: kind === "always_on" ? null : "weekly",
      cadenceLabel: kind === "always_on" ? "always on" : "every week",
      state: state as WebsiteScheduleSummary["state"],
      upgradeUrl: UPGRADE_URL,
    });

    expect(line === null, `state ${state} (${kind})`).toBe(!speaks);
    if (line) expect(line.split("\n")).toHaveLength(1);
  });

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
 * The capped line (#2225).
 *
 * A free-plan user whose second site wants a schedule gets nothing: no run, and
 * until now no word either. The line has to carry two facts the CLI cannot
 * derive, what the plan funds and where to buy more, and it has to refuse
 * itself rather than print a half of them.
 */
describe("the capped line", () => {
  test("says the site is not scheduled, what the plan funds, and where to upgrade", () => {
    const line = scheduleSummaryLine(CAPPED)!;

    expect(line).toContain("not scheduled");
    expect(line).toContain("your plan schedules 1 website");
    expect(line).toContain(`Upgrade: ${UPGRADE_URL}`);
  });

  test("reads as one whole sentence, byte for byte", () => {
    expect(plain(scheduleSummaryLine(CAPPED)!)).toBe(
      `Scheduled audits: this site is not scheduled, your plan schedules 1 website. Upgrade: ${UPGRADE_URL}`
    );
  });

  test("is one dim line with no em-dash", () => {
    const line = scheduleSummaryLine(CAPPED)!;

    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toContain("\u2014");
  });

  // The capped site is not running, so nothing about the active line's wording
  // may leak into it. "every week" on a site that never fires is the failure
  // this whole state exists to end.
  test("never borrows the active wording", () => {
    const line = scheduleSummaryLine(CAPPED)!;

    expect(line).not.toContain("costs credits");
    expect(line).not.toContain("Turn it off");
    expect(line).not.toContain("every week");
  });

  // The allowance is the server's number, pluralised off it rather than
  // hardcoded to the free plan's one site.
  test("counts in the server's units", () => {
    expect(
      scheduleSummaryLine({ ...CAPPED, cap: { limit: 3, used: 3 } })
    ).toContain("your plan schedules 3 websites");
  });

  // A server that sent no count still owes the reader the upgrade link. The
  // sentence drops the number, not the next step.
  test("a null cap prints the line without a count", () => {
    const line = scheduleSummaryLine({ ...CAPPED, cap: null })!;

    expect(line).toContain("not scheduled");
    expect(line).toContain(`Upgrade: ${UPGRADE_URL}`);
    expect(line).not.toContain("your plan schedules");
  });

  // Same for a cap that arrived malformed, or one that says the plan caps
  // nothing, which cannot be why this site is capped.
  test.each([
    [{ limit: "1", used: 1 }],
    [{ used: 1 }],
    [{ limit: -1, used: 0 }],
    ["1"],
  ])("a cap of %p prints the line without a count", (cap) => {
    const line = scheduleSummaryLine({ ...CAPPED, cap })!;

    expect(line).toContain(`Upgrade: ${UPGRADE_URL}`);
    expect(line).not.toContain("your plan schedules");
  });

  // THE REFUSAL. The line's whole point is the next step, so without a link
  // there is no line, never "Upgrade: undefined".
  test.each([[null], [undefined], [""], [42]])(
    "an upgrade link of %p prints nothing at all",
    (upgradeUrl) => {
      expect(scheduleSummaryLine({ ...CAPPED, upgradeUrl })).toBeNull();
    }
  );

  test("prints no placeholder where a missing link would go", () => {
    const { upgradeUrl: _dropped, ...withoutLink } = CAPPED;

    expect(scheduleSummaryLine(withoutLink)).toBeNull();
  });
});

/**
 * DIM, and dim once.
 *
 * `fmt.dim` only emits escape codes on a TTY, so the rendered string alone
 * cannot tell whether the line was dimmed: drop the wrapper and every
 * assertion in this file still passes under a piped `bun test`. Spying on the
 * formatter is what pins it, and it pins the count at the same time, which is
 * the "at most ONE line" rule read from the other side.
 */
describe("the line is dim, and dimmed once", () => {
  let restore: () => void = () => {};

  afterEach(() => restore());

  const dimCalls = (summary: unknown) => {
    const spy = spyOn(fmt, "dim");
    restore = () => spy.mockRestore();
    scheduleSummaryLine(summary);
    return spy.mock.calls.map((args) => args[0]);
  };

  test("the active line goes through fmt.dim exactly once", () => {
    expect(dimCalls(ACTIVE)).toEqual([
      `Scheduled audits: every week, and each run costs credits. Turn it off: ${SETTINGS_URL}`,
    ]);
  });

  test("the capped line goes through fmt.dim exactly once", () => {
    expect(dimCalls(CAPPED)).toEqual([
      `Scheduled audits: this site is not scheduled, your plan schedules 1 website. Upgrade: ${UPGRADE_URL}`,
    ]);
  });

  test.each([["off"], ["unschedulable"], ["paused"]])(
    "state %p formats nothing at all",
    (state) => {
      expect(
        dimCalls({ ...CAPPED, state, upgradeUrl: UPGRADE_URL })
      ).toHaveLength(0);
    }
  );
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

  // PER STATE (#2225). What is rendered differs by state, so what is required
  // does too. The two halves of that are pinned separately below, because a
  // guard widened the lazy way, by requiring `upgradeUrl` of everything, would
  // silence every active summary an older server ever sent.
  test("a capped summary needs the link its line ends with", () => {
    expect(isScheduleSummary(CAPPED)).toBe(true);
    for (const upgradeUrl of [null, undefined, "", 42]) {
      expect(
        isScheduleSummary({ ...CAPPED, upgradeUrl }),
        `upgradeUrl ${String(upgradeUrl)} was accepted on a capped summary`
      ).toBe(false);
    }
  });

  test("an active summary still does not", () => {
    expect(isScheduleSummary({ ...ACTIVE, upgradeUrl: null })).toBe(true);
    const { upgradeUrl: _dropped, ...withoutLink } = ACTIVE;
    expect(isScheduleSummary(withoutLink)).toBe(true);
  });

  // The states that render nothing require nothing extra either: an older
  // server that omits `upgradeUrl` on an off or paused site is not malformed.
  test.each([["off"], ["unschedulable"], ["paused"]])(
    "state %p requires no upgrade link",
    (state) => {
      expect(isScheduleSummary({ ...ACTIVE, state, upgradeUrl: null })).toBe(
        true
      );
    }
  );
});
