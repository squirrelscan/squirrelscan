// Tests for CLI option merging into config

import { describe, expect, test } from "bun:test";

import { getDefaultConfig } from "../src/config";
import {
  CRAWL_PHASE_MAX_TIMEOUT_MS,
  CRAWL_PHASE_MIN_TIMEOUT_MS,
  CRAWL_PHASE_PER_PAGE_BUDGET_MS,
  CRAWL_PHASE_SETUP_SLACK_MS,
} from "../src/constants";
import {
  mergeOptionsToConfig,
  resolveCrawlPhaseTimeoutMs,
} from "../src/controllers/audit";

describe("mergeOptionsToConfig", () => {
  test("preserves config values by default", () => {
    const config = getDefaultConfig();
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
    });

    // Empty disable list is the default (LLM rules disabled via schema)
    expect(merged.rules.disable).toEqual([]);
  });

  test("merges maxPages option", () => {
    const config = getDefaultConfig();
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      maxPages: 100,
    });

    expect(merged.crawler.max_pages).toEqual(100);
  });

  test("merges concurrency + per-host overrides (flag > config)", () => {
    const config = getDefaultConfig();
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      concurrency: 12,
      perHostConcurrency: 8,
    });

    expect(merged.crawler.concurrency).toBe(12);
    expect(merged.crawler.per_host_concurrency).toBe(8);
  });

  test("floors and clamps concurrency overrides to >= 1", () => {
    const config = getDefaultConfig();
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      concurrency: 3.9,
      perHostConcurrency: 0,
    });

    expect(merged.crawler.concurrency).toBe(3);
    expect(merged.crawler.per_host_concurrency).toBe(1);
  });

  test("merges and clamps crawler timeout override", () => {
    const config = getDefaultConfig();
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      crawlerTimeoutMs: 250,
    });

    expect(merged.crawler.timeout_ms).toBe(1000);
  });

  test("can disable external link checks per run", () => {
    const config = getDefaultConfig();
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      externalLinksEnabled: false,
    });

    expect(merged.external_links.enabled).toBe(false);
  });

  // repo#2729: the internal link probe requests the audited site only, so
  // --offline keeps it and --no-internal-links switches it off.
  test("can disable internal link checks per run; offline keeps them", () => {
    const config = getDefaultConfig();
    const off = mergeOptionsToConfig(config, {
      url: "https://example.com",
      internalLinksEnabled: false,
    });
    expect(off.internal_links?.enabled).toBe(false);

    const offline = mergeOptionsToConfig(config, {
      url: "https://example.com",
      offline: true,
    });
    expect(offline.external_links.enabled).toBe(false);
    expect(offline.internal_links?.enabled).not.toBe(false);
  });

  // #2307: the page classifier is on by default; --no-classifier switches it off for the run and
  // the config's own choice stands when the flag is absent.
  test("the page classifier is on by default and --no-classifier turns it off", () => {
    const config = getDefaultConfig();
    expect(config.classifier?.enabled).not.toBe(false);
    const off = mergeOptionsToConfig(config, {
      url: "https://example.com",
      classifierEnabled: false,
    });
    expect(off.classifier?.enabled).toBe(false);
    const kept = mergeOptionsToConfig(
      { ...config, classifier: { enabled: false } },
      { url: "https://example.com" }
    );
    expect(kept.classifier?.enabled).toBe(false);
    const on = mergeOptionsToConfig(config, { url: "https://example.com" });
    expect(on.classifier?.enabled).not.toBe(false);
  });

  test("clamps external link overrides to safe minimums", () => {
    const config = getDefaultConfig();
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      externalLinksConcurrency: 0,
      externalLinksTimeoutMs: 100,
    });

    expect(merged.external_links.concurrency).toBe(1);
    expect(merged.external_links.timeout_ms).toBe(1000);
  });

  test("explicit smartAudits: false wins over config smart_audits: true", () => {
    const config = getDefaultConfig();
    config.smart_audits = true;
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      smartAudits: false,
    });

    expect(merged.smart_audits).toBe(false);
  });

  test("unset smartAudits falls back to config smart_audits", () => {
    const config = getDefaultConfig();
    config.smart_audits = true;
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
    });

    expect(merged.smart_audits).toBe(true);
  });

  test("unset smartAudits + unset config stays undefined (anon/programmatic → off)", () => {
    const config = getDefaultConfig();
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
    });

    expect(merged.smart_audits).toBeUndefined();
  });

  test("preserves TOML [crawler] headers when no CLI headers given", () => {
    const config = getDefaultConfig();
    config.crawler.headers = { "X-From-Toml": "1" };
    const merged = mergeOptionsToConfig(config, { url: "https://example.com" });

    expect(merged.crawler.headers).toEqual({ "X-From-Toml": "1" });
  });

  test("CLI headers override TOML headers whose names differ only in case (#3346)", () => {
    const config = getDefaultConfig();
    config.crawler.headers = {
      "x-override": "toml",
      "User-Agent": "toml-ua",
      "X-Keep": "toml",
    };
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      headers: { "X-Override": "cli", "user-agent": "cli-ua" },
    });

    expect(merged.crawler.headers).toEqual({
      "X-Keep": "toml",
      "X-Override": "cli",
      "user-agent": "cli-ua",
    });
    const sent = new Headers(merged.crawler.headers);
    expect(sent.get("x-override")).toBe("cli");
    expect(sent.get("user-agent")).toBe("cli-ua");
  });

  test("CLI headers override matching TOML headers, others kept", () => {
    const config = getDefaultConfig();
    config.crawler.headers = { "X-Keep": "toml", "X-Override": "toml" };
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      headers: { "X-Override": "cli", "X-New": "cli" },
    });

    expect(merged.crawler.headers).toEqual({
      "X-Keep": "toml",
      "X-Override": "cli",
      "X-New": "cli",
    });
  });

  // #1066
  test("unset ruleInclude/ruleExclude leaves config.rules untouched", () => {
    const config = getDefaultConfig();
    config.rules.enable = ["*"];
    config.rules.disable = ["legacy/rule"];
    const merged = mergeOptionsToConfig(config, { url: "https://example.com" });

    expect(merged.rules.enable).toEqual(["*"]);
    expect(merged.rules.disable).toEqual(["legacy/rule"]);
  });

  test("ruleInclude REPLACES config.rules.enable", () => {
    const config = getDefaultConfig();
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      ruleInclude: ["ax/*", "perf/*"],
    });

    expect(merged.rules.enable).toEqual(["ax/*", "perf/*"]);
  });

  test("ruleExclude APPENDS to config.rules.disable", () => {
    const config = getDefaultConfig();
    config.rules.disable = ["legacy/rule"];
    const merged = mergeOptionsToConfig(config, {
      url: "https://example.com",
      ruleExclude: ["images/*"],
    });

    expect(merged.rules.disable).toEqual(["legacy/rule", "images/*"]);
  });
});

describe("resolveCrawlPhaseTimeoutMs", () => {
  const opts = (over = {}) => ({ url: "https://example.com", ...over });

  test("explicit positive option wins (floored)", () => {
    expect(
      resolveCrawlPhaseTimeoutMs(opts({ crawlPhaseTimeoutMs: 12_345.7 }), 25, 1)
    ).toBe(12_345);
  });

  test("explicit <=0 disables the guard", () => {
    expect(
      resolveCrawlPhaseTimeoutMs(opts({ crawlPhaseTimeoutMs: 0 }), 25, 1)
    ).toBeUndefined();
  });

  test("scales with pages / concurrency", () => {
    // 25 pages at concurrency 1: 25 * perPage + slack
    expect(resolveCrawlPhaseTimeoutMs(opts(), 25, 1)).toBe(
      25 * CRAWL_PHASE_PER_PAGE_BUDGET_MS + CRAWL_PHASE_SETUP_SLACK_MS
    );
    // Concurrency 5 → ceil(25/5)=5 batches
    expect(resolveCrawlPhaseTimeoutMs(opts(), 25, 5)).toBe(
      5 * CRAWL_PHASE_PER_PAGE_BUDGET_MS + CRAWL_PHASE_SETUP_SLACK_MS
    );
  });

  test("clamps to floor for tiny crawls and ceiling for huge ones", () => {
    expect(resolveCrawlPhaseTimeoutMs(opts(), 1, 1)).toBe(
      CRAWL_PHASE_MIN_TIMEOUT_MS
    );
    expect(resolveCrawlPhaseTimeoutMs(opts(), 100_000, 1)).toBe(
      CRAWL_PHASE_MAX_TIMEOUT_MS
    );
  });

  test("ceiling is above the old 30 minute clamp and still finite (#1639)", () => {
    expect(CRAWL_PHASE_MAX_TIMEOUT_MS).toBeGreaterThan(1_800_000);
    expect(Number.isFinite(CRAWL_PHASE_MAX_TIMEOUT_MS)).toBe(true);
  });

  test("a polite single-host crawl of 3,913 pages is no longer cut at 30 minutes", () => {
    // 3,913 pages, per-host concurrency 1: the pool size does not help.
    const ms = resolveCrawlPhaseTimeoutMs(opts(), 3913, 8, 1);
    expect(ms).toBeGreaterThan(1_800_000);
    expect(ms).toBeLessThanOrEqual(CRAWL_PHASE_MAX_TIMEOUT_MS);
  });

  test("the per-host limit bounds the effective parallelism", () => {
    expect(resolveCrawlPhaseTimeoutMs(opts(), 25, 5, 1)).toBe(
      25 * CRAWL_PHASE_PER_PAGE_BUDGET_MS + CRAWL_PHASE_SETUP_SLACK_MS
    );
  });

  test("an explicit value is bounded by the ceiling", () => {
    expect(
      resolveCrawlPhaseTimeoutMs(
        opts({ crawlPhaseTimeoutMs: 10 * CRAWL_PHASE_MAX_TIMEOUT_MS }),
        25,
        1
      )
    ).toBe(CRAWL_PHASE_MAX_TIMEOUT_MS);
  });

  test("the derived value does not exceed the whole-run budget", () => {
    expect(resolveCrawlPhaseTimeoutMs(opts(), 3913, 1, 1, 600_000)).toBe(
      600_000
    );
  });
});
