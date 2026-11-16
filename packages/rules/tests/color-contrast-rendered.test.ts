// a11y/color-contrast-rendered: contrast measured from the render snapshot's computed styles (repo#3088).

import { describe, expect, test } from "bun:test";

import type { RenderResultItem, RenderedTextStyle } from "@squirrelscan/core-contracts";

import { colorContrastRenderedRule } from "../src/a11y/color-contrast-rendered";
import type { CloudResultEnvelope, CloudResultStore } from "../src/cloud";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/";
const WHITE = "rgb(255, 255, 255)";

function sample(over: Partial<RenderedTextStyle>): RenderedTextStyle {
  return {
    selector: "p.copy",
    color: "rgb(0, 0, 0)",
    fontSizePx: 16,
    fontWeight: 400,
    backgroundLayers: [WHITE],
    ...over,
  };
}

function run(data: Partial<RenderResultItem> | null, opts: { rendered?: boolean; skipReason?: string } = {}): CheckResult[] {
  let envelope: CloudResultEnvelope | undefined;
  if (opts.skipReason) envelope = { status: "skipped", skipReason: opts.skipReason as never };
  else if (data) envelope = { status: "ok", data: { url: URL, status: 200, html: "<html></html>", ...data } };
  const cloudResults: CloudResultStore | undefined = envelope
    ? new Map([["render", new Map([[URL, envelope]])]])
    : undefined;
  const ctx = {
    page: { url: URL, html: "", statusCode: 200, loadTime: 0, headers: {}, rendered: opts.rendered },
    parsed: {},
    options: {},
    cloudResults,
  } as unknown as RuleContext;
  const result = colorContrastRenderedRule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  return result.checks;
}

const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name)!;

describe("a11y/color-contrast-rendered", () => {
  test("pass: black on white clears AA and AAA", () => {
    const checks = run({ textStyles: [sample({})] });
    expect(named(checks, "color-contrast-rendered").status).toBe("pass");
    expect(named(checks, "color-contrast-rendered-aaa").status).toBe("pass");
    expect(checks.find((c) => c.name === "color-contrast-rendered-unconfirmed")).toBeUndefined();
  });

  test("AA fail: reports selector, measured and required ratio and the computed colors", () => {
    const checks = run({ textStyles: [sample({ selector: "p.muted", color: "rgb(185, 185, 185)" })] });
    const aa = named(checks, "color-contrast-rendered");
    expect(aa.status).toBe("warn");
    const el = (aa.details as { elements: Array<Record<string, unknown>> }).elements[0]!;
    expect(el.selector).toBe("p.muted");
    expect(el.required).toBe(4.5);
    expect(el.ratio).toBe(1.96);
    expect(el.foreground).toBe("#b9b9b9");
    expect(el.background).toBe("#ffffff");
    // an AA failure is not repeated under AAA
    expect(named(checks, "color-contrast-rendered-aaa").status).toBe("pass");
  });

  test("AAA-only fail: passes AA, reported as its own info check", () => {
    // #767676 on white is 4.54:1: AA pass, AAA fail
    const checks = run({ textStyles: [sample({ color: "rgb(118, 118, 118)" })] });
    expect(named(checks, "color-contrast-rendered").status).toBe("pass");
    const aaa = named(checks, "color-contrast-rendered-aaa");
    expect(aaa.status).toBe("info");
    expect((aaa.details as { elements: Array<{ required: number }> }).elements[0]!.required).toBe(7);
  });

  test("large text: 3:1 for AA and 4.5:1 for AAA, normal text 4.5:1 and 7:1", () => {
    const gray = "rgb(140, 140, 140)"; // about 3.4:1 on white
    const normal = run({ textStyles: [sample({ color: gray })] });
    expect(named(normal, "color-contrast-rendered").status).toBe("warn");

    const large = run({ textStyles: [sample({ color: gray, fontSizePx: 24 })] });
    expect(named(large, "color-contrast-rendered").status).toBe("pass");
    const aaa = named(large, "color-contrast-rendered-aaa");
    expect(aaa.status).toBe("info");
    expect((aaa.details as { elements: Array<{ required: number; large: boolean }> }).elements[0]).toMatchObject({
      required: 4.5,
      large: true,
    });

    const bold = run({ textStyles: [sample({ color: gray, fontSizePx: 19, fontWeight: 700 })] });
    expect(named(bold, "color-contrast-rendered").status).toBe("pass");
    const boldSmall = run({ textStyles: [sample({ color: gray, fontSizePx: 14, fontWeight: 700 })] });
    expect(named(boldSmall, "color-contrast-rendered").status).toBe("warn");
  });

  test("alpha is composited over the effective background", () => {
    // black at 30% on white is #b3b3b3: fails AA
    const checks = run({ textStyles: [sample({ color: "rgba(0, 0, 0, 0.3)" })] });
    expect(named(checks, "color-contrast-rendered").status).toBe("warn");
    // translucent white layer over a dark layer stays dark enough for white text
    const dark = run({
      textStyles: [
        sample({ color: WHITE, backgroundLayers: ["rgba(0, 0, 0, 0.1)", "rgb(10, 10, 40)"] }),
      ],
    });
    expect(named(dark, "color-contrast-rendered").status).toBe("pass");
  });

  test("an unresolvable background (image, gradient) is unconfirmed, never a pass or failure", () => {
    const checks = run({
      textStyles: [
        sample({ selector: "h1.hero", color: WHITE, backgroundImage: "image" }),
        sample({ selector: "h2.banner", color: WHITE, backgroundImage: "gradient" }),
      ],
    });
    const un = named(checks, "color-contrast-rendered-unconfirmed");
    expect(un.status).toBe("info");
    expect((un.details as { inconclusive: boolean; unconfirmed: number }).inconclusive).toBe(true);
    expect((un.details as { unconfirmed: number }).unconfirmed).toBe(2);
    // nothing measured, so nothing failed
    expect((named(checks, "color-contrast-rendered").details as { measured: number }).measured).toBe(0);
  });

  test("an unreadable computed color is unconfirmed", () => {
    const checks = run({ textStyles: [sample({ color: "color(display-p3 1 0 0)" })] });
    expect(named(checks, "color-contrast-rendered-unconfirmed").status).toBe("info");
  });

  test("skips without a render result, without styles, or on a failed render", () => {
    const none = run(null);
    expect(none[0]).toMatchObject({ name: "color-contrast-rendered", status: "skipped" });
    expect(run({ textStyles: undefined })[0]!.status).toBe("skipped");
    expect(run({ html: "", textStyles: [] })[0]!.status).toBe("skipped");
    expect(run(null, { skipReason: "not-authenticated" })[0]!.status).toBe("skipped");
    expect(run({ textStyles: [] }, { rendered: true })[0]!.status).toBe("skipped");
  });

  test("declares every check name it emits", () => {
    const declared = new Set(colorContrastRenderedRule.meta.checks!.map((c) => c.name));
    const emitted = [
      ...run({ textStyles: [sample({ backgroundImage: "image" })] }),
      ...run(null),
    ].map((c) => c.name);
    for (const name of emitted) expect(declared.has(name)).toBe(true);
  });
});
