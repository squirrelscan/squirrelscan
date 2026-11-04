import { loadAllRules } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";

import {
  findUnknownRulePatterns,
  formatUnknownRuleWarning,
} from "@/audit/unknown-rule-patterns";
import { getDefaultConfig } from "@/config";
import { renderInitToml } from "@/controllers/init";
import { RULE_CATEGORY_VALUES } from "@/rules/categories";

const ids = [...loadAllRules({ includeOptIn: true }).keys()];
const find = (patterns: string[]) =>
  findUnknownRulePatterns(patterns, ids, RULE_CATEGORY_VALUES);

describe("unknown [rules] entries (#1587)", () => {
  test("an unknown id warns and suggests the closest id", () => {
    const result = find(["crawl/robot-txt"]);
    expect(result).toEqual([
      { pattern: "crawl/robot-txt", suggestion: "crawl/robots-txt" },
    ]);
  });

  test("an unknown category glob warns", () => {
    expect(find(["typo-cat/*"]).map((u) => u.pattern)).toEqual(["typo-cat/*"]);
  });

  test("a valid exact id, a valid glob, a legacy glob and * do not warn", () => {
    expect(find(["security/csp", "eeat/*", "ai/*", "adblock/*", "*"])).toEqual(
      []
    );
  });

  test("an entry with nothing close gets no suggestion, repeats report once", () => {
    expect(find(["zzzzzzzzzz/qqqqqqqq", "zzzzzzzzzz/qqqqqqqq"])).toEqual([
      { pattern: "zzzzzzzzzz/qqqqqqqq" },
    ]);
  });

  test("a partial wildcard matches no rule and warns", () => {
    expect(find(["core/og-*"]).length).toBe(1);
  });

  test("one warning names every unknown entry of both lists", () => {
    const text = formatUnknownRuleWarning(
      find(["eeat/nope", "security/csp"]),
      find(["crawl/robot-txt"])
    );
    expect(text).toContain('"eeat/nope" in [rules] disable');
    expect(text).toContain(
      '"crawl/robot-txt" in [rules] enable (did you mean "crawl/robots-txt"?)'
    );
    expect(text).not.toContain("security/csp");
  });

  test("no warning when every entry is known", () => {
    expect(formatUnknownRuleWarning(find(["eeat/*"]), find(["*"]))).toBe(
      undefined
    );
  });
});

describe("squirrel init template (#1587)", () => {
  const text = renderInitToml(getDefaultConfig());

  test("it is still the default config", () => {
    expect(parseTOML(text)).toEqual(
      parseTOML(stringifyTOML(getDefaultConfig()))
    );
    const parsed = parseTOML(text) as { rules: { enable: string[] } };
    expect(parsed.rules.enable).toEqual(["*"]);
  });

  test("a blank line separates every table from the line before it", () => {
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      if (i > 0 && line.startsWith("[")) {
        expect(lines[i - 1] === "" || lines[i - 1]!.startsWith("#")).toBe(true);
      }
    }
    expect(text).toContain("[crawler.headers]\n\n");
  });

  test("[rules] and [project] carry comments", () => {
    expect(text).toContain("category/rule");
    expect(text).toContain("eeat/*");
    expect(text).toContain("[[ignore]]");
    expect(text).toContain("https://docs.squirrelscan.com/rules");
    expect(text).toMatch(/# Extra hostnames[^\n]*\n[^\n]*\n\[project\]/);
  });
});
