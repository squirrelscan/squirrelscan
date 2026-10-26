// pub#684: content/hidden-text never applied a `<style>` rule whose selector
// had a CSS comment before or inside it. The scanner skipped comments while
// looking for `{`, but kept them in the selector text, so `/* Header */ .b` was
// not a bare class selector: it was read as complex and only marked `.b`
// ambiguous. A browser drops comments while tokenizing and applies the rule.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { hiddenTextRule } from "../src/content/hidden-text";
import type { ParsedPage, RuleContext } from "../src/types";

const PAYLOAD = "Sixty or more characters of ordinary visible paragraph text go here, so the rule has something to flag.";

function status(css: string, cls = "b", id?: string): string {
  const html = `<html><head><style>${css}</style></head><body><p class="${cls}"${id ? ` id="${id}"` : ""}>${PAYLOAD}</p></body></html>`;
  const ctx = {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: parseHTML(html).document } as unknown as ParsedPage,
    options: {},
  } as unknown as RuleContext;
  return hiddenTextRule.run(ctx).checks[0]!.status;
}

describe("content/hidden-text — CSS comments in a selector (pub#684)", () => {
  test("the issue's repro: a section comment before a plain class rule", () => {
    expect(status(".a{color:red}\n/* Section */\n.b{display:none}")).toBe("warn");
  });

  test("a comment between the selector and its block, or inside the selector, is ignored", () => {
    expect(status(".b /* x */ {display:none}")).toBe("warn");
    expect(status("/* a */.b/* b */{display:none}")).toBe("warn");
  });

  test("a selector still complex without its comments stays ambiguous", () => {
    expect(status(".b{display:none} .a /* x */ .b{display:block}")).toBe("pass");
    // `.a/**/.b` is the compound `.a.b` once the comment is dropped.
    expect(status(".b{display:none} .a/**/.b{display:block}")).toBe("pass");
  });

  test("a comment between two name characters keeps them apart: `.a` + comment + `b` is not `.ab`", () => {
    expect(status(".a/**/b{display:none}", "ab")).toBe("pass");
    expect(status("#a/**/b{display:none}", "x", "ab")).toBe("pass");
    // The control: the id itself is applied.
    expect(status("#ab{display:none}", "x", "ab")).toBe("warn");
  });

  test("comment-like text inside a quoted attribute value is not a comment", () => {
    // `[title="/* x */"].b` is a complex selector; stripping inside the string
    // would turn it into the bare `.b` and wrongly apply the rule.
    expect(status('.b{color:red} [title="/* x */"].b{display:none}')).toBe("pass");
  });
});
