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

// Domain stats is paused: the hosted service is off, so the audit step is skipped
// by default rather than run against a route that answers 404. The default is the
// whole switch on this side, and it is one character away from silently coming
// back, so it is pinned here alongside the neighbouring cloud step that must NOT
// change.
describe("cloud.domain_stats default (paused)", () => {
  test("defaults to false — the audit runs no domain stats step", () => {
    expect(ConfigSchema.parse({}).cloud.domain_stats).toBe(false);
    expect(getDefaultConfig().cloud.domain_stats).toBe(false);
  });

  test("an explicit true is still honoured — paused, not removed", () => {
    expect(
      ConfigSchema.parse({ cloud: { domain_stats: true } }).cloud.domain_stats
    ).toBe(true);
  });

  test("the other included cloud steps are untouched by the pause", () => {
    const cloud = ConfigSchema.parse({}).cloud;
    expect(cloud.editor_summary).toBe(true);
  });
});

describe("crawler.max_backoff_ms (#1829)", () => {
  test("accepts an explicit value in [crawler]", () => {
    const config = ConfigSchema.parse({ crawler: { max_backoff_ms: 60000 } });
    expect(config.crawler.max_backoff_ms).toBe(60000);
  });

  test("rejects zero with a clear message", () => {
    // 0 would disable backoff entirely and re-create the request cascade the
    // setting exists to stop, so it must not be quietly accepted.
    const result = ConfigSchema.safeParse({ crawler: { max_backoff_ms: 0 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("greater than 0");
    }
  });

  test("rejects a negative value", () => {
    expect(
      ConfigSchema.safeParse({ crawler: { max_backoff_ms: -1 } }).success
    ).toBe(false);
  });

  test("rejects a fractional value", () => {
    const result = ConfigSchema.safeParse({
      crawler: { max_backoff_ms: 1500.5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("whole number");
    }
  });

  test("the packaged default config carries the cap", () => {
    expect(getDefaultConfig().crawler.max_backoff_ms).toBe(300000);
  });
});
