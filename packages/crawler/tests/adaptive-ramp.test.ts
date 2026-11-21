// repo#1024: adaptive per-host ramp-up above the configured concurrency.
import { describe, expect, test } from "bun:test";

import { createHostBackoff } from "../src/host-backoff";

const HOST = "origin.example.com";

function feed(
  registry: ReturnType<typeof createHostBackoff>,
  n: number,
  rampAllowed = true
) {
  for (let i = 0; i < n; i++) registry.noteSuccess(HOST, { rampAllowed });
}

describe("adaptive ramp-up", () => {
  test("a clean origin climbs one slot per streak and never passes the ceiling", () => {
    const r = createHostBackoff({
      perHostConcurrency: 2,
      maxPerHostConcurrency: 5,
      rampSuccesses: 10,
    });
    expect(r.concurrencyFor(HOST)).toBe(2);
    feed(r, 10);
    expect(r.concurrencyFor(HOST)).toBe(3);
    feed(r, 1000);
    expect(r.concurrencyFor(HOST)).toBe(5);
    expect(r.maxConcurrency()).toBe(5);
    expect(r.isThrottled(HOST)).toBe(false);
  });

  test("without a ceiling above the configured value nothing ramps", () => {
    const off = createHostBackoff({ perHostConcurrency: 3, rampSuccesses: 1 });
    feed(off, 100);
    expect(off.concurrencyFor(HOST)).toBe(3);
    const low = createHostBackoff({
      perHostConcurrency: 3,
      maxPerHostConcurrency: 2,
      rampSuccesses: 1,
    });
    feed(low, 100);
    expect(low.concurrencyFor(HOST)).toBe(3);
    expect(low.maxConcurrency()).toBe(3);
  });

  test("a robots Crawl-delay (rampAllowed false) blocks the ramp", () => {
    const r = createHostBackoff({
      perHostConcurrency: 1,
      maxPerHostConcurrency: 8,
      rampSuccesses: 1,
    });
    feed(r, 100, false);
    expect(r.concurrencyFor(HOST)).toBe(1);
  });

  test("a rate limit drops to 1 and recovery returns only to the configured value", () => {
    const r = createHostBackoff({
      perHostConcurrency: 2,
      maxPerHostConcurrency: 6,
      rampSuccesses: 1,
      recoverySuccesses: 1,
    });
    feed(r, 10);
    expect(r.concurrencyFor(HOST)).toBe(6);
    r.noteRateLimited(HOST, 1000);
    expect(r.concurrencyFor(HOST)).toBe(1);
    feed(r, 1);
    expect(r.concurrencyFor(HOST)).toBe(2);
    expect(r.concurrencyFor(HOST)).toBeLessThanOrEqual(2);
  });

  test("hosts ramp independently and reset clears the ramp", () => {
    const r = createHostBackoff({
      perHostConcurrency: 1,
      maxPerHostConcurrency: 4,
      rampSuccesses: 1,
    });
    feed(r, 3);
    expect(r.concurrencyFor(HOST)).toBe(4);
    expect(r.concurrencyFor("other.example.com")).toBe(1);
    r.reset();
    expect(r.concurrencyFor(HOST)).toBe(1);
  });
});
