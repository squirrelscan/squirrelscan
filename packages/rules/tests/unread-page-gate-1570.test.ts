// #1570: a page whose markup could not be parsed is audited as an empty document. Rules that read the markup are not evaluated on it
// (a skipped check, never a finding), `crawl/html-size` still warns `html-parse`, and the rules that judge only the response still run.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { RuleRunner, UNREAD_PAGE_SKIP_REASON, type RulesConfig } from "../src/runner";
import type { PageData } from "../src/types";

const URL_ = "https://example.com/unread";
const NOTICE = "the page could not be read (boom), so it was audited empty";
const DOM_RULES = ["core/meta-title", "core/meta-description", "core/h1", "a11y/valid-lang", "mobile/viewport", "content/word-count", "a11y/landmark-one-main"];
const RESPONSE_RULES = ["crawl/html-size", "security/https"];

async function run(html: string, notices: string[] | undefined) {
  const config: RulesConfig = { rule_options: {}, rules: { enable: [...DOM_RULES, ...RESPONSE_RULES] } };
  const parsed = parsePage("<!doctype html><html><head></head><body></body></html>", URL_);
  if (notices) parsed.parseNotices = notices;
  const page: PageData = { url: URL_, html, statusCode: 200, loadTime: 0, headers: {}, parsed };
  const { ruleResults } = await new RuleRunner({ config }).runPageRules(page);
  return (id: string) => ruleResults.get(id)?.checks ?? [];
}

describe("a page audited as an empty document reports no missing-markup findings (#1570)", () => {
  test("every markup rule is skipped as not evaluated, none fails or warns", async () => {
    const checks = await run("<html><body><h1>Real</h1></body></html>", [NOTICE]);
    for (const id of DOM_RULES) {
      const own = checks(id);
      expect([id, own.length > 0]).toEqual([id, true]);
      for (const check of own) expect([id, check.status, check.skipReason]).toEqual([id, "skipped", UNREAD_PAGE_SKIP_REASON]);
    }
  });

  test("crawl/html-size still warns html-parse, and the response rules still run", async () => {
    const checks = await run("<html><body></body></html>", [NOTICE]);
    expect(checks("crawl/html-size").find((c) => c.name === "html-parse")?.status).toBe("warn");
    expect(checks("security/https").some((c) => c.status === "skipped" && c.skipReason === UNREAD_PAGE_SKIP_REASON)).toBe(false);
  });

  test("control: an empty document that was NOT a failed parse still reports the missing markup", async () => {
    const checks = await run("<html><body></body></html>", undefined);
    expect(checks("core/meta-title").some((c) => c.status === "fail" || c.status === "warn")).toBe(true);
    expect(checks("core/h1").some((c) => c.status === "fail" || c.status === "warn")).toBe(true);
  });

  test("control: a cut class attribute (page read in full otherwise) is not an unread page", async () => {
    const checks = await run("<html><body></body></html>", ["a class attribute of 640,000 tokens was cut to the first 20,000 to read the page"]);
    expect(checks("core/h1").some((c) => c.status === "skipped" && c.skipReason === UNREAD_PAGE_SKIP_REASON)).toBe(false);
  });
});
