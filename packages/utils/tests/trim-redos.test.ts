// CodeQL js/polynomial-redos: a trailing-run trim must be linear on attacker-sized input (#1764).
import { describe, expect, test } from "bun:test";

import { isReservedUnresolvableHostname } from "../src/public-egress";
import { trimTrailing } from "../src/trim";

const timed = <T>(fn: () => T): [T, number] => {
  const start = performance.now();
  const out = fn();
  return [out, performance.now() - start];
};

describe("trailing-run trims are linear", () => {
  test("trimTrailing drops only the trailing run", () => {
    expect(trimTrailing("a.b...", 46)).toBe("a.b");
    expect(trimTrailing("...", 46)).toBe("");
    expect(trimTrailing("", 46)).toBe("");
    expect(trimTrailing("a.b", 46)).toBe("a.b");
    expect(trimTrailing(".a.", 46)).toBe(".a");
  });

  test("a 100k-dot host is judged in under 50 ms", () => {
    const hosts = [".".repeat(100_000), "a" + ".".repeat(100_000), "x.test" + ".".repeat(100_000), "x." + ".".repeat(100_000) + "z"];
    for (const host of hosts) {
      const [, ms] = timed(() => isReservedUnresolvableHostname(host));
      expect(ms).toBeLessThan(50);
    }
    expect(isReservedUnresolvableHostname("site.test.")).toBe(true);
    expect(isReservedUnresolvableHostname("x.test" + ".".repeat(100_000))).toBe(true);
    expect(isReservedUnresolvableHostname("example.com.")).toBe(false);
  });

  test("a 100k run of the trimmed character finishes in under 50 ms", () => {
    const [out, ms] = timed(() => trimTrailing("a" + ",".repeat(100_000), 44));
    expect(out).toBe("a");
    expect(ms).toBeLessThan(50);
  });
});
