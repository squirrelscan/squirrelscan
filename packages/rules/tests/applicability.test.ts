import { describe, expect, test } from "bun:test";

import type { SiteMetadata } from "@squirrelscan/core-contracts";

import { APPLICABILITY_MIN_CONFIDENCE, ruleApplies } from "../src/applicability";
import type { RuleApplicability } from "../src/types";

// A high-confidence baseline profile; individual tests tweak fields.
function meta(overrides: Partial<SiteMetadata> = {}): SiteMetadata {
  return {
    siteType: "blog",
    businessCategory: null,
    primaryCountry: null,
    audienceScope: null,
    isYMYL: false,
    isLocalBusiness: false,
    hasOwnershipVerified: false,
    confidence: "high",
    ...overrides,
  };
}

describe("ruleApplies — backward-compat / graceful-degradation", () => {
  test("no appliesWhen declaration → applies", () => {
    expect(ruleApplies(undefined, meta())).toEqual({ applies: true });
  });

  test("no metadata (undefined) → applies (offline / free / no-credits)", () => {
    const decl: RuleApplicability = { siteTypes: ["saas"] };
    expect(ruleApplies(decl, undefined)).toEqual({ applies: true });
  });

  test("low confidence → applies (don't gate below threshold)", () => {
    const decl: RuleApplicability = { siteTypes: ["saas"] };
    // blog would otherwise fail siteTypes:[saas], but low confidence wins.
    expect(ruleApplies(decl, meta({ confidence: "low" }))).toEqual({ applies: true });
  });

  test("APPLICABILITY_MIN_CONFIDENCE is 'medium'", () => {
    expect(APPLICABILITY_MIN_CONFIDENCE).toBe("medium");
  });

  test("medium confidence DOES gate (at threshold)", () => {
    const decl: RuleApplicability = { siteTypes: ["saas"] };
    const v = ruleApplies(decl, meta({ confidence: "medium", siteType: "blog" }));
    expect(v.applies).toBe(false);
  });
});

describe("ruleApplies — requiresYMYL", () => {
  test("required + not YMYL → not applicable", () => {
    const v = ruleApplies({ requiresYMYL: true }, meta({ isYMYL: false }));
    expect(v.applies).toBe(false);
    if (!v.applies) expect(v.reason).toContain("YMYL");
  });
  test("required + is YMYL → applies", () => {
    expect(ruleApplies({ requiresYMYL: true }, meta({ isYMYL: true }))).toEqual({ applies: true });
  });
});

describe("ruleApplies — requiresLocalBusiness", () => {
  test("required + not local → not applicable", () => {
    const v = ruleApplies({ requiresLocalBusiness: true }, meta({ isLocalBusiness: false }));
    expect(v.applies).toBe(false);
    if (!v.applies) expect(v.reason).toContain("local business");
  });
  test("required + is local → applies", () => {
    expect(ruleApplies({ requiresLocalBusiness: true }, meta({ isLocalBusiness: true }))).toEqual({
      applies: true,
    });
  });
});

describe("ruleApplies — requiresOwnership", () => {
  test("required + not verified → not applicable", () => {
    const v = ruleApplies({ requiresOwnership: true }, meta({ hasOwnershipVerified: false }));
    expect(v.applies).toBe(false);
    if (!v.applies) expect(v.reason).toContain("ownership");
  });
  test("required + verified → applies", () => {
    expect(ruleApplies({ requiresOwnership: true }, meta({ hasOwnershipVerified: true }))).toEqual({
      applies: true,
    });
  });
});

describe("ruleApplies — siteTypes", () => {
  test("not in list → not applicable, reason names the type", () => {
    const v = ruleApplies({ siteTypes: ["saas", "web_app"] }, meta({ siteType: "blog" }));
    expect(v.applies).toBe(false);
    if (!v.applies) expect(v.reason).toBe('site type is "blog"');
  });
  test("in list → applies", () => {
    expect(ruleApplies({ siteTypes: ["blog", "news"] }, meta({ siteType: "blog" }))).toEqual({
      applies: true,
    });
  });
});

describe("ruleApplies — businessCategories", () => {
  test("category set + excluded → not applicable", () => {
    const v = ruleApplies(
      { businessCategories: ["legal", "fintech"] },
      meta({ businessCategory: "restaurant" }),
    );
    expect(v.applies).toBe(false);
    if (!v.applies) expect(v.reason).toContain("restaurant");
  });
  test("category set + included → applies", () => {
    expect(
      ruleApplies({ businessCategories: ["legal"] }, meta({ businessCategory: "legal" })),
    ).toEqual({ applies: true });
  });
  test("category null/unknown → does NOT gate (applies)", () => {
    expect(
      ruleApplies({ businessCategories: ["legal"] }, meta({ businessCategory: null })),
    ).toEqual({ applies: true });
  });
});

describe("ruleApplies — countries", () => {
  test("country set + excluded → not applicable", () => {
    const v = ruleApplies({ countries: ["US", "CA"] }, meta({ primaryCountry: "DE" }));
    expect(v.applies).toBe(false);
    if (!v.applies) expect(v.reason).toContain("DE");
  });
  test("country set + included → applies", () => {
    expect(ruleApplies({ countries: ["US"] }, meta({ primaryCountry: "US" }))).toEqual({
      applies: true,
    });
  });
  test("country null → does NOT gate (applies)", () => {
    expect(ruleApplies({ countries: ["US"] }, meta({ primaryCountry: null }))).toEqual({
      applies: true,
    });
  });
});

describe("ruleApplies — audiences", () => {
  test("audienceScope set + no overlap → not applicable", () => {
    const v = ruleApplies({ audiences: ["global", "national"] }, meta({ audienceScope: "local" }));
    expect(v.applies).toBe(false);
    if (!v.applies) expect(v.reason).toContain("local");
  });
  test("audienceScope set + overlap → applies", () => {
    expect(
      ruleApplies({ audiences: ["local", "regional"] }, meta({ audienceScope: "local" })),
    ).toEqual({ applies: true });
  });
  test("audienceScope null → does NOT gate (applies)", () => {
    expect(ruleApplies({ audiences: ["global"] }, meta({ audienceScope: null }))).toEqual({
      applies: true,
    });
  });
});

describe("ruleApplies — AND across keys", () => {
  test("all conditions pass → applies", () => {
    const decl: RuleApplicability = {
      siteTypes: ["healthcare_provider"],
      requiresYMYL: true,
      countries: ["US"],
    };
    const v = ruleApplies(
      decl,
      meta({ siteType: "healthcare_provider", isYMYL: true, primaryCountry: "US" }),
    );
    expect(v).toEqual({ applies: true });
  });
  test("first failing condition short-circuits (boolean checked before lists)", () => {
    const decl: RuleApplicability = { siteTypes: ["saas"], requiresYMYL: true };
    const v = ruleApplies(decl, meta({ siteType: "saas", isYMYL: false }));
    expect(v.applies).toBe(false);
    if (!v.applies) expect(v.reason).toContain("YMYL");
  });
});
