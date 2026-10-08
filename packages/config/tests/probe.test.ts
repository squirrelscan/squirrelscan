import { describe, expect, test } from "bun:test";

import {
  ConfigSchema,
  DEFAULT_PROBE_BUDGET_MS,
  defaultProbeLevel,
  formatProbeBudget,
  normalizeProbeLevel,
  parseProbeBudget,
  type ProbeLevel,
  type ProbeRunContext,
  resolveProbeIntensity,
} from "../src";

const LOCAL_SIGNED_IN: ProbeRunContext = { surface: "local", signedIn: true };
const LOCAL_ANON: ProbeRunContext = { surface: "local", signedIn: false };
const CLOUD_VERIFIED: ProbeRunContext = { surface: "cloud", signedIn: true, ownershipVerified: true };
const CLOUD_UNVERIFIED: ProbeRunContext = { surface: "cloud", signedIn: true, ownershipVerified: false };

function resolved(input: Parameters<typeof resolveProbeIntensity>[0]) {
  const out = resolveProbeIntensity(input);
  if (!out.ok) throw new Error(`expected ok, got: ${out.error}`);
  return out.value;
}

function refused(input: Parameters<typeof resolveProbeIntensity>[0]) {
  const out = resolveProbeIntensity(input);
  if (out.ok) throw new Error(`expected an error, got level ${out.value.level}`);
  return out;
}

describe("normalizeProbeLevel", () => {
  test("accepts the three levels, case- and whitespace-insensitive", () => {
    expect(normalizeProbeLevel("passive")).toBe("passive");
    expect(normalizeProbeLevel(" Active ")).toBe("active");
    expect(normalizeProbeLevel("AGGRESSIVE")).toBe("aggressive");
  });

  test("anything else is null", () => {
    for (const raw of ["", "loud", "quiet", "full", "aggressive!", "nan"]) {
      expect(normalizeProbeLevel(raw)).toBeNull();
    }
  });
});

describe("parseProbeBudget", () => {
  test("units and bare seconds", () => {
    expect(parseProbeBudget("30s")).toBe(30_000);
    expect(parseProbeBudget("500ms")).toBe(500);
    expect(parseProbeBudget("2m")).toBe(120_000);
    expect(parseProbeBudget("1h")).toBe(3_600_000);
    expect(parseProbeBudget("1.5s")).toBe(1_500);
    expect(parseProbeBudget("45")).toBe(45_000);
    expect(parseProbeBudget(45)).toBe(45_000);
    expect(parseProbeBudget(" 10S ")).toBe(10_000);
  });

  // The coverage NaN-cap bug: a value that parses to NaN or Infinity is an
  // unbounded cap, because every `elapsed >= NaN` check is false.
  test("never returns NaN, Infinity, zero or a negative", () => {
    for (const raw of ["", "abc", "NaN", "Infinity", "-5s", "0", "0s", "30x", "s", "1e999", "30 seconds"]) {
      expect(parseProbeBudget(raw)).toBeNull();
    }
    for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(parseProbeBudget(raw)).toBeNull();
    }
  });

  test("refuses more than an hour", () => {
    expect(parseProbeBudget("61m")).toBeNull();
    expect(parseProbeBudget("2h")).toBeNull();
    expect(parseProbeBudget(3601)).toBeNull();
  });
});

describe("formatProbeBudget", () => {
  test("shortest readable form", () => {
    expect(formatProbeBudget(500)).toBe("500ms");
    expect(formatProbeBudget(30_000)).toBe("30s");
    expect(formatProbeBudget(120_000)).toBe("2m");
    expect(formatProbeBudget(90_000)).toBe("1m30s");
    expect(formatProbeBudget(1_500)).toBe("1500ms");
  });
});

describe("default level by context", () => {
  test.each([
    ["CLI local, signed in", LOCAL_SIGNED_IN, "active"],
    ["CLI local, anonymous", LOCAL_ANON, "passive"],
    ["cloud, ownership verified", CLOUD_VERIFIED, "active"],
    ["cloud, unverified", CLOUD_UNVERIFIED, "passive"],
  ] as const)("%s → %s", (_label, context, level) => {
    expect(defaultProbeLevel(context)).toBe(level);
    const value = resolved({ flags: {}, context });
    expect(value.level).toBe(level);
    expect(value.source).toBe("default");
    expect(value.budgetMs).toBe(DEFAULT_PROBE_BUDGET_MS[level]);
  });

  test("aggressive is never a default", () => {
    const contexts: ProbeRunContext[] = [];
    for (const surface of ["local", "cloud"] as const) {
      for (const signedIn of [true, false]) {
        for (const ownershipVerified of [true, false, undefined]) {
          contexts.push({ surface, signedIn, ownershipVerified });
        }
      }
    }
    for (const context of contexts) {
      expect(defaultProbeLevel(context)).not.toBe("aggressive");
    }
  });

  test("only cloud unverified is locked", () => {
    expect(resolved({ flags: {}, context: CLOUD_UNVERIFIED }).locked).toBe(true);
    for (const context of [LOCAL_SIGNED_IN, LOCAL_ANON, CLOUD_VERIFIED]) {
      expect(resolved({ flags: {}, context }).locked).toBe(false);
    }
  });
});

describe("precedence: --probe > shortcuts > [security] probe > default", () => {
  test("--probe beats [security] probe and the default", () => {
    const value = resolved({
      flags: { probe: "aggressive" },
      config: { probe: "passive" },
      context: LOCAL_ANON,
    });
    expect(value).toMatchObject({ level: "aggressive", source: "flag" });
  });

  test("--probe agreeing with its shortcut is fine", () => {
    expect(resolved({ flags: { probe: "aggressive", aggressive: true }, context: LOCAL_ANON }).level).toBe(
      "aggressive",
    );
    expect(resolved({ flags: { probe: "passive", passive: true }, context: LOCAL_SIGNED_IN }).level).toBe("passive");
  });

  test("--aggressive and --passive beat [security] probe", () => {
    expect(
      resolved({ flags: { aggressive: true }, config: { probe: "passive" }, context: LOCAL_ANON }),
    ).toMatchObject({ level: "aggressive", source: "shortcut" });
    expect(
      resolved({ flags: { passive: true }, config: { probe: "aggressive" }, context: LOCAL_SIGNED_IN }),
    ).toMatchObject({ level: "passive", source: "shortcut", budgetMs: 0 });
  });

  test("--pentest is --probe aggressive", () => {
    expect(resolved({ flags: { pentest: true }, context: LOCAL_ANON })).toMatchObject({
      level: "aggressive",
      source: "shortcut",
    });
  });

  test("[security] probe beats the context default", () => {
    expect(resolved({ flags: {}, config: { probe: "active" }, context: LOCAL_ANON })).toMatchObject({
      level: "active",
      source: "config",
    });
    expect(resolved({ flags: {}, config: { probe: "passive" }, context: LOCAL_SIGNED_IN })).toMatchObject({
      level: "passive",
      source: "config",
    });
  });
});

describe("budget precedence: --probe-budget > [security] budget > level default", () => {
  test("level defaults", () => {
    expect(resolved({ flags: { probe: "active" }, context: LOCAL_ANON }).budgetMs).toBe(30_000);
    expect(resolved({ flags: { probe: "aggressive" }, context: LOCAL_ANON }).budgetMs).toBe(120_000);
    expect(resolved({ flags: { probe: "passive" }, context: LOCAL_ANON }).budgetMs).toBe(0);
  });

  test("[security] budget overrides the level default", () => {
    expect(resolved({ flags: { probe: "active" }, config: { budget: "45s" }, context: LOCAL_ANON }).budgetMs).toBe(
      45_000,
    );
    expect(resolved({ flags: { probe: "active" }, config: { budget: 10 }, context: LOCAL_ANON }).budgetMs).toBe(10_000);
  });

  test("--probe-budget overrides [security] budget", () => {
    expect(
      resolved({
        flags: { probe: "active", probeBudget: "5s" },
        config: { budget: "45s" },
        context: LOCAL_ANON,
      }).budgetMs,
    ).toBe(5_000);
  });

  test("passive has no budget, whatever was asked for", () => {
    expect(
      resolved({ flags: { passive: true, probeBudget: "5m" }, config: { budget: "45s" }, context: LOCAL_ANON }).budgetMs,
    ).toBe(0);
  });
});

describe("validation", () => {
  test("an unknown --probe level is a clear error naming the valid ones", () => {
    const out = refused({ flags: { probe: "loud" }, context: LOCAL_SIGNED_IN });
    expect(out.error).toBe("unknown --probe level 'loud'. Valid: passive, active, aggressive.");
  });

  test("an invalid --probe-budget is refused, not turned into an unbounded cap", () => {
    for (const probeBudget of ["abc", "NaN", "0", "-1s", "2h"]) {
      const out = refused({ flags: { probe: "active", probeBudget }, context: LOCAL_SIGNED_IN });
      expect(out.error).toContain("--probe-budget must be a positive duration");
      expect(out.error).toContain(`'${probeBudget}'`);
    }
  });

  test("--passive with --aggressive is refused", () => {
    expect(refused({ flags: { passive: true, aggressive: true }, context: LOCAL_ANON }).error).toBe(
      "--passive and --aggressive cannot be combined",
    );
  });

  test("a shortcut with a conflicting --probe is refused", () => {
    expect(refused({ flags: { probe: "active", aggressive: true }, context: LOCAL_ANON }).error).toBe(
      "--aggressive cannot be combined with --probe active",
    );
    expect(refused({ flags: { probe: "aggressive", passive: true }, context: LOCAL_ANON }).error).toBe(
      "--passive cannot be combined with --probe aggressive",
    );
    expect(refused({ flags: { probe: "passive", pentest: true }, context: LOCAL_ANON }).error).toContain(
      "--pentest cannot be combined with --probe passive",
    );
    expect(refused({ flags: { pentest: true, passive: true }, context: LOCAL_ANON }).error).toContain(
      "--pentest and --passive cannot be combined",
    );
  });

  test("--pentest with a coverage other than full is refused", () => {
    expect(refused({ flags: { pentest: true }, context: LOCAL_ANON, coverage: "quick" }).error).toContain(
      "--pentest cannot be combined with --coverage quick",
    );
    expect(resolved({ flags: { pentest: true }, context: LOCAL_ANON, coverage: "Full" }).level).toBe("aggressive");
  });
});

describe("cloud, unverified ownership: locked to passive", () => {
  test.each(["active", "aggressive"] as ProbeLevel[])(
    "an explicit %s is refused with why it is locked and how to verify",
    (level) => {
      for (const flags of [{ probe: level }, level === "aggressive" ? { aggressive: true } : { probe: level }]) {
        const out = refused({ flags, context: CLOUD_UNVERIFIED });
        expect(out.locked).toBe(true);
        expect(out.error).toContain(`'${level}' cannot run`);
        expect(out.error).toContain("ownership is verified");
        expect(out.error).toContain("Verify ownership of the site in the squirrelscan dashboard");
      }
    },
  );

  test("[security] probe above passive is refused too, never silently downgraded", () => {
    const out = refused({ flags: {}, config: { probe: "aggressive" }, context: CLOUD_UNVERIFIED });
    expect(out.locked).toBe(true);
  });

  test("--pentest is refused", () => {
    expect(refused({ flags: { pentest: true }, context: CLOUD_UNVERIFIED }).locked).toBe(true);
  });

  test("an explicit passive is fine", () => {
    expect(resolved({ flags: { passive: true }, context: CLOUD_UNVERIFIED })).toMatchObject({
      level: "passive",
      locked: true,
    });
  });

  test("verified ownership unlocks aggressive", () => {
    expect(resolved({ flags: { aggressive: true }, context: CLOUD_VERIFIED }).level).toBe("aggressive");
  });
});

describe("disable_discovery_probes is honoured", () => {
  const disabled = (context: ProbeRunContext): ProbeRunContext => ({ ...context, discoveryProbesDisabled: true });

  test("the signed-in default resolves to passive with no budget and no notice", () => {
    expect(resolved({ flags: {}, context: disabled(LOCAL_SIGNED_IN) })).toMatchObject({
      level: "passive",
      budgetMs: 0,
      notices: [],
    });
  });

  test("an explicit level resolves to passive and says why", () => {
    for (const flags of [{ aggressive: true }, { probe: "active" }, { pentest: true }]) {
      const value = resolved({ flags, context: disabled(LOCAL_SIGNED_IN) });
      expect(value.level).toBe("passive");
      expect(value.budgetMs).toBe(0);
      expect(value.notices).toHaveLength(1);
      expect(value.notices[0]).toContain("discovery probes are disabled");
    }
    const fromConfig = resolved({ flags: {}, config: { probe: "aggressive" }, context: disabled(LOCAL_ANON) });
    expect(fromConfig.level).toBe("passive");
    expect(fromConfig.notices).toHaveLength(1);
  });

  test("flag validation still runs", () => {
    expect(refused({ flags: { probe: "bogus" }, context: disabled(LOCAL_ANON) }).error).toContain("unknown --probe");
  });
});

describe("[security] in the config schema", () => {
  test("absent is undefined, so the context default applies", () => {
    expect(ConfigSchema.parse({}).security).toBeUndefined();
  });

  test("probe and budget parse; budget stays as written", () => {
    const parsed = ConfigSchema.parse({ security: { probe: "active", budget: "30s" } });
    expect(parsed.security).toEqual({ probe: "active", budget: "30s" });
    // Re-parsing a parsed config is stable (no ms reread as seconds).
    expect(ConfigSchema.parse(parsed).security).toEqual({ probe: "active", budget: "30s" });
    expect(ConfigSchema.parse({ security: { budget: 45 } }).security?.budget).toBe(45);
  });

  test("an unknown probe or a bad budget fails validation", () => {
    expect(ConfigSchema.safeParse({ security: { probe: "loud" } }).success).toBe(false);
    for (const budget of ["abc", "0s", "2h", -1, 0]) {
      const out = ConfigSchema.safeParse({ security: { budget } });
      expect(out.success).toBe(false);
    }
  });
});
