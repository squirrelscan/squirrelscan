// images/aspect-mismatch — declared vs CSS aspect-ratio conflict (#701).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { aspectMismatchRule } from "../src/images/aspect-mismatch";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/";

function makeCtx(body: string): RuleContext {
  const html = `<!DOCTYPE html><html><head><title>T</title></head><body>${body}</body></html>`;
  const parsed = parsePage(html, URL);
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  };
}

function run(ctx: RuleContext): CheckResult {
  const checks = (aspectMismatchRule.run(ctx) as { checks: CheckResult[] }).checks;
  expect(checks).toHaveLength(1);
  return checks[0] as CheckResult;
}

describe("images/aspect-mismatch", () => {
  test("warns: attrs 4:5 into a CSS 4:3 px box", () => {
    // 1200x1500 (0.80) forced into 1000x750 (1.33) → distortion.
    const c = run(
      makeCtx(`<img src="/p.jpg" width="1200" height="1500" style="width:1000px;height:750px">`),
    );
    expect(c.status).toBe("warn");
    expect(c.items?.[0]?.id).toBe("/p.jpg");
  });

  test("warns: CSS aspect-ratio conflicts with attrs", () => {
    const c = run(
      makeCtx(`<img src="/p.jpg" width="1200" height="1500" style="width:100%;aspect-ratio:4/3">`),
    );
    expect(c.status).toBe("warn");
  });

  test("passes: matching ratios (4:3 attrs, 4:3 css px)", () => {
    const c = run(
      makeCtx(`<img src="/p.jpg" width="1200" height="900" style="width:400px;height:300px">`),
    );
    expect(c.status).toBe("pass");
  });

  test("passes: object-fit cover compensates for the box mismatch", () => {
    const c = run(
      makeCtx(
        `<img src="/p.jpg" width="1200" height="1500" style="width:1000px;height:750px;object-fit:cover">`,
      ),
    );
    expect(c.status).toBe("pass");
  });

  test("passes: CSS width with height:auto preserves aspect (recommended pattern)", () => {
    const c = run(
      makeCtx(`<img src="/p.jpg" width="1200" height="1500" style="width:1000px;height:auto">`),
    );
    expect(c.status).toBe("pass");
  });

  test("passes: no inline style to compare against", () => {
    const c = run(makeCtx(`<img src="/p.jpg" width="1200" height="1500">`));
    expect(c.status).toBe("pass");
  });

  test("passes: percentage CSS dims are not comparable, skipped", () => {
    const c = run(
      makeCtx(`<img src="/p.jpg" width="1200" height="1500" style="width:50%;height:50%">`),
    );
    expect(c.status).toBe("pass");
  });

  test("passes: missing attr dimensions skipped", () => {
    const c = run(makeCtx(`<img src="/p.jpg" style="width:1000px;height:750px">`));
    expect(c.status).toBe("pass");
  });

  test("passes: class-based object-cover (Tailwind) compensates", () => {
    const c = run(
      makeCtx(
        `<img src="/p.jpg" class="object-cover w-full" width="1200" height="800" style="aspect-ratio:1/1;width:100%">`,
      ),
    );
    expect(c.status).toBe("pass");
  });

  test("respects a wider tolerance option", () => {
    // 1200x1000 (1.20) vs 1000x750 css (1.33) → ~11% off; passes at 0.2 tolerance.
    const ctx = makeCtx(
      `<img src="/p.jpg" width="1200" height="1000" style="width:1000px;height:750px">`,
    );
    ctx.options = { tolerance: 0.2 };
    const checks = (aspectMismatchRule.run(ctx) as { checks: CheckResult[] }).checks;
    expect(checks[0]?.status).toBe("pass");
  });
});
