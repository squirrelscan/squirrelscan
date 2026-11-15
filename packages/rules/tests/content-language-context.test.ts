// Page rules read the detected content language from the rule context:
// `ctx.contentLanguage` is set for every page rule, one lazy view per page shared by its rules, distinct from the declared
// `<html lang>`. The sample text was written for this test.

import type { ContentLanguageView } from "@squirrelscan/parser";

import { describe, expect, test } from "bun:test";

import type { RuleNamespace } from "../src/loader";
import type { Rule } from "../src/types";

import { RuleRunner } from "../src/runner";

const DE =
  "Das Eichhörnchen hat vor dem ersten Schnee zwölf Eicheln unter der alten Eiche im Garten vergraben, weil es den Winter fürchtet.";

describe("ctx.contentLanguage through the real runner", () => {
  test("page rules get one shared view per page; abstained blocks are null", async () => {
    const views: (ContentLanguageView | undefined)[] = [];
    const probe = (id: string): Rule => ({
      meta: {
        id,
        name: "contentLanguage probe (test)",
        description: "records ctx.contentLanguage",
        category: "content",
        scope: "page",
        severity: "info",
        weight: 1,
      },
      run(ctx) {
        views.push(ctx.contentLanguage);
        return { checks: [{ name: "probe", status: "pass", message: "ok" }] };
      },
    });
    const ns: RuleNamespace = {
      name: "test",
      rules: [probe("test/cl-a"), probe("test/cl-b")],
    };
    const runner = new RuleRunner({
      config: { rule_options: {}, rules: { enable: ["test/*"] } },
      additionalNamespaces: [ns],
    });
    const html = `<!doctype html><html lang="en"><body><main><h2>Hallo</h2><p>${DE}</p><p>${DE}</p></main></body></html>`;
    await runner.runPageRules(
      {
        url: "https://example.com/",
        html,
        statusCode: 200,
        loadTime: 0,
        headers: {},
      } as never,
      {
        baseUrl: "https://example.com",
        pages: [],
        robotsTxt: null,
        sitemaps: null,
      } as never
    );
    expect(views).toHaveLength(2);
    expect(views[0]).toBeDefined();
    expect(views[1]).toBe(views[0]);
    const view = views[0]!;
    expect(view.page()?.lang).toBe("de");
    expect(view.blocks().map((b) => [b.tag, b.language?.lang ?? null])).toEqual(
      [
        ["h2", null],
        ["p", "de"],
        ["p", "de"],
      ]
    );
  });
});
