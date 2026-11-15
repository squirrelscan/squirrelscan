// The stored variant map is the one content/terminology-consistency's legacy path derives, so the
// streaming rule and the legacy path read the same counts.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { pageTerminologyVariants } from "@squirrelscan/rules";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { extractPageFeatures } from "../src/index";

const URL_ = "https://example.com/a";
const record = { url: URL_, normalizedUrl: URL_, finalUrl: URL_, depth: 1, status: 200, sizeBytes: 1, headers: {}, securityHeaders: {} } as unknown as PageRecord;

describe("extractPageFeatures: terminologyVariants", () => {
  test("equals the rule's per-page extractor", () => {
    const parsed = parsePage(
      '<html><head><meta property="og:site_name" content="squirrelscan"></head><body><nav><a href="/l">Log in</a><a href="/s">Sign in</a></nav><p>Mail us at hi@login.example.com or e-mail the team. Visit our FAQ and the Faq. We love squirrelscan and SquirrelScan.</p></body></html>',
      URL_,
    );
    const got = extractPageFeatures(record, parsed).terminologyVariants;
    expect(got).toEqual(pageTerminologyVariants(parsed));
    expect(got).toEqual({
      "signin.sign_in": 1,
      "signin.log_in": 1,
      "email.e_mail": 1,
      "faq.upper": 1,
      "faq.other": 1,
      "brand.lower": 1,
      "brand.camel": 1,
    });
  });

  test("is null when none of the tracked spellings occur", () => {
    const parsed = parsePage("<html><body><p>Hello there.</p></body></html>", URL_);
    expect(extractPageFeatures(record, parsed).terminologyVariants).toBeNull();
  });
});
