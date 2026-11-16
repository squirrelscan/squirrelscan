// Rendered keyboard rules: focus-order, keyboard-trap, focus-not-obscured, focus-indicator (repo#3089).
//
// Each rule reads the scripted Tab pass the cloud render returns on `RenderResultItem.focus`. The
// fixtures here are snapshots as the render service would send them.

import { describe, expect, test } from "bun:test";

import type {
  FocusIndicatorStyle,
  FocusRect,
  FocusStop,
  RenderFocusSnapshot,
  RenderResultItem,
} from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { focusIndicatorRule } from "../src/a11y/focus-indicator";
import { focusNotObscuredRule } from "../src/a11y/focus-not-obscured";
import { focusOrderRule } from "../src/a11y/focus-order";
import { keyboardTrapRule } from "../src/a11y/keyboard-trap";
import type { CloudResultEnvelope, CloudResultStore } from "../src/cloud";
import type { Rule, RuleContext } from "../src/types";

const URL = "https://example.com/page";

const NONE: FocusIndicatorStyle = {
  outlineStyle: "none",
  outlineWidthPx: 0,
  outlineColor: "rgb(0, 0, 0)",
  boxShadow: "none",
  borderColor: "rgb(0, 0, 0)",
  backgroundColor: "rgb(255, 255, 255)",
  textDecoration: "none",
};
const RING: FocusIndicatorStyle = {
  ...NONE,
  outlineStyle: "solid",
  outlineWidthPx: 2,
  outlineColor: "rgb(0, 95, 204)",
};

function stop(selector: string, rect: Partial<FocusRect>, over: Partial<FocusStop> = {}): FocusStop {
  return {
    selector,
    tag: "a",
    rect: { x: 0, y: 0, width: 100, height: 20, ...rect },
    unfocused: NONE,
    focused: RING,
    visibleFraction: 1,
    ...over,
  };
}

function ctxFor(
  envelope: CloudResultEnvelope<RenderResultItem> | undefined,
): RuleContext {
  const html = "<!DOCTYPE html><html><head><title>t</title></head><body><p>x</p></body></html>";
  const cloudResults: CloudResultStore | undefined = envelope
    ? new Map([["render", new Map([[URL, envelope as CloudResultEnvelope]])]])
    : undefined;
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed: parsePage(html, URL) },
    parsed: parsePage(html, URL),
    ...(cloudResults ? { cloudResults } : {}),
  } as unknown as RuleContext;
}

function withFocus(focus: RenderFocusSnapshot | undefined): RuleContext {
  return ctxFor({
    status: "ok",
    data: { url: URL, status: 200, html: "<html></html>", ...(focus ? { focus } : {}) },
  });
}

async function run(rule: Rule, ctx: RuleContext) {
  const result = await rule.run(ctx);
  expect("checks" in result).toBe(true);
  return (result as { checks: import("@squirrelscan/core-contracts").CheckResult[] }).checks;
}

describe("a11y/focus-order (2.4.3)", () => {
  test("flags a Tab step that jumps above the previous stop, with both elements and positions", async () => {
    const checks = await run(
      focusOrderRule,
      withFocus({
        stops: [
          stop("a#one", { x: 10, y: 400 }),
          stop("a#two", { x: 10, y: 100 }),
        ],
      }),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("warn");
    const label = checks[0]?.items?.[0]?.label ?? "";
    expect(label).toContain("a#one (10,400 100x20)");
    expect(label).toContain("a#two (10,100 100x20)");
    expect(checks[0]?.items?.[0]?.selector).toBe("a#two");
  });

  test("flags a same-row step that goes left in LTR, and right in RTL is fine", async () => {
    const stops = [stop("a#r", { x: 300, y: 50 }), stop("a#l", { x: 20, y: 50 })];
    expect((await run(focusOrderRule, withFocus({ stops })))[0]?.status).toBe("warn");
    expect((await run(focusOrderRule, withFocus({ stops, rtl: true })))[0]?.status).toBe("pass");
  });

  test("passes a top-to-bottom, left-to-right order", async () => {
    const checks = await run(
      focusOrderRule,
      withFocus({
        stops: [
          stop("a#1", { x: 10, y: 10 }),
          stop("a#2", { x: 200, y: 10 }),
          stop("a#3", { x: 10, y: 80 }),
        ],
      }),
    );
    expect(checks[0]?.status).toBe("pass");
  });
});

describe("a11y/keyboard-trap (2.1.2)", () => {
  const trap = {
    selector: "button#next",
    container: "div#widget",
    tabPresses: 4,
    inDialog: false,
    releasedByEscape: false,
  };

  test("flags a trap Escape does not release, with the selector and measurements", async () => {
    const checks = await run(keyboardTrapRule, withFocus({ stops: [], trap }));
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.items?.[0]?.selector).toBe("div#widget");
    expect(checks[0]?.details).toMatchObject({ tabPresses: 4, releasedByEscape: false });
  });

  test("passes a modal that holds focus and releases on Escape", async () => {
    const checks = await run(
      keyboardTrapRule,
      withFocus({
        stops: [],
        trap: { ...trap, container: "div[role=dialog]", inDialog: true, releasedByEscape: true },
      }),
    );
    expect(checks[0]?.status).toBe("pass");
  });

  test("passes when no region keeps focus", async () => {
    expect((await run(keyboardTrapRule, withFocus({ stops: [stop("a#x", {})] })))[0]?.status).toBe(
      "pass",
    );
  });
});

describe("a11y/focus-not-obscured (2.4.11)", () => {
  const header = { selector: "header#top", position: "sticky" as const, rect: { x: 0, y: 0, width: 1280, height: 80 } };

  test("flags a focused control a sticky header covers entirely", async () => {
    const checks = await run(
      focusNotObscuredRule,
      withFocus({
        stops: [
          stop("a#fine", { y: 300 }),
          stop("a#hidden", { y: 20 }, { visibleFraction: 0, obscuredBy: header }),
        ],
      }),
    );
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.items).toHaveLength(1);
    expect(checks[0]?.items?.[0]?.selector).toBe("a#hidden");
    expect(checks[0]?.items?.[0]?.label).toContain("sticky header#top");
  });

  test("a partly covered control is not flagged", async () => {
    const checks = await run(
      focusNotObscuredRule,
      withFocus({ stops: [stop("a#half", { y: 60 }, { visibleFraction: 0.5, obscuredBy: header })] }),
    );
    expect(checks[0]?.status).toBe("pass");
  });
});

describe("a11y/focus-indicator (2.4.7)", () => {
  test("flags a control whose computed focus styles show no change", async () => {
    const checks = await run(
      focusIndicatorRule,
      withFocus({
        stops: [
          stop("a#ok", {}),
          stop("button#bare", {}, { tag: "button", focused: { ...NONE } }),
        ],
      }),
    );
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.items).toHaveLength(1);
    expect(checks[0]?.items?.[0]?.selector).toBe("button#bare");
    expect(checks[0]?.items?.[0]?.label).toContain("outline none 0px");
  });

  test("a box-shadow or border change counts as an indicator", async () => {
    const checks = await run(
      focusIndicatorRule,
      withFocus({
        stops: [
          stop("a#shadow", {}, { focused: { ...NONE, boxShadow: "rgb(0, 0, 255) 0px 0px 0px 3px" } }),
          stop("a#border", {}, { focused: { ...NONE, borderColor: "rgb(0, 0, 255)" } }),
        ],
      }),
    );
    expect(checks[0]?.status).toBe("pass");
  });

  test("a transparent outline is not an indicator", async () => {
    const checks = await run(
      focusIndicatorRule,
      withFocus({
        stops: [stop("a#t", {}, { focused: { ...RING, outlineColor: "rgba(0, 0, 0, 0)" } })],
      }),
    );
    expect(checks[0]?.status).toBe("warn");
  });
});

describe("offline and missing renders", () => {
  const rules: Rule[] = [focusOrderRule, keyboardTrapRule, focusNotObscuredRule, focusIndicatorRule];

  test("every rule skips with a reason when no render result exists", async () => {
    for (const rule of rules) {
      const checks = await run(rule, ctxFor(undefined));
      expect(checks).toHaveLength(1);
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.skipReason).toContain("Cloud analysis skipped");
    }
  });

  test("a skipped render carries its cloud skip reason", async () => {
    const ctx = ctxFor({ status: "skipped", skipReason: "not-authenticated" });
    const checks = await run(focusOrderRule, ctx);
    expect(checks[0]?.skipReason).toContain("squirrel auth login");
  });

  test("a render without a keyboard pass skips with its own reason", async () => {
    for (const rule of rules) {
      const checks = await run(rule, withFocus(undefined));
      expect(checks[0]?.status).toBe("skipped");
      expect(checks[0]?.skipReason).toContain("keyboard pass");
    }
  });

  test("static a11y/focus-visible still runs without a render", async () => {
    const { focusVisibleRule } = await import("../src/a11y/focus-visible");
    const checks = await run(focusVisibleRule, ctxFor(undefined));
    expect(checks[0]?.status).not.toBe("skipped");
  });
});
