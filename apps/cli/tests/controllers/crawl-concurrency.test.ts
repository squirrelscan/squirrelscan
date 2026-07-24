// Tests for resolveCrawlConcurrency — cloud-render crawls must not be
// throttled by plain-HTTP per-host limits (root cause of serial ~15s/page
// rendered crawls), while plain-HTTP crawls keep their politeness settings.

import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { CloudConfigSchema, getDefaultConfig } from "@squirrelscan/config";
import { describe, expect, test } from "bun:test";

import {
  deriveUserSetConcurrency,
  LOOPBACK_FAST_CONCURRENCY,
  LOOPBACK_FAST_PER_HOST_CONCURRENCY,
  renderConcurrencyUpsellHint,
  resolveCrawlConcurrency,
} from "../../src/controllers/audit";

function fetcherWithId(id: string): DocumentFetcher {
  return {
    id,
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch() {
      throw new Error("not used");
    },
  };
}

describe("resolveCrawlConcurrency", () => {
  test("plain HTTP crawl keeps configured per-host throttling", () => {
    const config = getDefaultConfig();
    const result = resolveCrawlConcurrency(config, undefined);
    expect(result).toEqual({
      concurrency: config.crawler.concurrency,
      perHostConcurrency: config.crawler.per_host_concurrency,
      perHostDelayMs: config.crawler.per_host_delay_ms,
    });
  });

  test("loopback target with no override gets the fast profile", () => {
    const config = getDefaultConfig();
    const result = resolveCrawlConcurrency(config, undefined, undefined, {
      isLoopback: true,
      userOverride: false,
    });
    expect(result).toEqual({
      concurrency: LOOPBACK_FAST_CONCURRENCY,
      perHostConcurrency: LOOPBACK_FAST_PER_HOST_CONCURRENCY,
      perHostDelayMs: 0,
    });
  });

  test("explicit override suppresses the loopback fast profile", () => {
    const config = getDefaultConfig();
    const result = resolveCrawlConcurrency(config, undefined, undefined, {
      isLoopback: true,
      userOverride: true,
    });
    expect(result.concurrency).toBe(config.crawler.concurrency);
    expect(result.perHostConcurrency).toBe(config.crawler.per_host_concurrency);
    expect(result.perHostDelayMs).toBe(config.crawler.per_host_delay_ms);
  });

  test("non-loopback target never gets the fast profile", () => {
    const config = getDefaultConfig();
    const result = resolveCrawlConcurrency(config, undefined, undefined, {
      isLoopback: false,
      userOverride: false,
    });
    expect(result.concurrency).toBe(config.crawler.concurrency);
  });

  test("hybrid render fetcher on loopback keeps base (renders honor the clamp)", () => {
    const config = getDefaultConfig();
    // A non-cloud-render fetcher (e.g. quick-mode hybrid) still submits renders,
    // so the loopback boost must NOT apply — it would fan renders past the clamp.
    const result = resolveCrawlConcurrency(
      config,
      fetcherWithId("hybrid-http-first"),
      undefined,
      { isLoopback: true, userOverride: false }
    );
    expect(result.concurrency).toBe(config.crawler.concurrency);
    expect(result.perHostConcurrency).toBe(config.crawler.per_host_concurrency);
  });

  test("loopback fast profile never applies to cloud-render crawls", () => {
    const config = getDefaultConfig();
    const result = resolveCrawlConcurrency(
      config,
      fetcherWithId("cloud-render"),
      undefined,
      { isLoopback: true, userOverride: false }
    );
    // cloud-render path wins — render_concurrency, not the loopback profile.
    expect(result.concurrency).toBe(config.cloud.render_concurrency);
  });

  test("non-render custom fetcher keeps configured throttling", () => {
    const config = getDefaultConfig();
    const result = resolveCrawlConcurrency(config, fetcherWithId("custom"));
    expect(result.perHostConcurrency).toBe(config.crawler.per_host_concurrency);
    expect(result.perHostDelayMs).toBe(config.crawler.per_host_delay_ms);
  });

  test("cloud-render fetcher raises parallelism to render_concurrency", () => {
    const config = getDefaultConfig();
    expect(config.cloud.render_concurrency).toBe(6);

    const result = resolveCrawlConcurrency(
      config,
      fetcherWithId("cloud-render")
    );
    expect(result.concurrency).toBe(6);
    expect(result.perHostConcurrency).toBe(6);
    // Render workers hit the target host, not the CLI — no submit delay.
    expect(result.perHostDelayMs).toBe(0);
  });

  test("render_concurrency bounds BOTH worker pool and per-host renders", () => {
    const config = getDefaultConfig();
    config.crawler.concurrency = 10;
    config.crawler.per_host_concurrency = 6;
    config.cloud.render_concurrency = 2;

    const result = resolveCrawlConcurrency(
      config,
      fetcherWithId("cloud-render")
    );
    // Every worker is a render job in cloud-render mode; the global pool must
    // be capped too or a multi-host crawl runs hosts × limit renders.
    expect(result.concurrency).toBe(2);
    expect(result.perHostConcurrency).toBe(2);
  });

  test("plan limit clamps render concurrency (free plan = 1)", () => {
    const config = getDefaultConfig();
    expect(config.cloud.render_concurrency).toBe(6);

    const result = resolveCrawlConcurrency(
      config,
      fetcherWithId("cloud-render"),
      1
    );
    expect(result.perHostConcurrency).toBe(1);
    expect(result.concurrency).toBe(1);
  });

  test("plan limit above configured value is a no-op", () => {
    const config = getDefaultConfig();
    config.cloud.render_concurrency = 5;

    const result = resolveCrawlConcurrency(
      config,
      fetcherWithId("cloud-render"),
      8
    );
    expect(result.perHostConcurrency).toBe(5);
  });

  test("undefined plan limit keeps configured value (fail-open)", () => {
    const config = getDefaultConfig();
    const result = resolveCrawlConcurrency(
      config,
      fetcherWithId("cloud-render"),
      undefined
    );
    expect(result.perHostConcurrency).toBe(config.cloud.render_concurrency);
  });

  test("plan limit does not apply to plain HTTP crawls", () => {
    const config = getDefaultConfig();
    const result = resolveCrawlConcurrency(config, undefined, 1);
    expect(result.perHostConcurrency).toBe(config.crawler.per_host_concurrency);
  });

  test("config schema accepts render_concurrency up to 10 and rejects above", () => {
    expect(
      CloudConfigSchema.parse({ render_concurrency: 10 }).render_concurrency
    ).toBe(10);
    expect(() => CloudConfigSchema.parse({ render_concurrency: 11 })).toThrow();
  });

  test("plan limit clamps render concurrency (team plan = 10)", () => {
    const config = getDefaultConfig();
    config.cloud.render_concurrency = 10;

    const result = resolveCrawlConcurrency(
      config,
      fetcherWithId("cloud-render"),
      10
    );
    expect(result.perHostConcurrency).toBe(10);
    expect(result.concurrency).toBe(10);
  });
});

describe("deriveUserSetConcurrency", () => {
  test("false when no flags and config is all schema defaults", () => {
    expect(deriveUserSetConcurrency({}, getDefaultConfig())).toBe(false);
  });

  test("true when a concurrency flag is passed", () => {
    expect(
      deriveUserSetConcurrency({ concurrency: 8 }, getDefaultConfig())
    ).toBe(true);
    expect(
      deriveUserSetConcurrency({ perHostConcurrency: 2 }, getDefaultConfig())
    ).toBe(true);
  });

  test("true when any config knob differs from its schema default", () => {
    for (const mutate of [
      (c: ReturnType<typeof getDefaultConfig>) => (c.crawler.concurrency = 10),
      (c: ReturnType<typeof getDefaultConfig>) =>
        (c.crawler.per_host_concurrency = 3),
      (c: ReturnType<typeof getDefaultConfig>) =>
        (c.crawler.per_host_delay_ms = 200),
    ]) {
      const config = getDefaultConfig();
      mutate(config);
      expect(deriveUserSetConcurrency({}, config)).toBe(true);
    }
  });
});

describe("renderConcurrencyUpsellHint", () => {
  test("free plan hints at Pro's concurrency", () => {
    expect(renderConcurrencyUpsellHint("free")).toBe(
      " — upgrade to Pro for 5 concurrent renders"
    );
  });

  test('pro plan (planId "starter") hints at Team\'s concurrency', () => {
    expect(renderConcurrencyUpsellHint("starter")).toBe(
      " — upgrade to Team for 10 concurrent renders"
    );
  });

  test("team plan has no higher tier to upsell", () => {
    expect(renderConcurrencyUpsellHint("team")).toBe("");
  });

  test("unknown planId has no upsell hint", () => {
    expect(renderConcurrencyUpsellHint("enterprise")).toBe("");
  });
});
