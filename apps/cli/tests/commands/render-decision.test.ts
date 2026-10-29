import { describe, expect, test } from "bun:test";

import {
  consentEstimateLine,
  linkPricingNoticeDue,
  estimateBalanceAfter,
  formatCloudSpendSummary,
  phaseTimingsFromError,
  resolveCloudRendering,
  resolveExplicitRenderMode,
  validateAuditFlags,
} from "../../src/cli/commands/audit";
import { LINK_PRICING_NOTICE } from "../../src/lib/upgrade";

describe("phaseTimingsFromError (#871)", () => {
  test("extracts phaseTimingsMs from a well-formed CommandError.details", () => {
    const details = { phaseTimingsMs: { crawl: 47_200, rules: 13_000 } };
    expect(phaseTimingsFromError(details)).toEqual({
      crawl: 47_200,
      rules: 13_000,
    });
  });

  test("returns undefined when details is undefined (no phase completed yet)", () => {
    expect(phaseTimingsFromError(undefined)).toBeUndefined();
  });

  test("returns undefined when details is null or a primitive", () => {
    expect(phaseTimingsFromError(null)).toBeUndefined();
    expect(phaseTimingsFromError("some other error detail")).toBeUndefined();
    expect(phaseTimingsFromError(42)).toBeUndefined();
  });

  test("returns undefined when details has no phaseTimingsMs field", () => {
    expect(phaseTimingsFromError({ someOtherField: true })).toBeUndefined();
  });

  test("returns undefined when phaseTimingsMs is present but not an object", () => {
    expect(
      phaseTimingsFromError({ phaseTimingsMs: "not an object" })
    ).toBeUndefined();
    expect(phaseTimingsFromError({ phaseTimingsMs: null })).toBeUndefined();
  });

  test("returns undefined when phaseTimingsMs is an array, not the expected map shape", () => {
    expect(
      phaseTimingsFromError({ phaseTimingsMs: [1, 2, 3] })
    ).toBeUndefined();
  });

  test("returns undefined when a value isn't a finite number", () => {
    expect(
      phaseTimingsFromError({ phaseTimingsMs: { crawl: "slow" } })
    ).toBeUndefined();
    expect(
      phaseTimingsFromError({ phaseTimingsMs: { crawl: Infinity } })
    ).toBeUndefined();
    expect(
      phaseTimingsFromError({ phaseTimingsMs: { crawl: NaN } })
    ).toBeUndefined();
  });

  test("an empty phaseTimingsMs object is still a valid (if uninteresting) shape", () => {
    expect(phaseTimingsFromError({ phaseTimingsMs: {} })).toEqual({});
  });
});

describe("estimateBalanceAfter (#2290)", () => {
  test("a post-services read only loses the end-of-run settlement", () => {
    // Read after the crawl's renders: 100 − 50 base − 2 prepaid = 48, then 36
    // settled for 18 more pages.
    expect(
      estimateBalanceAfter({
        prefetchRead: 48,
        afterBase: 50,
        baseCharged: 50,
        totalSpent: 88,
        settled: 36,
      })
    ).toBe(12);
  });

  test("with only the register read, every charge after the base comes off", () => {
    // Quick coverage skips the prefetch read: 100 → 50 after base, then 2
    // prepaid and 36 settled.
    expect(
      estimateBalanceAfter({
        prefetchRead: null,
        afterBase: 50,
        baseCharged: 50,
        totalSpent: 88,
        settled: 36,
      })
    ).toBe(12);
  });

  test("never negative, null when nothing was read, frozen when unmetered", () => {
    expect(
      estimateBalanceAfter({
        prefetchRead: 10,
        afterBase: null,
        baseCharged: 50,
        totalSpent: 100,
        settled: 40,
      })
    ).toBe(0);
    expect(
      estimateBalanceAfter({
        prefetchRead: null,
        afterBase: null,
        baseCharged: 50,
        totalSpent: 88,
        settled: 38,
      })
    ).toBeNull();
    expect(
      estimateBalanceAfter({
        prefetchRead: null,
        afterBase: 0,
        baseCharged: 50,
        totalSpent: 88,
        settled: 38,
        unlimited: true,
      })
    ).toBe(0);
  });
});

describe("formatCloudSpendSummary", () => {
  test("names the audited page count so the arithmetic is checkable (#2290)", () => {
    const line = formatCloudSpendSummary({
      lines: [
        { service: "audit-base", feature: "audit_base", units: 1, credits: 50 },
        {
          service: "audit-pages",
          feature: "audit_page",
          units: 19,
          credits: 38,
        },
      ],
      totalSpent: 88,
      balanceAfter: 412,
    });
    expect(line).toBe(
      "☁ Cloud credits used: 88 (audit-base 50, 19 audited pages 38) · balance ~412"
    );
  });

  test("a render cache hit shows the render_cached (1cr) line, matching the ledger #279", () => {
    const line = formatCloudSpendSummary({
      lines: [{ service: "render_cached", credits: 1 }],
      totalSpent: 1,
      balanceAfter: 499,
    });
    expect(line).toBe(
      "☁ Cloud credits used: 1 (render_cached 1) · balance ~499"
    );
  });

  test("mixed render + render_cached lines both surface in the breakdown #279", () => {
    const line = formatCloudSpendSummary({
      lines: [
        { service: "render", credits: 4 },
        { service: "render_cached", credits: 3 },
      ],
      totalSpent: 7,
      balanceAfter: null,
    });
    expect(line).toBe("☁ Cloud credits used: 7 (render 4, render_cached 3)");
  });
});

const cfg = (
  cloud: {
    render?: "off" | "auto" | "all";
    rendering?: "http" | "browser";
  } = {}
) => ({ cloud });

const noop = () => {};

/** Build opts with sensible defaults; override per-case. */
function opts(
  over: Partial<Parameters<typeof resolveCloudRendering>[0]> = {}
): Parameters<typeof resolveCloudRendering>[0] {
  return {
    args: {},
    configRendering: undefined,
    signedIn: true,
    consent: undefined,
    log: noop,
    // Capped by default (real audits always pass an estimate); `consented` bakes
    // in the cap check, so override maxCredits: 0 to exercise the uncapped path.
    estimate: { maxPages: 25, balance: 1000, maxCredits: 1000 },
    // Inert by default so unit tests never touch the real settings file; cases
    // that assert persistence pass their own spy.
    persist: () => ({ ok: true }),
    ...over,
  };
}

describe("resolveExplicitRenderMode precedence", () => {
  test("unset everywhere → undefined (coverage default)", () => {
    expect(resolveExplicitRenderMode({}, cfg())).toBeUndefined();
  });

  test("--render-mode wins over flags and config", () => {
    expect(
      resolveExplicitRenderMode(
        { renderMode: "auto", http: true, render: true },
        cfg({ render: "off", rendering: "browser" })
      )
    ).toBe("auto");
  });

  test("invalid --render-mode falls through (intentional; CLI validates+errors before calling)", () => {
    expect(
      resolveExplicitRenderMode({ renderMode: "bogus" }, cfg())
    ).toBeUndefined();
    expect(
      resolveExplicitRenderMode({ renderMode: "bogus", http: true }, cfg())
    ).toBe("off");
  });

  test("--http → off, --render → all (over config)", () => {
    expect(
      resolveExplicitRenderMode({ http: true }, cfg({ render: "all" }))
    ).toBe("off");
    expect(
      resolveExplicitRenderMode({ render: true }, cfg({ render: "off" }))
    ).toBe("all");
  });

  test("[cloud].render beats legacy [cloud].rendering", () => {
    expect(
      resolveExplicitRenderMode({}, cfg({ render: "auto", rendering: "http" }))
    ).toBe("auto");
  });

  test("legacy [cloud].rendering maps in when render unset", () => {
    expect(resolveExplicitRenderMode({}, cfg({ rendering: "http" }))).toBe(
      "off"
    );
    expect(resolveExplicitRenderMode({}, cfg({ rendering: "browser" }))).toBe(
      "all"
    );
  });

  test("passes through the three explicit values from config", () => {
    expect(resolveExplicitRenderMode({}, cfg({ render: "off" }))).toBe("off");
    expect(resolveExplicitRenderMode({}, cfg({ render: "auto" }))).toBe("auto");
    expect(resolveExplicitRenderMode({}, cfg({ render: "all" }))).toBe("all");
  });
});

describe("resolveCloudRendering precedence", () => {
  test("--http forces http even when signed in and consented", async () => {
    expect(
      await resolveCloudRendering(
        opts({ args: { http: true }, consent: "accepted" })
      )
    ).toEqual({ mode: "http", consented: false });
  });

  // #368: an explicit --http from a signed-in user is never silently promoted to
  // cloud — it stays http/unconsented, even on the authed default (no consent set).
  test("signed-in --http stays http, never promoted to cloud", async () => {
    expect(await resolveCloudRendering(opts({ args: { http: true } }))).toEqual(
      { mode: "http", consented: false }
    );
  });

  test("--render forces browser even when not signed in", async () => {
    expect(
      await resolveCloudRendering(
        opts({ args: { render: true }, signedIn: false })
      )
    ).toEqual({ mode: "browser", consented: false });
  });

  test("config wins over auto when no flag", async () => {
    expect(
      await resolveCloudRendering(opts({ configRendering: "browser" }))
    ).toEqual({ mode: "browser", consented: false });
    expect(
      await resolveCloudRendering(opts({ configRendering: "http" }))
    ).toEqual({ mode: "http", consented: false });
  });

  test("not signed in falls back to http (auto)", async () => {
    expect(await resolveCloudRendering(opts({ signedIn: false }))).toEqual({
      mode: "http",
      consented: false,
    });
  });

  test("offline falls back to http even when signed in", async () => {
    expect(
      await resolveCloudRendering(opts({ args: { offline: true } }))
    ).toEqual({ mode: "http", consented: false });
  });

  test("accepted WITH spend ack (capped) skips the prefetch confirm", async () => {
    expect(
      await resolveCloudRendering(opts({ consent: "accepted", spendAck: true }))
    ).toEqual({ mode: "browser", consented: true });
  });

  test("signed-in + spend ack but UNCAPPED (max_credits=0) keeps the confirm", async () => {
    expect(
      await resolveCloudRendering(
        opts({
          spendAck: true,
          estimate: { maxPages: 25, balance: 100, maxCredits: 0 },
        })
      )
    ).toEqual({ mode: "browser", consented: false });
  });

  test("declined stays http, not consented (standing opt-out)", async () => {
    expect(await resolveCloudRendering(opts({ consent: "declined" }))).toEqual({
      mode: "http",
      consented: false,
    });
  });

  test("--render opts into rendering but NOT blanket consent", async () => {
    // browser mode without consent ⇒ the post-crawl spend gate still applies.
    const decision = await resolveCloudRendering(
      opts({ args: { render: true } })
    );
    expect(decision).toEqual({ mode: "browser", consented: false });
  });
});

describe("login implies cloud consent (#368)", () => {
  test("signed-in, never-asked: renders + consented, discloses once, persists ack", async () => {
    const updates: Partial<Record<string, unknown>>[] = [];
    const lines: string[] = [];
    const decision = await resolveCloudRendering(
      opts({
        consent: undefined,
        spendAck: undefined,
        log: (m) => lines.push(m),
        persist: (u) => (updates.push(u), { ok: true }),
      })
    );
    // No blocking prompt — cloud on by default, prefetch confirm skipped (capped).
    expect(decision).toEqual({
      mode: "browser",
      consented: true,
      disclosed: true,
    });
    expect(updates).toEqual([{ cloud_spend_ack: true }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("100 credits"); // 50 base + computeCost("render", 25)
    expect(lines[0]).toContain("Cloud audits are on");
  });

  test("--yes signed-in renders + consented (no surprise-spend opt-out anymore)", async () => {
    expect(
      await resolveCloudRendering(opts({ args: { yes: true }, spendAck: true }))
    ).toEqual({ mode: "browser", consented: true });
  });

  test("non-interactive signed-in renders + consented", async () => {
    // Disclosure is non-blocking (printed, not prompted) so CI/pipes proceed.
    expect(await resolveCloudRendering(opts({ spendAck: true }))).toEqual({
      mode: "browser",
      consented: true,
    });
  });

  test("already disclosed (spendAck true): no notice, nothing persisted", async () => {
    const updates: unknown[] = [];
    const lines: string[] = [];
    const decision = await resolveCloudRendering(
      opts({
        spendAck: true,
        log: (m) => lines.push(m),
        persist: (u) => (updates.push(u), { ok: true }),
      })
    );
    expect(decision).toEqual({ mode: "browser", consented: true });
    expect(updates).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  test("uncapped (max_credits=0): discloses without the disable hint, keeps confirm", async () => {
    const lines: string[] = [];
    const updates: unknown[] = [];
    const decision = await resolveCloudRendering(
      opts({
        spendAck: null,
        estimate: { maxPages: 10, balance: 100, maxCredits: 0 },
        log: (m) => lines.push(m),
        persist: (u) => (updates.push(u), { ok: true }),
      })
    );
    // Uncapped ⇒ the prefetch confirm still guards unbounded spend.
    expect(decision).toEqual({
      mode: "browser",
      consented: false,
      disclosed: true,
    });
    expect(lines[0]).toContain("70 credits"); // 50 base + 2 × 10
    expect(lines[0]).not.toContain("Disable with");
    // Ack is still persisted; a later capped run then skips the confirm.
    expect(updates).toEqual([{ cloud_spend_ack: true }]);
  });

  test("failed persist keeps the confirm this run (re-notifies next run)", async () => {
    const decision = await resolveCloudRendering(
      opts({ spendAck: null, persist: () => ({ ok: false }) })
    );
    expect(decision).toEqual({
      mode: "browser",
      consented: false,
      disclosed: true,
    });
  });
});

describe("consentEstimateLine (#191 up-front cost)", () => {
  test("shows base + per-page cost, page ceiling, cap, and balance", () => {
    const line = consentEstimateLine({
      maxPages: 25,
      balance: 17000,
      maxCredits: 1000,
    });
    // Pricing v11 (#2290): 50 audit base + computeCost("audit_page", 25) = 2 × 25.
    expect(line).toContain("100 credits");
    expect(line).toContain("50 audit base");
    expect(line).toContain("up to 25 audited pages");
    expect(line).toContain("however the page is fetched");
    expect(line).toContain("up to 1000 credits/audit");
    expect(line).toContain("17,000"); // locale-formatted balance
    expect(line).not.toContain("cloud browser");
    // No external link reserve unless the audit's links go to the cloud.
    expect(line).not.toContain("external links");
  });

  test("#801: an audit whose links the cloud checks reserves one link per page", () => {
    const line = consentEstimateLine({
      maxPages: 25,
      balance: 17000,
      maxCredits: 1000,
      externalLinks: true,
    });
    // 50 base + 2 × 25 pages + 1 × 25 links.
    expect(line).toContain("About 125 credits");
    expect(line).toContain(
      "up to 25 for external links (1 each the cloud verifies, at most 1 per page)"
    );
  });

  test("omits the cap note when uncapped (max_credits_per_audit = 0)", () => {
    const line = consentEstimateLine({
      maxPages: 10,
      balance: null,
      maxCredits: 0,
    });
    expect(line).toContain("70 credits"); // 50 base + 2 × 10
    expect(line).not.toContain("credits/audit");
    expect(line).not.toContain("Balance:"); // null balance → omitted
  });

  test("zero balance is shown (warns an empty account), not omitted", () => {
    // balance != null guard: 0 is falsy but not null, so it renders.
    const line = consentEstimateLine({
      maxPages: 5,
      balance: 0,
      maxCredits: 1000,
    });
    expect(line).toContain("Balance: 0 credits");
  });

  test("singular page label when maxPages = 1", () => {
    const line = consentEstimateLine({
      maxPages: 1,
      balance: null,
      maxCredits: 0,
    });
    expect(line).toContain("up to 1 audited page (");
    expect(line).not.toContain("1 audited pages");
  });
});

describe("validateAuditFlags: ephemeral (#3649)", () => {
  test("accepts --ephemeral with --publish (an explicit publish wins)", () => {
    expect(validateAuditFlags({ ephemeral: true, publish: true })).toBeNull();
  });

  test("refuses --ephemeral with --no-ephemeral", () => {
    expect(
      validateAuditFlags({ ephemeral: true, noEphemeral: true })
    ).toContain("--no-ephemeral");
  });

  test("accepts --ephemeral with --offline and --no-publish", () => {
    expect(validateAuditFlags({ ephemeral: true, offline: true })).toBeNull();
    expect(validateAuditFlags({ ephemeral: true, noPublish: true })).toBeNull();
  });
});

describe("validateAuditFlags", () => {
  test("--render + --http is rejected", () => {
    expect(validateAuditFlags({ render: true, http: true })).toBe(
      "--render and --http cannot be combined"
    );
  });

  test("--offline + --render is rejected", () => {
    expect(validateAuditFlags({ offline: true, render: true })).toMatch(
      /--offline cannot be combined with --render/
    );
  });

  test("--offline + --publish is rejected (publish takes precedence in message)", () => {
    expect(
      validateAuditFlags({ offline: true, publish: true, render: true })
    ).toMatch(/--offline cannot be combined with --publish/);
  });

  test("--no-publish + --publish is rejected", () => {
    expect(validateAuditFlags({ noPublish: true, publish: true })).toBe(
      "--no-publish cannot be combined with --publish"
    );
  });

  test("valid single flags pass", () => {
    expect(validateAuditFlags({ render: true })).toBeNull();
    expect(validateAuditFlags({ http: true })).toBeNull();
    expect(validateAuditFlags({ offline: true })).toBeNull();
    expect(validateAuditFlags({ noPublish: true })).toBeNull();
    expect(validateAuditFlags({})).toBeNull();
  });
});

describe("the one-time link pricing notice (#801)", () => {
  const due = (
    over: Partial<Parameters<typeof linkPricingNoticeDue>[0]> = {}
  ) =>
    linkPricingNoticeDue({
      registers: true,
      externalLinks: true,
      shown: false,
      disclosedThisRun: false,
      ...over,
    });

  test("only for an audit that registers and has the cloud check its links, once", () => {
    expect(due()).toBe(true);
    expect(due({ shown: true })).toBe(false);
    expect(due({ externalLinks: false })).toBe(false);
    expect(due({ registers: false })).toBe(false);
  });

  test("not when this run printed the cost line, which already prices the links", () => {
    expect(due({ disclosedThisRun: true })).toBe(false);
  });

  test("a run that skips the cost line (--http, --render, a config render, a decline) still gets the notice", async () => {
    // Only the first-time disclosure says `disclosed`; every other way through
    // resolveCloudRendering leaves the notice owed.
    const first = await resolveCloudRendering(opts({ spendAck: undefined }));
    expect(first.disclosed).toBe(true);
    for (const over of [
      { args: { http: true } },
      { args: { render: true } },
      { configRendering: "browser" as const },
      { consent: "declined" as const },
      { spendAck: true },
    ]) {
      const decision = await resolveCloudRendering(opts(over));
      expect(decision.disclosed).toBeUndefined();
      expect(due({ disclosedThisRun: decision.disclosed === true })).toBe(true);
    }
  });

  test("the consent line that priced the links also marks the notice shown", async () => {
    const updates: Partial<Record<string, unknown>>[] = [];
    await resolveCloudRendering(
      opts({
        spendAck: undefined,
        estimate: {
          maxPages: 25,
          balance: 1000,
          maxCredits: 1000,
          externalLinks: true,
        },
        persist: (u) => (updates.push(u), { ok: true }),
      })
    );
    expect(updates).toEqual([
      { cloud_spend_ack: true, link_pricing_notice_shown: true },
    ]);
  });

  test("names the price, its cap and the way out, and never offers --offline (which checks no links)", () => {
    expect(LINK_PRICING_NOTICE).toContain(
      "1 per external link the cloud verifies for this audit"
    );
    expect(LINK_PRICING_NOTICE).toContain(
      "at most 1 per page of the audit's page limit"
    );
    expect(LINK_PRICING_NOTICE).not.toContain("audited page");
    expect(LINK_PRICING_NOTICE).toContain("--no-external-links");
    expect(LINK_PRICING_NOTICE).not.toContain("--offline");
  });
});
