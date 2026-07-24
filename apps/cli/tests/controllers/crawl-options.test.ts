// Tests for `squirrel crawl`'s --concurrency/--per-host wiring (#1084).
//
// mergeCrawlConcurrencyOptions mirrors mergeOptionsToConfig's crawler-block
// merge in controllers/audit.ts (see tests/audit-options.test.ts). It exists
// because resolveCrawlConcurrency's non-loopback/non-render fallback reads
// straight off `config.crawler.*` — calling it with the raw, unmerged config
// silently drops the CLI flags. Also exercises the merged config flowing into
// resolveCrawlConcurrency/deriveUserSetConcurrency exactly as runCrawl does,
// so this bug class (caught in review before merge) has a standing regression
// test.

import { getDefaultConfig } from "@squirrelscan/config";
import { describe, expect, test } from "bun:test";

import {
  deriveUserSetConcurrency,
  resolveCrawlConcurrency,
} from "../../src/controllers/audit";
import { mergeCrawlConcurrencyOptions } from "../../src/controllers/crawl";

describe("mergeCrawlConcurrencyOptions", () => {
  test("preserves config values when no flags are passed", () => {
    const config = getDefaultConfig();
    const merged = mergeCrawlConcurrencyOptions(config, {});

    expect(merged.crawler.concurrency).toBe(config.crawler.concurrency);
    expect(merged.crawler.per_host_concurrency).toBe(
      config.crawler.per_host_concurrency
    );
  });

  test("merges concurrency + per-host overrides", () => {
    const config = getDefaultConfig();
    const merged = mergeCrawlConcurrencyOptions(config, {
      concurrency: 12,
      perHostConcurrency: 8,
    });

    expect(merged.crawler.concurrency).toBe(12);
    expect(merged.crawler.per_host_concurrency).toBe(8);
  });

  test("merges a single flag, leaving the other at its config value", () => {
    const config = getDefaultConfig();

    const concurrencyOnly = mergeCrawlConcurrencyOptions(config, {
      concurrency: 12,
    });
    expect(concurrencyOnly.crawler.concurrency).toBe(12);
    expect(concurrencyOnly.crawler.per_host_concurrency).toBe(
      config.crawler.per_host_concurrency
    );

    const perHostOnly = mergeCrawlConcurrencyOptions(config, {
      perHostConcurrency: 8,
    });
    expect(perHostOnly.crawler.concurrency).toBe(config.crawler.concurrency);
    expect(perHostOnly.crawler.per_host_concurrency).toBe(8);
  });

  test("floors and clamps concurrency overrides to >= 1", () => {
    const config = getDefaultConfig();
    const merged = mergeCrawlConcurrencyOptions(config, {
      concurrency: 3.9,
      perHostConcurrency: 0,
    });

    expect(merged.crawler.concurrency).toBe(3);
    expect(merged.crawler.per_host_concurrency).toBe(1);
  });
});

describe("crawl concurrency flags end-to-end (merge -> resolve)", () => {
  test("--concurrency/--per-host apply on a non-loopback target", () => {
    const config = getDefaultConfig();
    const options = { concurrency: 10, perHostConcurrency: 4 };
    const merged = mergeCrawlConcurrencyOptions(config, options);
    const loopbackCtx = {
      isLoopback: false,
      userOverride: deriveUserSetConcurrency(options, merged),
    };
    const result = resolveCrawlConcurrency(
      merged,
      undefined,
      undefined,
      loopbackCtx
    );

    expect(result.concurrency).toBe(10);
    expect(result.perHostConcurrency).toBe(4);
  });

  test("--concurrency/--per-host apply on a loopback target too (override wins over the fast profile)", () => {
    const config = getDefaultConfig();
    const options = { concurrency: 10, perHostConcurrency: 4 };
    const merged = mergeCrawlConcurrencyOptions(config, options);
    const loopbackCtx = {
      isLoopback: true,
      userOverride: deriveUserSetConcurrency(options, merged),
    };
    const result = resolveCrawlConcurrency(
      merged,
      undefined,
      undefined,
      loopbackCtx
    );

    // Explicit flags suppress the 16/16 loopback profile — the user's
    // numbers must win, not silently fall back to unmerged config defaults.
    expect(result.concurrency).toBe(10);
    expect(result.perHostConcurrency).toBe(4);
  });

  test("no flags on a loopback target still gets the fast profile", () => {
    const config = getDefaultConfig();
    const options = {};
    const merged = mergeCrawlConcurrencyOptions(config, options);
    const loopbackCtx = {
      isLoopback: true,
      userOverride: deriveUserSetConcurrency(options, merged),
    };
    const result = resolveCrawlConcurrency(
      merged,
      undefined,
      undefined,
      loopbackCtx
    );

    expect(result.concurrency).toBe(16);
    expect(result.perHostConcurrency).toBe(16);
    expect(result.perHostDelayMs).toBe(0);
  });
});
