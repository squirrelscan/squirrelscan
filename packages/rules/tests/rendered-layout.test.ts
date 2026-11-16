// a11y/rendered-layout reads the render service's layout probe: 1.4.10 reflow, 1.4.12 text spacing,
// 1.4.4 text resize (repo#3091).

import { describe, expect, test } from "bun:test";

import type { RenderLayoutProbe } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { renderedLayoutRule } from "../src/a11y/rendered-layout";
import type { CloudResultEnvelope, CloudResultStore } from "../src/cloud";
import type { CheckResult, RuleContext } from "../src/types";

const URL_ = "https://example.com/";

async function runWith(envelope: CloudResultEnvelope | undefined): Promise<CheckResult[]> {
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body><p>x</p></body></html>`;
  const store: CloudResultStore = new Map();
  if (envelope) store.set("render", new Map([[URL_, envelope]]));
  const ctx = {
    page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL_),
    options: {},
    cloudResults: store,
  } as unknown as RuleContext;
  return (await renderedLayoutRule.run(ctx)).checks;
}

const ok = (layout?: RenderLayoutProbe): CloudResultEnvelope => ({
  status: "ok",
  data: { url: URL_, status: 200, ...(layout ? { layout } : {}) },
});

const clean: RenderLayoutProbe = {
  reflow: { scrollWidth: 320, viewportWidth: 320, elements: [] },
  textSpacing: { scrollWidth: 1280, viewportWidth: 1280, elements: [] },
  textResize: { scrollWidth: 1280, viewportWidth: 1280, elements: [] },
};

describe("a11y/rendered-layout", () => {
  test("a clean fixture produces no findings", async () => {
    const checks = await runWith(ok(clean));
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["reflow", "pass"],
      ["text-spacing", "pass"],
      ["text-resize", "pass"],
    ]);
  });

  test("horizontal scroll at 320px is flagged with the selector and measured width", async () => {
    const checks = await runWith(
      ok({
        reflow: {
          scrollWidth: 640,
          viewportWidth: 320,
          elements: [{ selector: "main > table.prices", width: 640 }],
        },
      }),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("reflow");
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.message).toContain("1.4.10");
    expect(checks[0]?.message).toContain("main > table.prices (640px wide)");
  });

  test("a sub-pixel overflow is not a reflow failure", async () => {
    const checks = await runWith(
      ok({ reflow: { scrollWidth: 320.6, viewportWidth: 320, elements: [] } }),
    );
    expect(checks[0]?.status).toBe("pass");
  });

  test("clipped text under the text-spacing overrides names the element and clipped amount", async () => {
    const checks = await runWith(
      ok({
        textSpacing: {
          scrollWidth: 1280,
          viewportWidth: 1280,
          elements: [{ selector: "div.card > p", clippedPx: 18 }],
        },
      }),
    );
    expect(checks[0]?.name).toBe("text-spacing");
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.message).toContain("1.4.12");
    expect(checks[0]?.message).toContain("div.card > p (18px clipped)");
  });

  test("content clipped at 200% text size is flagged under 1.4.4", async () => {
    const checks = await runWith(
      ok({
        textResize: {
          scrollWidth: 1280,
          viewportWidth: 1280,
          elements: [{ selector: "header .nav", clippedPx: 40 }],
        },
      }),
    );
    expect(checks[0]?.name).toBe("text-resize");
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.message).toContain("1.4.4");
    expect(checks[0]?.message).toContain("header .nav (40px clipped)");
  });

  test("a long element list names five and counts the rest", async () => {
    const elements = Array.from({ length: 8 }, (_, i) => ({ selector: `.e${i}`, clippedPx: 2 }));
    const checks = await runWith(
      ok({ textResize: { scrollWidth: 1, viewportWidth: 1, elements } }),
    );
    expect(checks[0]?.message).toContain("and 3 more");
  });

  test("skips offline with the cloud reason", async () => {
    const checks = await runWith({ status: "skipped", skipReason: "not-authenticated" });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toContain("squirrel auth login");
  });

  test("skips when nothing was prefetched", async () => {
    const checks = await runWith(undefined);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toContain("no result was prefetched");
  });

  test("skips when the render carries no layout probe", async () => {
    const checks = await runWith(ok());
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toContain("no layout measurements");
  });

  test("malformed measurements skip instead of throwing", async () => {
    const checks = await runWith(
      ok({ reflow: { scrollWidth: Number.NaN, viewportWidth: 320, elements: [] } }),
    );
    expect(checks[0]?.status).toBe("skipped");
  });
});
