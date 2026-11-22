// The render service may send what the browser saw while the page ran (#704, #425): page errors, failed
// requests and CSP violations. The mapper carries it to the crawler bounded and shape-checked, and keeps
// "not recorded" (an absent list) apart from "none seen" (an empty one).

import type { RenderResultItem } from "@squirrelscan/core-contracts";

import { MAX_CSP_VIOLATIONS_PER_PAGE } from "@squirrelscan/core-contracts";
import { describe, expect, test } from "bun:test";

import {
  boundRenderRuntime,
  mapRenderItemToResponse,
} from "../src/cloud-fetcher";

const TIMING = { startedAt: 0, responseAt: 1, finishedAt: 2 };
const URL_ = "https://example.com/";

const item = (
  extra: Partial<RenderResultItem> = {}
): RenderResultItem & { html: string } => ({
  url: URL_,
  status: 200,
  html: "<html><body>rendered</body></html>",
  ...extra,
});

const violation = {
  effectiveDirective: "connect-src",
  violatedDirective: "connect-src",
  blockedURI: "https://analytics.google.com/g/collect",
  disposition: "enforce" as const,
};

describe("mapRenderItemToResponse runtime (#425)", () => {
  test("a recorded runtime reaches the response with its CSP violations", () => {
    const response = mapRenderItemToResponse(
      item({ runtime: { cspViolations: [violation], failedRequests: [] } }),
      URL_,
      TIMING
    );
    expect(response.renderRuntime?.cspViolations).toEqual([violation]);
    expect(response.renderRuntime?.failedRequests).toEqual([]);
    // Never sent, so never invented: absent is "not recorded".
    expect(
      response.renderRuntime && "pageErrors" in response.renderRuntime
    ).toBe(false);
  });

  test("without a runtime the response has no renderRuntime key at all", () => {
    const response = mapRenderItemToResponse(item(), URL_, TIMING);
    expect("renderRuntime" in response).toBe(false);
  });
});

describe("boundRenderRuntime (#425)", () => {
  test("caps the violations kept per page", () => {
    const many = Array.from(
      { length: MAX_CSP_VIOLATIONS_PER_PAGE + 50 },
      () => violation
    );
    expect(
      boundRenderRuntime({ cspViolations: many })?.cspViolations
    ).toHaveLength(MAX_CSP_VIOLATIONS_PER_PAGE);
  });

  test("drops entries missing the fields the rules need, and nested values, and clamps long strings", () => {
    const runtime = boundRenderRuntime({
      cspViolations: [
        { effectiveDirective: "img-src" },
        "not an object",
        null,
        {
          ...violation,
          sample: { nested: true },
          blockedURI: `https://a.example.com/${"x".repeat(10_000)}`,
        },
      ],
      pageErrors: [{ line: 1 }, { message: "boom", line: 3 }],
    });
    expect(runtime?.cspViolations).toHaveLength(1);
    const kept = runtime!.cspViolations![0]!;
    expect("sample" in kept).toBe(false);
    expect(kept.blockedURI.length).toBeLessThan(10_000);
    expect(runtime?.pageErrors).toEqual([{ message: "boom", line: 3 }]);
  });

  test("long entries share one per-page budget, and CSP violations are kept before the other lists", () => {
    const long = (i: number) => ({
      ...violation,
      blockedURI: `https://a.example.com/${i}/${"x".repeat(5_000)}`,
      sourceFile: `https://a.example.com/${"y".repeat(5_000)}`,
    });
    const runtime = boundRenderRuntime({
      cspViolations: Array.from(
        { length: MAX_CSP_VIOLATIONS_PER_PAGE },
        (_, i) => long(i)
      ),
      pageErrors: Array.from({ length: 100 }, () => ({
        message: "e".repeat(5_000),
      })),
    });
    const chars = JSON.stringify(runtime).length;
    // Far below what the counts alone allow (200 violations and 100 errors of several KB each).
    expect(chars).toBeLessThan(80 * 1024);
    expect(runtime!.cspViolations!.length).toBeGreaterThan(0);
    expect(runtime!.cspViolations!.length).toBeLessThan(
      MAX_CSP_VIOLATIONS_PER_PAGE
    );
    // The budget was spent on the violations, so the errors list is present but cut short.
    expect(runtime!.pageErrors!.length).toBeLessThan(100);
  });

  test("a payload that is not an object is no runtime", () => {
    expect(boundRenderRuntime(null)).toBeUndefined();
    expect(boundRenderRuntime([violation])).toBeUndefined();
    expect(boundRenderRuntime("x")).toBeUndefined();
  });
});
