// An image with no width and height is one finding, owned by images/dimensions (#1768).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { RuleRunner, type RulesConfig } from "../src/runner";
import type { PageData } from "../src/types";

const URL_ = "https://example.com/shop/";
const HTML = `<!doctype html><html><head><title>Shop</title></head><body>
<img src="/img/products/raw-cashews.svg" alt="Cashews">
<img src="/img/sized.svg" width="10" height="10" alt="Sized">
</body></html>`;

async function run(html: string): Promise<Map<string, CheckResult[]>> {
  const config: RulesConfig = {
    rule_options: {},
    rules: { enable: ["images/dimensions", "perf/cls-hints"] },
  };
  const page: PageData = { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} };
  const { ruleResults } = await new RuleRunner({ config }).runPageRules(page);
  return new Map([...ruleResults].map(([id, r]) => [id, r.checks]));
}

describe("missing image dimensions have one owner", () => {
  test("images/dimensions warns, perf/cls-hints only points to it", async () => {
    const results = await run(HTML);
    const dim = results.get("images/dimensions")?.find((c) => c.name === "image-dimensions");
    const cls = results.get("perf/cls-hints")?.find((c) => c.name === "cls-images");
    expect(dim?.status).toBe("warn");
    expect(cls?.status).toBe("info");
    expect(cls?.message).toBe("1 image(s) without width/height: reported by images/dimensions");
  });

  test("both rules key the image by the same absolute URL", async () => {
    const results = await run(HTML);
    const dim = results.get("images/dimensions")?.find((c) => c.name === "image-dimensions");
    const cls = results.get("perf/cls-hints")?.find((c) => c.name === "cls-images");
    const want = "https://example.com/img/products/raw-cashews.svg";
    expect(dim?.items?.map((i) => i.id)).toEqual([want]);
    expect(cls?.items?.map((i) => i.id)).toEqual([want]);
  });

  test("a fully sized page passes in both rules", async () => {
    const results = await run(`<html><body><img src="/a.png" width="1" height="1"></body></html>`);
    expect(results.get("images/dimensions")?.[0]?.status).toBe("pass");
    expect(results.get("perf/cls-hints")?.find((c) => c.name === "cls-images")?.status).toBe(
      "pass",
    );
  });
});
