// crawl/pdf-size states Google's 64MB PDF limit and squirrel's 60MB threshold
// as two different numbers (#320).

import { describe, expect, test } from "bun:test";

import { pdfSizeRule, optionsSchema } from "../src/crawl/pdf-size";
import type { CheckResult, RuleContext } from "../src/types";

const MB = 1024 * 1024;
const ORIGIN = "https://example.com";

function run(sizesMb: number[]): CheckResult[] {
  const ctx = {
    options: {},
    site: {
      baseUrl: ORIGIN,
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      pdfSizes: sizesMb.map((mb, i) => ({
        url: `${ORIGIN}/doc-${i}.pdf`,
        sizeBytes: mb * MB,
        error: null,
      })),
    },
  } as unknown as RuleContext;
  const result = pdfSizeRule.run(ctx) as { checks: CheckResult[] };
  return result.checks;
}

describe("crawl/pdf-size wording (#320)", () => {
  test("the error message names squirrel's 60MB threshold, not Google's limit", () => {
    const check = run([61]).find((c) => c.name === "pdf-size");
    expect(check?.status).toBe("fail");
    expect(check?.message).toBe("1 PDF(s) exceed the 60MB error threshold");
    expect(check?.message).not.toContain("Googlebot");
  });

  test("the warning message has no em-dash and names the 60MB threshold", () => {
    const check = run([35]).find((c) => c.name === "pdf-size-warn");
    expect(check?.message).toBe("1 PDF(s) exceed 30MB, approaching the 60MB error threshold");
    expect(check?.message).not.toContain("—");
  });

  test("the pass message has no em-dash", () => {
    const check = run([1, 2]).find((c) => c.name === "pdf-size");
    expect(check?.message).toBe("2 PDF(s) checked, all under 30MB");
  });

  test("the description states Google's 64MB limit and no longer calls 60MB Google's", () => {
    expect(pdfSizeRule.meta.description).not.toContain("Googlebot 60MB");
    expect(pdfSizeRule.meta.description).toContain("64MB");
  });

  test("the solution cites the documented 64MB limit", () => {
    expect(pdfSizeRule.meta.solution).toContain("64MB");
  });

  test("the error_bytes option describes 60MB as the default threshold", () => {
    const describeText = optionsSchema.shape.error_bytes.description ?? "";
    expect(describeText).not.toContain("Googlebot");
    expect(describeText).toContain("60MB");
  });
});
