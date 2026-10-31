// The `[[ignore]]` config table (#1262): what the schema accepts and refuses.

import { describe, expect, test } from "bun:test";

import { ConfigSchema, IgnoreEntrySchema, MAX_IGNORE_ENTRIES, MAX_IGNORE_MATCHERS, getDefaultConfig } from "../src";

const parse = (entry: unknown) => IgnoreEntrySchema.safeParse(entry);
const messages = (entry: unknown): string[] => {
  const r = parse(entry);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("IgnoreEntrySchema", () => {
  test("accepts items, urls, both, with checks and a reason", () => {
    expect(parse({ rule: "security/cookie-flags", items: ["localization"] }).success).toBe(true);
    expect(parse({ rule: "perf/ttfb", urls: ["/apps/"] }).success).toBe(true);
    expect(
      parse({ rule: "a11y/*", checks: ["x"], items: ["glob:a*"], urls: ["regex:^/a"], reason: "why" }).success,
    ).toBe(true);
  });

  test("refuses an entry with no items, urls or selectors and points at [rules] disable", () => {
    expect(messages({ rule: "perf/ttfb" })[0]).toContain('[rules] disable = ["perf/ttfb"]');
    expect(messages({ rule: "perf/ttfb", items: [], urls: [] })).toHaveLength(1);
  });

  test("accepts selectors (#1440), alone or beside items and urls, and caps them", () => {
    expect(parse({ rule: "a11y/x", selectors: ["localization-form select"] }).success).toBe(true);
    expect(parse({ rule: "a11y/x", items: ["a"], urls: ["/p/"], selectors: ["form select"] }).success).toBe(true);
    expect(parse({ rule: "a11y/x", selectors: [] }).success).toBe(false);
    expect(parse({ rule: "a11y/x", selectors: ["a".repeat(301)] }).success).toBe(false);
    expect(parse({ rule: "a11y/x", selectors: Array.from({ length: MAX_IGNORE_MATCHERS + 1 }, (_, i) => `s${i}`) }).success).toBe(false);
    expect(messages({ rule: "a11y/x", selectors: [] })[0]).toContain("items, urls or selectors");
  });

  test("caps the rule, the matchers and the reason", () => {
    expect(parse({ rule: "", items: ["a"] }).success).toBe(false);
    expect(parse({ rule: "r/x", items: ["a".repeat(201)] }).success).toBe(false);
    expect(parse({ rule: "r/x", urls: ["a".repeat(513)] }).success).toBe(false);
    expect(parse({ rule: "r/x", items: Array.from({ length: MAX_IGNORE_MATCHERS + 1 }, (_, i) => `i${i}`) }).success).toBe(false);
    expect(parse({ rule: "r/x", items: ["a"], reason: "x".repeat(501) }).success).toBe(false);
  });
});

describe("Config.ignore", () => {
  test("is optional: the defaults carry no ignore list", () => {
    expect("ignore" in getDefaultConfig()).toBe(false);
    expect(ConfigSchema.parse({}).ignore).toBeUndefined();
  });

  test("a list of entries parses and keeps its order", () => {
    const parsed = ConfigSchema.parse({
      ignore: [
        { rule: "a/x", items: ["1"] },
        { rule: "b/y", urls: ["/2/"] },
      ],
    });
    expect(parsed.ignore?.map((e) => e.rule)).toEqual(["a/x", "b/y"]);
  });

  test("caps the number of entries", () => {
    const entries = Array.from({ length: MAX_IGNORE_ENTRIES + 1 }, (_, i) => ({ rule: `r/${i}`, items: ["a"] }));
    expect(ConfigSchema.safeParse({ ignore: entries }).success).toBe(false);
  });
});
