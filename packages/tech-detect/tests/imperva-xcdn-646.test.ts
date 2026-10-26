// pub#646: waf-detect recognises both `X-CDN: Incapsula` and `X-CDN: Imperva`
// (pub#643), but tech-detect's Imperva fingerprint matched Incapsula only. The
// fingerprint is curated now, in a tracked file: the generated set came from a
// research file that is not in the repository, so a regeneration could not
// keep a fix made there, and it skips any id the curated set already has.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src/detect";
import { GENERATED_FINGERPRINTS, SECURITY_FINGERPRINTS } from "../src/fingerprints";

const detected = (headers: Record<string, string>) =>
  detectTechnologies({ url: "https://example.com", headers, html: "" }).map((t) => t.id);

describe("Imperva detection (pub#646)", () => {
  test("X-CDN: Imperva and X-CDN: Incapsula are both Imperva, X-CDN: Fastly is not", () => {
    expect(detected({ "x-cdn": "Imperva" })).toContain("imperva-incapsula");
    expect(detected({ "X-CDN": "Incapsula" })).toContain("imperva-incapsula");
    expect(detected({ "x-cdn": "Fastly" })).not.toContain("imperva-incapsula");
  });

  test("the fingerprint lives in the curated set, so a regeneration keeps it", () => {
    expect(SECURITY_FINGERPRINTS.some((fp) => fp.id === "imperva-incapsula")).toBe(true);
    expect(GENERATED_FINGERPRINTS.some((fp) => fp.id === "imperva-incapsula")).toBe(false);
  });
});
