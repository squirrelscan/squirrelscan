import { describe, expect, test } from "bun:test";

import {
  consentEstimateLine,
  formatCloudSpendSummary,
  phaseTimingsFromError,
  resolveCloudRendering,
  resolveExplicitRenderMode,
  validateAuditFlags,
} from "../../src/cli/commands/audit";

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

describe("formatCloudSpendSummary", () => {
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
    expect(decision).toEqual({ mode: "browser", consented: true });
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
    expect(decision).toEqual({ mode: "browser", consented: false });
    expect(lines[0]).toContain("70 credits"); // 50 base + 2 × 10
    expect(lines[0]).not.toContain("Disable with");
    // Ack is still persisted; a later capped run then skips the confirm.
    expect(updates).toEqual([{ cloud_spend_ack: true }]);
  });

  test("failed persist keeps the confirm this run (re-notifies next run)", async () => {
    const decision = await resolveCloudRendering(
      opts({ spendAck: null, persist: () => ({ ok: false }) })
    );
    expect(decision).toEqual({ mode: "browser", consented: false });
  });
});

describe("consentEstimateLine (#191 up-front cost)", () => {
  test("shows base + render cost, page ceiling, cap, and balance", () => {
    const line = consentEstimateLine({
      maxPages: 25,
      balance: 17000,
      maxCredits: 1000,
    });
    // Pricing v10: 50 audit base + computeCost("render", 25) = 2 × 25.
    expect(line).toContain("100 credits");
    expect(line).toContain("50 audit base");
    expect(line).toContain("up to 25 pages");
    expect(line).toContain("up to 1000 credits/audit");
    expect(line).toContain("17,000"); // locale-formatted balance
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
    expect(line).toContain("up to 1 page,");
    expect(line).not.toContain("1 pages");
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
    expect(validateAuditFlags({ no_publish: true, publish: true })).toBe(
      "--no-publish cannot be combined with --publish"
    );
    // citty camelCase key is accepted too
    expect(validateAuditFlags({ noPublish: true, publish: true })).toBe(
      "--no-publish cannot be combined with --publish"
    );
  });

  test("valid single flags pass", () => {
    expect(validateAuditFlags({ render: true })).toBeNull();
    expect(validateAuditFlags({ http: true })).toBeNull();
    expect(validateAuditFlags({ offline: true })).toBeNull();
    expect(validateAuditFlags({ no_publish: true })).toBeNull();
    expect(validateAuditFlags({})).toBeNull();
  });
});
