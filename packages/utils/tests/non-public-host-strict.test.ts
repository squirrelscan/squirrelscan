// `isNonPublicHostnameStrict`: the shared classifier plus the special-use ranges a batch or hosted caller must refuse (#1231 review).
// Hosts go through the WHATWG URL parser first, as every caller's do, so the spellings below arrive canonicalised.
import { describe, expect, test } from "bun:test";

import { isNonPublicHostname, isNonPublicHostnameStrict } from "../src/non-public-host";

const host = (literal: string): string => new URL(`http://${literal}/`).hostname.replace(/^\[|\]$/g, "");

describe("IPv4 special-use ranges", () => {
  test.each([
    "192.0.0.1",
    "192.0.0.255",
    "192.0.2.1",
    "198.18.0.1",
    "198.19.255.254",
    "198.51.100.7",
    "203.0.113.9",
    "192.88.99.1",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.254",
    "255.255.255.255",
    "4294967295",
    "0xffffffff",
  ])("%s is refused", (literal) => {
    expect(isNonPublicHostnameStrict(host(literal))).toBe(true);
  });

  test.each(["8.8.8.8", "192.0.1.1", "192.0.3.1", "192.88.98.1", "192.88.100.1", "198.17.255.255", "198.20.0.1", "198.51.99.1", "198.51.101.1", "203.0.112.1", "203.0.114.1", "223.255.255.255", "1.1.1.1"])(
    "%s is still public",
    (literal) => {
      expect(isNonPublicHostnameStrict(host(literal))).toBe(false);
    },
  );
});

describe("IPv6 special-use and embedded-IPv4 forms", () => {
  test.each([
    "[64:ff9b::7f00:1]", // NAT64 around loopback
    "[64:ff9b::a9fe:a9fe]", // NAT64 around the metadata address
    "[64:ff9b::a00:1]", // NAT64 around 10.0.0.1
    "[64:ff9b::c000:201]", // NAT64 around a documentation address
    "[64:ff9b::127.0.0.1]",
    "[64:ff9b:1::1]", // local-use NAT64 /48
    "[64:ff9b:1:ffff::1]",
    "[2002:7f00:1::]", // 6to4 around loopback
    "[2002:a9fe:a9fe::]", // 6to4 around the metadata address
    "[2002:c0a8:101::1]", // 6to4 around 192.168.1.1
    "[2001::1]", // Teredo
    "[2001:0:4136:e378:8000:63bf:3fff:fdd2]",
    "[::127.0.0.1]", // IPv4-compatible
    "[::2]",
    "[::a00:1]",
    "[fec0::1]", // site-local
    "[feff::1]",
    "[2001:db8::1]", // documentation
    "[2001:db8:ffff::1]",
    "[3fff::1]", // documentation 3fff::/20
    "[3fff:fff::1]",
    "[2a00:1450::5efe:7f00:1]", // ISATAP around loopback, under a global prefix
    "[2a00:1450::200:5efe:7f00:1]",
    "[2a00:1450::5efe:a00:1]",
    "[2001:2::1]", // benchmarking 2001:2::/48
    "[2001:2:0:ffff::1]",
    "[2001:10::1]", // ORCHID 2001:10::/28
    "[2001:1f::1]",
    "[2001:20::1]", // ORCHIDv2 2001:20::/28
    "[2001:2f::1]",
    "[5f00::1]", // SRv6 5f00::/16
    "[5f00:ffff::]",
    "[ff02::1]", // multicast
    "[ff00::]",
    "[100::1]", // discard
    "[::ffff:192.0.2.1]", // mapped documentation
    "[::ffff:0:198.18.0.1]", // translated benchmarking
  ])("%s is refused", (literal) => {
    expect(isNonPublicHostnameStrict(host(literal))).toBe(true);
  });

  test.each([
    "[2606:4700::1111]",
    "[2001:4860:4860::8888]",
    "[64:ff9b::808:808]", // NAT64 around a public address
    "[2002:808:808::]", // 6to4 around a public address
    "[2001:1::1]", // not Teredo
    "[2001:db9::1]", // not documentation
    "[2001:200::1]",
    "[100:0:0:1::1]", // not the /64 discard prefix
    "[64:ff9b:2::1]", // not the local-use /48
    "[2400:cb00::1]",
    "[3ff0::1]", // below the /20: not documentation
    "[3ffe::1]",
    "[3fff:1000::1]",
    "[2a00:1450::5efe:808:808]", // ISATAP around a public address
    "[2001:2:1::1]", // outside 2001:2::/48
    "[2001:30::1]",
    "[2001:0f::1]",
    "[5eff::1]",
    "[5f01::1]",
    "[::ffff:8.8.8.8]",
  ])("%s is still public", (literal) => {
    expect(isNonPublicHostnameStrict(host(literal))).toBe(false);
  });
});

describe("what it keeps and what it leaves alone", () => {
  test("everything the shared classifier refuses is refused", () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "box.local", "intranet", "100.64.0.1", ""]) {
      expect(isNonPublicHostname(h)).toBe(true);
      expect(isNonPublicHostnameStrict(h)).toBe(true);
    }
  });
  test("the shared classifier is unchanged for the special-use ranges", () => {
    for (const h of ["203.0.113.9", "198.18.0.1", "64:ff9b::7f00:1", "2001:db8::1", "ff02::1"]) expect(isNonPublicHostname(h)).toBe(false);
  });
  test("malformed octets and groups handed to the function directly are not addresses", () => {
    for (const h of ["999.999.999.999", "1.2.3.256", "300.0.2.1", "224.0.0.256", "1.2.3", "2001:db8", "1:2:3:4:5:6:7:8:9", "1::2::3", "g::1", "::fffff", ":::", "1:2:3:4:5:6:7::8", "2001:db8:0:0:0:0:0::1", "12345::1", "1.2.3.4:5"]) {
      expect(isNonPublicHostnameStrict(h), h).toBe(false);
    }
  });
  test("names and malformed groups are not read as addresses", () => {
    expect(isNonPublicHostnameStrict("example.com")).toBe(false);
    expect(isNonPublicHostnameStrict("a:b:c")).toBe(false);
    expect(isNonPublicHostnameStrict("1:2:3:4:5:6:7:8:9")).toBe(false);
    expect(isNonPublicHostnameStrict("1::2::3")).toBe(false);
  });
});
