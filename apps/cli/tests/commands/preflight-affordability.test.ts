// #1169: preflight credit-affordability estimate + prompt-eligibility helpers.
// Estimate math comes from the shared v10 pricing source (base + maxPages ×
// render), and the prompt requires BOTH stdin and stdout to be TTYs so a piped
// stdin can't silently abort via readline EOF.

import { computeCost } from "@squirrelscan/core-contracts/credits";
import { describe, expect, test } from "bun:test";

import {
  computePreflightAffordability,
  preflightPromptEligible,
} from "../../src/cli/commands/audit";

const TOP_UP = "https://squirrelscan.com/dashboard";

describe("computePreflightAffordability (#1169)", () => {
  test("estimate = base + maxPages renders from the shared pricing source", () => {
    const maxPages = 500;
    const r = computePreflightAffordability({
      balance: 0,
      maxPages,
      cloudRendering: "browser",
      topUpUrl: TOP_UP,
    });
    expect(r.base).toBe(computeCost("audit_base", 1));
    expect(r.renderCost).toBe(computeCost("render", maxPages));
    expect(r.estimate).toBe(
      computeCost("audit_base", 1) + computeCost("render", maxPages)
    );
  });

  test("render cost is 0 when cloud rendering is off (http)", () => {
    const r = computePreflightAffordability({
      balance: 0,
      maxPages: 500,
      cloudRendering: "http",
      topUpUrl: TOP_UP,
    });
    expect(r.renderCost).toBe(0);
    expect(r.estimate).toBe(computeCost("audit_base", 1));
  });

  test("shortfall true when balance can't cover the estimate", () => {
    const maxPages = 500;
    const estimate =
      computeCost("audit_base", 1) + computeCost("render", maxPages);
    const short = computePreflightAffordability({
      balance: estimate - 1,
      maxPages,
      cloudRendering: "browser",
      topUpUrl: TOP_UP,
    });
    expect(short.shortfall).toBe(true);
    expect(short.warningLines).toHaveLength(2);
    // Message surfaces the cost, the base, the page count, the balance, top-up.
    expect(short.warningLines[0]).toContain(estimate.toLocaleString("en-US"));
    expect(short.warningLines[0]).toContain(`${short.base} base`);
    expect(short.warningLines[0]).toContain(`${maxPages} pages`);
    expect(short.warningLines[0]).toContain(
      (estimate - 1).toLocaleString("en-US")
    );
    expect(short.warningLines[1]).toContain(TOP_UP);
  });

  test("no shortfall when balance covers the estimate → no warning", () => {
    const maxPages = 500;
    const estimate =
      computeCost("audit_base", 1) + computeCost("render", maxPages);
    const ok = computePreflightAffordability({
      balance: estimate,
      maxPages,
      cloudRendering: "browser",
      topUpUrl: TOP_UP,
    });
    expect(ok.shortfall).toBe(false);
    expect(ok.warningLines).toEqual([]);
  });
});

describe("preflightPromptEligible (#1169)", () => {
  test("prompts only when BOTH stdin and stdout are TTYs and not --yes", () => {
    expect(
      preflightPromptEligible({
        stdinIsTTY: true,
        stdoutIsTTY: true,
        yes: false,
      })
    ).toBe(true);
  });

  test("piped stdin (stdout TTY) does NOT prompt — falls through to warn+continue", () => {
    // The bug this guards: readline over a non-TTY stdin hits EOF → resolves false
    // → a silent abort. Non-interactive stdin must warn-and-continue instead.
    expect(
      preflightPromptEligible({
        stdinIsTTY: false,
        stdoutIsTTY: true,
        yes: false,
      })
    ).toBe(false);
  });

  test("--yes never prompts", () => {
    expect(
      preflightPromptEligible({
        stdinIsTTY: true,
        stdoutIsTTY: true,
        yes: true,
      })
    ).toBe(false);
  });

  test("non-TTY stdout does not prompt", () => {
    expect(
      preflightPromptEligible({
        stdinIsTTY: true,
        stdoutIsTTY: false,
        yes: false,
      })
    ).toBe(false);
  });
});
