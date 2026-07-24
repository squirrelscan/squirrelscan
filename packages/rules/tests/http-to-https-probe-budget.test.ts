// #1252: the http→https probe runs INSIDE the rules phase and re-hits the target
// host, so it must be bounded — a total wall-clock budget for the whole probe and
// a per-hop timeout signal in followRedirects. These assert the bounds without
// waiting out the real 10s per-hop timeout.

import { afterEach, describe, expect, test } from "bun:test";

import type { RedirectChain } from "@squirrelscan/core-contracts";

import { probeHttpVariants } from "../src/security/http-to-https";
import { followRedirects } from "../src/links/redirects";
import { setRequestAsync } from "../src/tools";

function chain(from: string, to: string, httpToHttps: boolean): RedirectChain {
  return {
    sourceUrl: from,
    finalUrl: to,
    hops: [{ url: from, statusCode: 301, type: "http" }],
    chainLength: 1,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("probeHttpVariants total budget (#1252)", () => {
  test("stops launching new probes once the budget is spent", async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://tarpit.com/p${i}`);
    let probed = 0;
    const probe = async (httpUrl: string): Promise<RedirectChain> => {
      probed++;
      await sleep(30); // each probe is slow, like a tarpitting host
      return chain(httpUrl, httpUrl.replace("http://", "https://"), true);
    };

    const results = await probeHttpVariants(urls, "https://tarpit.com", probe, {
      concurrency: 1,
      staggerMs: 0,
      budgetMs: 50,
    });

    // Only the handful that fit inside 50ms were launched — not all 10.
    expect(probed).toBeLessThan(urls.length);
    expect(probed).toBeGreaterThan(0);
    // Whatever DID complete is still reported (partial, not empty).
    expect(results.length).toBeLessThanOrEqual(probed);
  });

  test("probes every url when comfortably inside the budget", async () => {
    const urls = ["https://ok.com/a", "https://ok.com/b"];
    let probed = 0;
    const probe = async (httpUrl: string): Promise<RedirectChain> => {
      probed++;
      return chain(httpUrl, httpUrl.replace("http://", "https://"), true);
    };
    const results = await probeHttpVariants(urls, "https://ok.com", probe, {
      concurrency: 2,
      staggerMs: 0,
      budgetMs: 10_000,
    });
    expect(probed).toBe(2);
    expect(results.length).toBe(2);
  });
});

describe("followRedirects per-hop timeout wiring (#1252)", () => {
  afterEach(() => {
    // Restore the default (throwing) injector so other tests aren't affected.
    setRequestAsync(() => {
      throw new Error("requestAsync not injected");
    });
  });

  test("passes an AbortSignal to the request tool for each hop", async () => {
    let seenSignal: unknown;
    setRequestAsync(async (_url, options) => {
      seenSignal = options?.signal;
      // Terminal 200 so the loop makes exactly one hop.
      return new Response(null, { status: 200 });
    });

    await followRedirects("https://example.com/");
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  test("degrades gracefully when the request aborts (timeout)", async () => {
    setRequestAsync(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });

    const result = await followRedirects("https://slow.example.com/");
    expect(result.endsInError).toBe(true);
    expect(result.hops[result.hops.length - 1]?.statusCode).toBe(0);
  });
});
