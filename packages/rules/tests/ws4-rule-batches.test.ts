// WS4 — metadata-gated rule batches. For one representative rule per batch we
// assert: (a) it skips / behaves passively when metadata makes it non-applicable,
// (b) it runs / escalates when applicable, (c) it is unchanged when
// ctx.siteMetadata is undefined (offline / free). Plus direct coverage of the new
// subprocessor-disclosure rule and the social-presence cross-check.

import { describe, expect, test } from "bun:test";

import type { CheckResult, SiteMetadata } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { ruleApplies } from "../src/applicability";
import { cookieConsentRule } from "../src/legal/cookie-consent";
import { privacyPolicyRule } from "../src/legal/privacy-policy";
import { subprocessorDisclosureRule } from "../src/legal/subprocessor-disclosure";
import { napConsistencyRule } from "../src/local/nap-consistency";
import { organizationSchemaRule } from "../src/schema/organization";
import { socialProfilesRule } from "../src/social/social-profiles";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

// ── Helpers ─────────────────────────────────────────────────────────

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

function siteCtx(
  pagesHtml: { url: string; html: string }[],
  siteMetadata?: SiteMetadata,
): RuleContext {
  const pages: SiteData["pages"] = pagesHtml.map((p) => ({
    url: p.url,
    statusCode: 200,
    parsed: parsePage(p.html, p.url),
  }));
  return {
    page: { url: pages[0]?.url ?? "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: pages[0]?.parsed ?? ({} as ParsedPage),
    site: { baseUrl: "https://example.com", pages, robotsTxt: null, sitemaps: null },
    siteMetadata,
    options: {},
  };
}

function pageCtx(url: string, html: string, siteMetadata?: SiteMetadata): RuleContext {
  const parsed = parsePage(html, url);
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed,
    siteMetadata,
    options: {},
  };
}

async function run(rule: Rule, ctx: RuleContext): Promise<CheckResult[]> {
  return (await rule.run(ctx)).checks;
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

// ── Batch 1: privacy/legal by jurisdiction ──────────────────────────

describe("Batch 1 — legal/privacy-policy escalation", () => {
  const noPrivacyPage = { url: "https://example.com/", html: "<html><body><a href='/about'>About</a></body></html>" };

  test("(c) undefined metadata → warn (unchanged behaviour)", async () => {
    const checks = await run(privacyPolicyRule, siteCtx([noPrivacyPage], undefined));
    const c = check(checks, "privacy-policy");
    expect(c?.status).toBe("warn");
    expect(c?.message).not.toContain("required under");
  });

  test("(b) GDPR audience + missing → escalates to fail", async () => {
    const checks = await run(privacyPolicyRule, siteCtx([noPrivacyPage], meta({ primaryCountry: "DE" })));
    const c = check(checks, "privacy-policy");
    expect(c?.status).toBe("fail");
    expect(c?.message).toContain("GDPR");
  });

  test("(b) CCPA (US) audience + missing → escalates to fail", async () => {
    const checks = await run(privacyPolicyRule, siteCtx([noPrivacyPage], meta({ primaryCountry: "US" })));
    const c = check(checks, "privacy-policy");
    expect(c?.status).toBe("fail");
    expect(c?.message).toContain("CCPA");
  });

  test("present policy still passes regardless of jurisdiction", async () => {
    const page = { url: "https://example.com/", html: "<a href='/privacy-policy'>Privacy</a>" };
    const checks = await run(privacyPolicyRule, siteCtx([page], meta({ primaryCountry: "DE" })));
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });
});

describe("Batch 1 — legal/cookie-consent gating + escalation", () => {
  test("(a) personal site → gated out (visible skip via ruleApplies)", () => {
    const v = ruleApplies(cookieConsentRule.meta.appliesWhen, meta({ siteType: "personal" }));
    expect(v.applies).toBe(false);
  });

  test("ecommerce site → applicable", () => {
    const v = ruleApplies(cookieConsentRule.meta.appliesWhen, meta({ siteType: "ecommerce" }));
    expect(v.applies).toBe(true);
  });

  test("(b) GDPR audience + no consent mechanism → escalates to warn", async () => {
    const checks = await run(cookieConsentRule, pageCtx("https://example.com/", "<html><body>hi</body></html>", meta({ audienceScope: "global" })));
    const c = check(checks, "cookie-consent");
    expect(c?.status).toBe("warn");
    expect(c?.message).toContain("GDPR");
  });

  test("(c) undefined metadata + no consent → info (unchanged)", async () => {
    const checks = await run(cookieConsentRule, pageCtx("https://example.com/", "<html><body>hi</body></html>", undefined));
    expect(check(checks, "cookie-consent")?.status).toBe("info");
  });
});

describe("Batch 1 — legal/subprocessor-disclosure (new rule)", () => {
  test("appliesWhen gates to tech/business site types (closes the null-category false positive)", () => {
    const ap = (m: SiteMetadata) =>
      ruleApplies(subprocessorDisclosureRule.meta.appliesWhen, m).applies;
    // Tech site type + a declared data-heavy category → applies.
    expect(ap(meta({ siteType: "saas", businessCategory: "software_technology" }))).toBe(true);
    // Tech site type + NULL category → STILL applies. This is the key fix: a SaaS
    // whose fine-grained business category came back null is no longer suppressed.
    expect(ap(meta({ siteType: "saas", businessCategory: null }))).toBe(true);
    // Non-tech site type with a null category → GATED. Previously a personal blog /
    // news site (category null) wrongly fired this warning.
    expect(ap(meta({ siteType: "personal", businessCategory: null }))).toBe(false);
    expect(ap(meta({ siteType: "blog", businessCategory: null }))).toBe(false);
    // Tech site type but a KNOWN non-data category → gated by businessCategories.
    expect(ap(meta({ siteType: "saas", businessCategory: "restaurant" }))).toBe(false);
  });

  test("disclosure page present (by URL path) → pass", async () => {
    const ctx = siteCtx([
      { url: "https://saas.example.com/", html: "<a href='/legal'>Legal</a>" },
      { url: "https://saas.example.com/subprocessors", html: "<h1>Sub-processors</h1>" },
    ]);
    const c = check(await run(subprocessorDisclosureRule, ctx), "subprocessor-disclosure");
    expect(c?.status).toBe("pass");
  });

  test("DPA link present (by anchor text) → pass", async () => {
    const ctx = siteCtx([
      { url: "https://saas.example.com/", html: "<a href='/legal/agreement'>Data Processing Agreement</a>" },
    ]);
    const c = check(await run(subprocessorDisclosureRule, ctx), "subprocessor-disclosure");
    expect(c?.status).toBe("pass");
  });

  test("disclosure absent → warn", async () => {
    const ctx = siteCtx([{ url: "https://saas.example.com/", html: "<a href='/pricing'>Pricing</a>" }]);
    const c = check(await run(subprocessorDisclosureRule, ctx), "subprocessor-disclosure");
    expect(c?.status).toBe("warn");
  });
});

// ── Batch 2: EEAT by YMYL/type ──────────────────────────────────────

describe("Batch 2 — eeat gating declarations", () => {
  test("disclaimers gated to YMYL", () => {
    const { disclaimersRule } = require("../src/eeat/disclaimers");
    expect(disclaimersRule.meta.appliesWhen).toEqual({ requiresYMYL: true });
    expect(ruleApplies(disclaimersRule.meta.appliesWhen, meta({ isYMYL: false })).applies).toBe(false);
    expect(ruleApplies(disclaimersRule.meta.appliesWhen, meta({ isYMYL: true })).applies).toBe(true);
  });

  test("author-byline gated to content site types (skips saas, runs blog)", () => {
    const { authorBylineRule } = require("../src/eeat/author-byline");
    expect(ruleApplies(authorBylineRule.meta.appliesWhen, meta({ siteType: "saas" })).applies).toBe(false);
    expect(ruleApplies(authorBylineRule.meta.appliesWhen, meta({ siteType: "blog" })).applies).toBe(true);
  });

  test("(c) undefined metadata → all eeat-gated rules still apply", () => {
    const { citationsRule } = require("../src/eeat/citations");
    expect(ruleApplies(citationsRule.meta.appliesWhen, undefined).applies).toBe(true);
  });

  test("universally-useful eeat rules remain UNGATED", () => {
    const { aboutPageRule } = require("../src/eeat/about-page");
    const { contactPageRule } = require("../src/eeat/contact-page");
    const { trustSignalsRule } = require("../src/eeat/trust-signals");
    expect(aboutPageRule.meta.appliesWhen).toBeUndefined();
    expect(contactPageRule.meta.appliesWhen).toBeUndefined();
    expect(trustSignalsRule.meta.appliesWhen).toBeUndefined();
  });
});

// ── Batch 3: local-business gating ──────────────────────────────────

describe("Batch 3 — local-business gating", () => {
  test("nap-consistency declares requiresLocalBusiness", () => {
    expect(napConsistencyRule.meta.appliesWhen).toEqual({ requiresLocalBusiness: true });
  });

  test("(a) global SaaS → gated out", () => {
    expect(ruleApplies(napConsistencyRule.meta.appliesWhen, meta({ siteType: "saas", isLocalBusiness: false })).applies).toBe(false);
  });

  test("(b) local business → applicable + runs", async () => {
    const v = ruleApplies(napConsistencyRule.meta.appliesWhen, meta({ isLocalBusiness: true }));
    expect(v.applies).toBe(true);
    const ctx = siteCtx([{ url: "https://shop.example.com/", html: "<a href='/contact'>Contact</a>" }], meta({ isLocalBusiness: true }));
    const checks = await run(napConsistencyRule, ctx);
    expect(checks.length).toBeGreaterThan(0);
  });

  test("(c) undefined metadata → applies (runs as today)", () => {
    expect(ruleApplies(napConsistencyRule.meta.appliesWhen, undefined).applies).toBe(true);
  });

  test("all four local-gated rules carry requiresLocalBusiness", () => {
    const { geoMetaRule, serviceAreaRule } = require("../src/local");
    const { localBusinessSchemaRule } = require("../src/schema/local-business");
    const { physicalAddressRule } = require("../src/eeat/physical-address");
    for (const r of [geoMetaRule, serviceAreaRule, localBusinessSchemaRule, physicalAddressRule]) {
      expect(r.meta.appliesWhen).toEqual({ requiresLocalBusiness: true });
    }
  });
});

// ── Batch 4: social-presence validation ─────────────────────────────

describe("Batch 4 — social-presence cross-check", () => {
  const detected = meta({
    siteType: "corporate",
    socials: [
      { platform: "linkedin", url: "https://linkedin.com/company/acme" },
      { platform: "x", url: "https://x.com/acme", handle: "acme" },
    ],
  });

  test("social-profiles gated to brand site types", () => {
    expect(ruleApplies(socialProfilesRule.meta.appliesWhen, meta({ siteType: "corporate" })).applies).toBe(true);
    expect(ruleApplies(socialProfilesRule.meta.appliesWhen, meta({ siteType: "docs" })).applies).toBe(false);
  });

  test("(b) MISSING account → social-profiles-missing warn", async () => {
    // Page links only LinkedIn; X is detected-but-unlinked → flagged.
    const html = "<a href='https://linkedin.com/company/acme'>LinkedIn</a>";
    const checks = await run(socialProfilesRule, pageCtx("https://acme.com/", html, detected));
    const missing = check(checks, "social-profiles-missing");
    expect(missing?.status).toBe("warn");
    expect(missing?.items?.some((i) => i.id.includes("x.com/acme"))).toBe(true);
    // Not flagging the linked LinkedIn account.
    expect(missing?.items?.some((i) => i.id.includes("linkedin"))).toBe(false);
  });

  test("(b) CONSISTENT (all linked) → no missing check", async () => {
    const html =
      "<a href='https://linkedin.com/company/acme'>LinkedIn</a><a href='https://x.com/acme'>X</a>";
    const checks = await run(socialProfilesRule, pageCtx("https://acme.com/", html, detected));
    expect(check(checks, "social-profiles-missing")).toBeUndefined();
  });

  test("(c) undefined metadata → no cross-check, base behaviour intact", async () => {
    const html = "<a href='https://linkedin.com/company/acme'>LinkedIn</a>";
    const checks = await run(socialProfilesRule, pageCtx("https://acme.com/", html, undefined));
    expect(check(checks, "social-profiles-missing")).toBeUndefined();
    expect(check(checks, "social-profiles")?.status).toBe("pass");
  });

  test("schema/organization sameAs cross-check flags missing account", async () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Organization",
      name: "Acme",
      url: "https://acme.com",
      sameAs: ["https://linkedin.com/company/acme"],
    })}</script>`;
    const checks = await run(organizationSchemaRule, pageCtx("https://acme.com/", html, detected));
    const missing = check(checks, "organization-sameas-missing");
    expect(missing?.status).toBe("warn");
    expect(missing?.items?.some((i) => i.id.includes("x.com/acme"))).toBe(true);
  });

  test("URL matching: www / trailing-slash / http variants are treated as linked", async () => {
    const m = meta({
      siteType: "corporate",
      socials: [{ platform: "linkedin", url: "https://linkedin.com/company/acme" }],
    });
    // Page links the same account via www + trailing slash + http.
    const html = "<a href='http://www.linkedin.com/company/acme/'>LinkedIn</a>";
    const checks = await run(socialProfilesRule, pageCtx("https://acme.com/", html, m));
    expect(check(checks, "social-profiles-missing")).toBeUndefined();
  });

  test("URL matching: prefix collision is NOT a false match", async () => {
    const m = meta({
      siteType: "corporate",
      socials: [{ platform: "x", url: "https://x.com/acme" }],
    });
    // Page links a DIFFERENT account that shares a path prefix → still missing.
    const html = "<a href='https://x.com/acme-support'>X support</a>";
    const checks = await run(socialProfilesRule, pageCtx("https://acme.com/", html, m));
    const missing = check(checks, "social-profiles-missing");
    expect(missing?.status).toBe("warn");
    expect(missing?.items?.some((i) => i.id.includes("x.com/acme"))).toBe(true);
  });

  test("URL matching: bare-host platform link does NOT satisfy a specific account", async () => {
    const m = meta({
      siteType: "corporate",
      socials: [{ platform: "x", url: "https://x.com/acme" }],
    });
    const html = "<a href='https://x.com'>X</a>";
    const checks = await run(socialProfilesRule, pageCtx("https://acme.com/", html, m));
    expect(check(checks, "social-profiles-missing")?.status).toBe("warn");
  });

  test("schema/organization sameAs cross-check is a no-op without metadata", async () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Organization",
      name: "Acme",
      url: "https://acme.com",
      sameAs: ["https://linkedin.com/company/acme"],
    })}</script>`;
    const checks = await run(organizationSchemaRule, pageCtx("https://acme.com/", html, undefined));
    expect(check(checks, "organization-sameas-missing")).toBeUndefined();
  });
});
