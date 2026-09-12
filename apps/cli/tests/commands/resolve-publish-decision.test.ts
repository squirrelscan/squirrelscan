import { describe, expect, test } from "bun:test";

import {
  resolvePublishDecision,
  resolveRegisterDecision,
} from "../../src/cli/commands/audit";

/** Build opts with sensible defaults (signed in, online, config-on); override per-case. */
function opts(
  over: Partial<Parameters<typeof resolvePublishDecision>[0]> = {}
): Parameters<typeof resolvePublishDecision>[0] {
  return {
    signedIn: true,
    offline: false,
    explicitPublish: false,
    noPublish: false,
    configPublish: true,
    ...over,
  };
}

describe("resolvePublishDecision", () => {
  test("signed-in + online auto-publishes by default", () => {
    expect(resolvePublishDecision(opts())).toBe(true);
  });

  test("offline never publishes", () => {
    expect(resolvePublishDecision(opts({ offline: true }))).toBe(false);
  });

  test("not signed in never publishes", () => {
    expect(resolvePublishDecision(opts({ signedIn: false }))).toBe(false);
  });

  test("--no-publish skips publishing", () => {
    expect(resolvePublishDecision(opts({ noPublish: true }))).toBe(false);
  });

  test("config publish=false skips publishing", () => {
    expect(resolvePublishDecision(opts({ configPublish: false }))).toBe(false);
  });

  test("explicit --publish overrides --no-publish", () => {
    expect(
      resolvePublishDecision(opts({ explicitPublish: true, noPublish: true }))
    ).toBe(true);
  });

  test("explicit --publish overrides config publish=false", () => {
    expect(
      resolvePublishDecision(
        opts({ explicitPublish: true, configPublish: false })
      )
    ).toBe(true);
  });

  test("explicit --publish still publishes even when not signed in (publishReport errors later)", () => {
    expect(
      resolvePublishDecision(opts({ explicitPublish: true, signedIn: false }))
    ).toBe(true);
  });

  test("offline beats explicit --publish", () => {
    expect(
      resolvePublishDecision(opts({ explicitPublish: true, offline: true }))
    ).toBe(false);
  });

  test("--no-publish + --offline together → no publish (offline short-circuits)", () => {
    expect(
      resolvePublishDecision(opts({ noPublish: true, offline: true }))
    ).toBe(false);
  });

  // #1066: a --rule-include/--rule-exclude run is a partial report with no
  // partial marker on the publish payload yet (#1082) — auto-publish must
  // not silently replace the site's full report in the dashboard.
  describe("ruleFilterActive (#1066)", () => {
    test("skips auto-publish for an otherwise-publishable signed-in run", () => {
      expect(resolvePublishDecision(opts({ ruleFilterActive: true }))).toBe(
        false
      );
    });

    test("explicit --publish still overrides ruleFilterActive", () => {
      expect(
        resolvePublishDecision(
          opts({ ruleFilterActive: true, explicitPublish: true })
        )
      ).toBe(true);
    });

    test("offline still beats ruleFilterActive + explicit --publish", () => {
      expect(
        resolvePublishDecision(
          opts({
            ruleFilterActive: true,
            explicitPublish: true,
            offline: true,
          })
        )
      ).toBe(false);
    });

    test("unset/false ruleFilterActive doesn't change the default", () => {
      expect(resolvePublishDecision(opts({ ruleFilterActive: false }))).toBe(
        true
      );
    });
  });
  // #1841. A loopback / RFC1918 / link-local target is auditable locally but
  // unreachable for every hosted service, so a published report for it is a
  // dashboard card nothing in the cloud can screenshot, re-audit or schedule.
  describe("nonPublicHost (#1841)", () => {
    test("a local/private host skips publishing", () => {
      expect(resolvePublishDecision(opts({ nonPublicHost: true }))).toBe(false);
    });

    // The ONLY opt-out that outranks an explicit --publish, because it is not a
    // preference: the cloud cannot act on the host whatever the user asks for.
    test("it beats an explicit --publish", () => {
      expect(
        resolvePublishDecision(
          opts({ nonPublicHost: true, explicitPublish: true })
        )
      ).toBe(false);
    });

    test("unset/false leaves the default alone", () => {
      expect(resolvePublishDecision(opts({ nonPublicHost: false }))).toBe(true);
      expect(resolvePublishDecision(opts())).toBe(true);
    });
  });
});

// #1841. Registering a local or private-network audit is what created the
// hosted website plus the weekly screenshot refresh that could never succeed,
// and it charged the 50-credit audit base for cloud work that cannot happen.
describe("resolveRegisterDecision", () => {
  const reg = (
    over: Partial<Parameters<typeof resolveRegisterDecision>[0]> = {}
  ) =>
    resolveRegisterDecision({
      signedIn: true,
      offline: false,
      nonPublicHost: false,
      ...over,
    });

  test("a signed-in online run of a public host registers", () => {
    expect(reg()).toBe(true);
  });

  test.each([
    ["not signed in", { signedIn: false }],
    ["--offline", { offline: true }],
    ["a local or private host", { nonPublicHost: true }],
  ])("%s does not register", (_label, over) => {
    expect(reg(over)).toBe(false);
  });

  // The host outranks everything, including a signed-in online run that would
  // otherwise be the normal case.
  test("the host clause is not conditional on anything else", () => {
    expect(reg({ nonPublicHost: true, signedIn: true, offline: false })).toBe(
      false
    );
  });
});
