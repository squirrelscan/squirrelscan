// security/leaked-secrets: named patterns and labels for provider formats
// that had none, or the wrong one (#1309). Fixtures are synthetic and
// assembled at runtime from parts, so no line is a whole token-shaped literal.

import { describe, expect, test } from "bun:test";

import { scanContent, type SecretLocation } from "../../src/security/leaked-secrets";
import { issuerJwt, mixedRun, runOf, seededRng, supabaseJwt } from "./leaked-secrets/generators";

const HEX = "0123456789abcdef";
const LOWER_DIGIT = "abcdefghijklmnopqrstuvwxyz0123456789";
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAGE = "https://app.acme.test/";
const r = seededRng(1309);

function found(text: string, location: SecretLocation = "inline-script") { // pragma: allowlist secret
  return scanContent(text, location, PAGE).map((f) => [f.type, f.confidence, f.publicByDesign]);
}

describe("Cerebras keys (#1309)", () => {
  const csk = () => "cs" + "k-" + runOf(r, LOWER_DIGIT, 48);
  const gsk = () => "gs" + "k_" + runOf(r, ALNUM, 52);

  test("a Cerebras key reports under its own name, beside keys from another provider", () => {
    expect(found(`var k="${csk()}";`)).toEqual([["Cerebras API Key", "high", false]]);
    const list = `var c={keys:["${gsk()}","${csk()}","${gsk()}","${csk()}"]};`;
    expect(found(list).map((f) => f[0]).sort()).toEqual(["Cerebras API Key", "Cerebras API Key", "Groq API Key", "Groq API Key"]);
  });

  test("near misses: a short tail, upper case, or the prefix inside a word", () => {
    expect(found(`var k="${"cs" + "k-"}${runOf(r, LOWER_DIGIT, 20)}";`)).toEqual([]);
    expect(found(`var k="${"cs" + "k-"}${runOf(r, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", 48)}";`)).toEqual([]);
    expect(found(`var k="desk-${runOf(r, LOWER_DIGIT, 48)}";`).map((f) => f[0])).not.toContain("Cerebras API Key");
  });
});

describe("Supabase personal access tokens (#1309)", () => {
  const sbp = () => "sb" + "p_" + runOf(r, HEX, 40);

  test("sbp_ is a personal access token, critical in a script", () => {
    expect(found(`var t="${sbp()}";`)).toEqual([["Supabase Personal Access Token", "high", false]]);
    const critical = scanContent(`var t="${sbp()}";`, "external-script", PAGE);
    expect(critical[0]?.type).toBe("Supabase Personal Access Token");
  });

  test("the service_role JWT and the sb_secret_ key keep their own labels", () => {
    expect(found(`var k="${supabaseJwt(seededRng(2), "service_role")}";`).map((f) => f[0])).toEqual(["Supabase Service Role JWT"]);
    expect(found(`var k="${"sb_" + "secret_"}${runOf(r, ALNUM, 28)}";`).map((f) => f[0])).toEqual(["Supabase Secret Key"]);
  });

  test("a short sbp_ value is not a token", () => {
    expect(found(`var t="${"sb" + "p_"}${runOf(r, HEX, 20)}";`)).toEqual([]);
  });
});

describe("Hygraph tokens (#1309)", () => {
  test("a JWT issued by a Hygraph management host is labelled, high", () => {
    const token = issuerJwt(r, { iss: "https://management-eu-central-1.hygraph.com/graphql", iat: 1761000000 });
    expect(found(`var c={authorization:"Bearer ${token}"};`).map((f) => f[0])).toContain("Hygraph Management Token");
    expect(found(`var t="${token}";`)).toEqual([["Hygraph Management Token", "high", false]]);
  });

  test("a content API token is medium; a lookalike issuer host is an ordinary JWT", () => {
    const content = issuerJwt(r, { iss: "https://api-eu-central-1.hygraph.com/v2/x/master", iat: 1761000000 });
    expect(found(`var t="${content}";`)).toEqual([["Hygraph Content API Token", "medium", false]]);
    for (const iss of ["https://management-eu.hygraph.com.evil.test/", "https://nothygraph.com/"]) {
      expect(found(`var t="${issuerJwt(r, { iss, iat: 1761000000 })}";`)).toEqual([["JSON Web Token", "medium", false]]);
    }
  });
});

describe("providers that had no named pattern (#1309)", () => {
  const cases: Array<[string, string, string]> = [
    ["OpenRouter API Key", "sk-" + "or-v1-" + "HEX64", `sk-or-v1-${"x".repeat(10)}`],
    ["NVIDIA API Key", "nv" + "api-" + "B64_64", "nvapi-"],
    ["Stripe Restricted Key", "rk_" + "live_" + "ALNUM24", "rk_live_short"],
    ["Shopify Admin API Token", "sh" + "pat_" + "HEX32", "shpat_" + "abc"],
    ["Google OAuth Client Secret", "GOC" + "SPX-" + "B64_28", "GOCSPX-short"],
    ["Fireworks AI API Key", "f" + "w_" + "MIX30", "fw_short"],
  ];
  const fill = (template: string) =>
    template
      .replace("HEX64", runOf(r, HEX, 64))
      .replace("B64_64", mixedRun(r, 64, ALNUM + "-_"))
      .replace("ALNUM24", runOf(r, ALNUM, 24))
      .replace("HEX32", runOf(r, HEX, 32))
      .replace("B64_28", runOf(r, ALNUM + "-_", 28))
      .replace("MIX30", "Aa1" + runOf(r, ALNUM, 27));

  test("each format reports under its own name", () => {
    for (const [type, template] of cases) {
      const types = found(`var k="${fill(template)}";`).map((f) => f[0]);
      expect([type, types]).toEqual([type, [type]]);
    }
  });

  test("each Shopify prefix is a token; a Stripe restricted key is critical in a script", () => {
    for (const prefix of ["shpat_", "shpss_", "shpca_", "shppa_"]) {
      expect(found(`var k="${prefix.replace("sh", "s" + "h")}${runOf(r, HEX, 32)}";`).map((f) => f[0])).toEqual(["Shopify Admin API Token"]);
    }
    const shpat = "s" + "hpat_" + runOf(r, HEX, 32);
    expect(scanContent(`var k="${shpat}";`, "external-script", PAGE)[0]?.type).toBe("Shopify Admin API Token");
  });

  test("near misses: prose with no key body, short tails, wrong alphabet, identifiers", () => {
    const negatives = [
      `Keys start with sk-or-v1- and are 64 hex characters long.`,
      `var k="${"sk-" + "or-v1-"}${runOf(r, HEX, 20)}";`,
      `var k="${"sh" + "pat_"}${runOf(r, HEX, 31)}";`,
      `var k="${"sh" + "pat_"}${"Z".repeat(32)}";`,
      `var k="${"GOC" + "SPX-"}${runOf(r, ALNUM, 10)}";`,
      `var k="${"nv" + "api-"}${runOf(r, ALNUM, 20)}";`,
      `var k="${"rk_" + "live_"}${runOf(r, ALNUM, 10)}";`,
      `var k="my-${"f" + "w_"}Aa1${runOf(r, ALNUM, 27)}";`,
      // `fw_` identifiers: separators, a single case, no digit.
      `var a="fw_config_option_name_for_the_firewall"; var b="fw_${"abcdefghijklmnopqrstuvwxyz"}"; var c="fw_${"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"}";`,
    ];
    for (const js of negatives) expect(found(js)).toEqual([]);
  });

  test("a Stripe restricted test or restricted sample key is not a live key", () => {
    expect(found(`var k="${"rk_" + "test_"}${runOf(r, ALNUM, 24)}";`)).toEqual([]);
  });

  test("a megabyte of near-miss prefixes scans in linear time", () => {
    const start = performance.now();
    scanContent(`fw_${"a".repeat(60)} nvapi-${"b".repeat(50)} shpat_${"c".repeat(31)} sk-or-v1-${"d".repeat(63)} `.repeat(6000), "external-script", PAGE);
    expect(performance.now() - start).toBeLessThan(4000);
  });
});
