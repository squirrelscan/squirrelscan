// Tests for the concurrent HTTP→HTTPS probe pool (security/http-to-https).
// The old serial 500ms-per-probe loop took ~10s for 20 urls and dominated
// the rules phase; probes now run on a bounded worker pool.

import type { RedirectChain } from "@squirrelscan/core-contracts";

import { probeHttpVariants } from "@squirrelscan/rules/security/http-to-https";
import { describe, expect, test } from "bun:test";

const BASE = "https://example.com";

function chainTo(finalUrl: string, statusCode = 301): RedirectChain {
  return {
    sourceUrl: "http://example.com/",
    finalUrl,
    hops: [{ url: "http://example.com/", statusCode, type: "http" }],
    chainLength: 1,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: finalUrl.startsWith("https://"),
  };
}

describe("probeHttpVariants", () => {
  test("probes run concurrently up to the pool size", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const urls = Array.from({ length: 10 }, (_, i) => `${BASE}/page${i}`);
    const results = await probeHttpVariants(
      urls,
      BASE,
      async (httpUrl) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return chainTo(httpUrl.replace("http://", "https://"));
      },
      { concurrency: 5, staggerMs: 0 }
    );

    expect(results).toHaveLength(10);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  test("preserves input order in results", async () => {
    const urls = [`${BASE}/a`, `${BASE}/b`, `${BASE}/c`];
    const results = await probeHttpVariants(
      urls,
      BASE,
      async (httpUrl) => {
        // Finish in reverse order to prove ordering is restored
        const delayMs = httpUrl.endsWith("/a")
          ? 40
          : httpUrl.endsWith("/b")
            ? 20
            : 1;
        await new Promise((r) => setTimeout(r, delayMs));
        return chainTo(httpUrl.replace("http://", "https://"));
      },
      { concurrency: 3, staggerMs: 0 }
    );

    expect(results.map((r) => r.from)).toEqual([
      "http://example.com/a",
      "http://example.com/b",
      "http://example.com/c",
    ]);
  });

  test("skips loops, failures, and non-https finals", async () => {
    const urls = [
      `${BASE}/loop`,
      `${BASE}/throws`,
      `${BASE}/stays-http`,
      `${BASE}/ok`,
    ];
    const results = await probeHttpVariants(
      urls,
      BASE,
      async (httpUrl) => {
        if (httpUrl.includes("loop")) {
          return { ...chainTo("https://example.com/loop"), isLoop: true };
        }
        if (httpUrl.includes("throws")) throw new Error("network");
        if (httpUrl.includes("stays-http")) {
          return {
            ...chainTo("http://example.com/stays-http"),
            httpToHttps: false,
          };
        }
        return chainTo("https://example.com/ok");
      },
      { concurrency: 2, staggerMs: 0 }
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.from).toBe("http://example.com/ok");
    expect(results[0]!.to).toBe("https://example.com/ok");
    expect(results[0]!.statusCode).toBe(301);
  });

  test("skips cross-host probe targets", async () => {
    let probed = 0;
    const results = await probeHttpVariants(
      ["https://other.example.org/x"],
      BASE,
      async (httpUrl) => {
        probed++;
        return chainTo(httpUrl);
      },
      { concurrency: 1, staggerMs: 0 }
    );
    expect(probed).toBe(0);
    expect(results).toHaveLength(0);
  });
});
