import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { countryName, GEOIP_ATTRIBUTION, lookupCountry } from "../src/geoip";
import snapshot from "../geoip-db/SNAPSHOT.json";

describe("lookupCountry", () => {
  test("resolves well-known IPv4 addresses", async () => {
    expect(await lookupCountry("1.0.0.1")).toBe("AU");
    expect(await lookupCountry("8.8.8.8")).toBe("US");
  });
  test("resolves IPv6 and IPv4-mapped IPv6", async () => {
    expect(await lookupCountry("2001:4860:1c00::1")).toBe("US");
    expect(await lookupCountry("::ffff:8.8.8.8")).toBe("US");
  });
  test("returns null, never a guess, for private, unspecified and invalid input", async () => {
    expect(await lookupCountry("10.0.0.1")).toBeNull();
    expect(await lookupCountry("127.0.0.1")).toBeNull();
    expect(await lookupCountry("not-an-ip")).toBeNull();
    expect(await lookupCountry("")).toBeNull();
  });
  test("names and attribution", () => {
    expect(countryName("AU")).toBe("Australia");
    expect(GEOIP_ATTRIBUTION).toContain("DB-IP.com");
  });
});

describe("shipped GeoIP database", () => {
  test("matches the size and sha256 recorded in SNAPSHOT.json", async () => {
    const bytes = new Uint8Array(await Bun.file(new URL("../geoip-db/country.bin.gz", import.meta.url)).arrayBuffer());
    expect(bytes.byteLength).toBe(snapshot.compiledBytes);
    expect(snapshot.compiledBytes).toBe(2296108);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(snapshot.compiledSha256);
  });
});

describe("IPv6 text parsing (CodeQL js/polynomial-redos on the IPv4-tail regex)", () => {
  test("an embedded IPv4 tail still parses", async () => {
    const { parseV6 } = await import("../src/geoip/ip");
    const mapped = parseV6("::ffff:192.0.2.1");
    expect(mapped && [...mapped.slice(10)]).toEqual([0xff, 0xff, 192, 0, 2, 1]);
    expect(parseV6("::ffff:300.0.2.1")).toBeNull();
  });

  test("a long run of zeros returns null at once instead of backtracking", async () => {
    const { parseV6 } = await import("../src/geoip/ip");
    const started = performance.now();
    expect(parseV6("0".repeat(50_000) + "x")).toBeNull();
    expect(parseV6(`${"0.".repeat(20_000)}0`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });
});
