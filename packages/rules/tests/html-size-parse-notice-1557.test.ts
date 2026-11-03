// #1557: `crawl/html-size` says so when a page's markup had to be degraded to be read (an oversized class attribute cut, or a page read empty).

import { describe, expect, test } from "bun:test";

import { htmlSizeRule } from "../src/crawl/html-size";
import type { RuleContext } from "../src/types";

const ctx = (parseNotices?: string[]): RuleContext =>
  ({ page: { url: "https://example.com/", html: "<p>x</p>", statusCode: 200, loadTime: 0, headers: {} }, parsed: { ...(parseNotices ? { parseNotices } : {}) }, options: {} }) as unknown as RuleContext;

describe("crawl/html-size parse notice", () => {
  test("a page with notices carries one warn check listing them, next to the size check", () => {
    const { checks } = htmlSizeRule.run(ctx(["a class attribute of 900,000 tokens was cut to the first 20,000 to read the page", "second"])) as { checks: Array<{ name: string; status: string; message: string; details?: Record<string, unknown> }> };
    expect(checks.map((c) => c.name)).toEqual(["html-size", "html-parse"]);
    const notice = checks[1]!;
    expect(notice.status).toBe("warn");
    expect(notice.message).toBe("The page's markup could not be read in full: a class attribute of 900,000 tokens was cut to the first 20,000 to read the page; second. Findings that depend on what was skipped are not reliable; shorten the oversized class attribute and audit again");
    expect(notice.details).toEqual({ notices: ["a class attribute of 900,000 tokens was cut to the first 20,000 to read the page", "second"] });
  });

  test("the rule's solution text tells what the html-parse warn means, beside the size advice", () => {
    expect(htmlSizeRule.meta.solution).toContain("Googlebot truncates HTML documents at 2MB");
    expect(htmlSizeRule.meta.solution).toContain("If the html-parse check warns");
    expect(htmlSizeRule.meta.solution).toContain("20,000 tokens");
  });

  test("no notices, or an empty list, adds nothing", () => {
    for (const notices of [undefined, []] as const) {
      const { checks } = htmlSizeRule.run(ctx(notices as string[] | undefined)) as { checks: Array<{ name: string }> };
      expect(checks.map((c) => c.name)).toEqual(["html-size"]);
    }
  });
});
