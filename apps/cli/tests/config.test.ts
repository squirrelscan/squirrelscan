// Tests for config system

import { describe, expect, test } from "bun:test";

import { ConfigSchema, getDefaultConfig } from "../src/config";

describe("ConfigSchema", () => {
  test("parses empty object with defaults", () => {
    const config = ConfigSchema.parse({});
    expect(config.crawler.max_pages).toBe(100); // schema default; coverage mode budget overrides when unset
    expect(config.crawler.coverage).toBeUndefined(); // unset → auth-resolved at the command layer (paid→surface, free/anon→quick)
    expect(config.crawler.delay_ms).toBe(100);
    expect(config.crawler.per_host_concurrency).toBe(5); // #265 single-host throughput bump
    expect(config.crawler.per_host_delay_ms).toBe(50); // #265
    expect(config.crawler.user_agent).toBe(""); // empty = random UA per crawl
    expect(config.rules.enable).toEqual(["*"]);
    expect(config.rules.disable).toEqual([]); // LLM rules now disabled via schema
    expect(config.plugins?.enabled).toBe(false);
    expect(config.plugins?.items).toEqual([]);
  });

  test("parses partial config with overrides", () => {
    const config = ConfigSchema.parse({
      crawler: {
        max_pages: 100,
      },
      rules: {
        disable: ["a11y/*"],
      },
    });
    expect(config.crawler.max_pages).toBe(100);
    expect(config.crawler.delay_ms).toBe(100); // default
    expect(config.rules.disable).toEqual(["a11y/*"]);
  });

  test("validates output format enum", () => {
    const config = ConfigSchema.parse({
      output: {
        format: "json",
      },
    });
    expect(config.output.format).toBe("json");

    expect(() =>
      ConfigSchema.parse({
        output: {
          format: "invalid",
        },
      })
    ).toThrow();
  });
});

describe("getDefaultConfig", () => {
  test("returns valid default config", () => {
    const config = getDefaultConfig();
    expect(config.crawler.max_pages).toBe(100); // schema default; coverage mode budget overrides when unset
    expect(config.crawler.coverage).toBeUndefined(); // unset → auth-resolved at the command layer (paid→surface, free/anon→quick)
    expect(config.rules.enable).toEqual(["*"]);
    expect(config.plugins?.enabled).toBe(false);
  });
});
