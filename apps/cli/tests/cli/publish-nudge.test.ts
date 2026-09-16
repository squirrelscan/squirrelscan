import { describe, expect, test } from "bun:test";

import {
  hasEverPublished,
  publishNudgeLine,
  shouldShowPublishNudge,
  type PublishNudgeOptions,
} from "@/cli/publish-nudge";

// The state in which the nudge SHOULD print: a signed-in, interactive console
// run of a public site that produced a full report which did not get published,
// on an install that has never published anything. Every test below changes one
// field of this and asserts the answer flips.
const NUDGE_CASE: PublishNudgeOptions = {
  signedIn: true,
  offline: false,
  publishedThisRun: false,
  publishFailed: false,
  everPublished: false,
  nudgeShown: false,
  nonPublicHost: false,
  ruleFilterActive: false,
  stderrIsTTY: true,
  isConsoleFormat: true,
  outputPath: undefined,
};

const withCase = (over: Partial<PublishNudgeOptions>): PublishNudgeOptions => ({
  ...NUDGE_CASE,
  ...over,
});

describe("shouldShowPublishNudge", () => {
  test("fires for a signed-in user whose report stayed local", () => {
    expect(shouldShowPublishNudge(NUDGE_CASE)).toBe(true);
  });

  // "a single nudge … and never again after their first publish" — the two
  // halves of the acceptance criterion, as two independent facts.
  test("never fires twice", () => {
    expect(shouldShowPublishNudge(withCase({ nudgeShown: true }))).toBe(false);
  });

  test("never fires once anything has been published, even if it never printed", () => {
    expect(shouldShowPublishNudge(withCase({ everPublished: true }))).toBe(
      false
    );
  });

  test("does not fire on a run that just published", () => {
    expect(shouldShowPublishNudge(withCase({ publishedThisRun: true }))).toBe(
      false
    );
  });

  test("does not fire when the auto-publish failed and already said so", () => {
    expect(shouldShowPublishNudge(withCase({ publishFailed: true }))).toBe(
      false
    );
  });

  test("does not fire offline", () => {
    expect(shouldShowPublishNudge(withCase({ offline: true }))).toBe(false);
  });

  // A signed-out run already gets "Unlock cloud features: squirrel auth login"
  // in this exact spot; the criterion is about a LOGGED-IN user.
  test("does not fire signed out", () => {
    expect(shouldShowPublishNudge(withCase({ signedIn: false }))).toBe(false);
  });

  // #1841: nothing hosted can reach localhost, so "publish it" is advice that
  // cannot work. The run already printed the line explaining that.
  test("does not fire for a non-public host", () => {
    expect(shouldShowPublishNudge(withCase({ nonPublicHost: true }))).toBe(
      false
    );
  });

  // #1066: a rule-filtered run is a PARTIAL report. Auto-publish refuses it for
  // that reason, and telling the user to publish it by hand would replace the
  // site's full dashboard report with a subset.
  test("does not fire for a rule-filtered run", () => {
    expect(shouldShowPublishNudge(withCase({ ruleFilterActive: true }))).toBe(
      false
    );
  });

  // Same three gates as tips (cli/tips.ts): agents, CI and machine formats must
  // never be sold to. The footer is stderr, so stderr's TTY is the one that
  // decides.
  test("does not fire when stderr is not a TTY", () => {
    expect(shouldShowPublishNudge(withCase({ stderrIsTTY: false }))).toBe(
      false
    );
  });

  test("does not fire for a machine format", () => {
    expect(shouldShowPublishNudge(withCase({ isConsoleFormat: false }))).toBe(
      false
    );
  });

  test("does not fire when the report is written to a file", () => {
    expect(
      shouldShowPublishNudge(withCase({ outputPath: "report.html" }))
    ).toBe(false);
  });
});

describe("hasEverPublished", () => {
  test("a stamped first publish is a yes", () => {
    expect(
      hasEverPublished({
        first_publish_at: "2026-09-16T00:00:00.000Z",
        auto_publish_notice_shown: null,
      })
    ).toBe(true);
  });

  // The back-fill for installs that published before first_publish_at existed:
  // auto_publish_notice_shown is written ONLY inside the successful
  // auto-publish branch, so a true there is proof of a past publish.
  test("the auto-publish notice having been shown is also a yes", () => {
    expect(
      hasEverPublished({
        first_publish_at: null,
        auto_publish_notice_shown: true,
      })
    ).toBe(true);
  });

  test("neither flag set is a no", () => {
    expect(
      hasEverPublished({
        first_publish_at: null,
        auto_publish_notice_shown: null,
      })
    ).toBe(false);
    expect(
      hasEverPublished({
        first_publish_at: null,
        auto_publish_notice_shown: false,
      })
    ).toBe(false);
  });

  test("absent settings is a no, not a crash", () => {
    expect(hasEverPublished(undefined)).toBe(false);
  });
});

describe("publishNudgeLine", () => {
  // `squirrel report --publish` defaults to PUBLIC, while the auto-publish the
  // user opted out of defaults to unlisted. A nudge that silently moved someone
  // onto the public web would be the worst possible outcome of a growth line,
  // so the command it prints must carry the visibility.
  test("names a visibility, and it is not public", () => {
    const line = publishNudgeLine();
    expect(line).toContain("squirrel report --publish --visibility unlisted");
    expect(line).not.toContain("--visibility public");
  });

  test("says it will not be repeated", () => {
    expect(publishNudgeLine()).toContain("shown once");
  });
});
