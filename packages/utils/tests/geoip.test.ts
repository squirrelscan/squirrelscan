import { describe, expect, test } from "bun:test";

import { countryName, GEOIP_ATTRIBUTION, lookupCountry } from "../src/geoip";

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
