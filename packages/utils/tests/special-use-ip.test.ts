// #1560: special-use IP literals are not public, whatever they embed. The wide question the policy callers ask, answered once.

import { describe, expect, test } from "bun:test";

import { isNonPublicAddress } from "../src/public-egress";
import { isNonPublicHostname, isNonPublicHostnameForPolicy } from "../src/non-public-host";
import { isSpecialUseIpLiteral, isSpecialUseIpv4, isSpecialUseIpv6 } from "../src/special-use-ip";

const SPECIAL_V6: Array<[string, string]> = [
  ["NAT64 for the metadata address", "64:ff9b::a9fe:a9fe"],
  ["NAT64 for loopback", "64:ff9b::7f00:1"],
  ["NAT64 for 10.1.2.3", "64:ff9b::a01:203"],
  ["NAT64 for 192.168.1.1", "64:ff9b::c0a8:101"],
  ["NAT64 for a public address", "64:ff9b::808:808"],
  ["NAT64 local-use /48", "64:ff9b:1::a9fe:a9fe"],
  ["6to4 for the metadata address", "2002:a9fe:a9fe::"],
  ["6to4 for loopback", "2002:7f00:1::"],
  ["6to4 for 10.1.2.3", "2002:a01:203::1"],
  ["6to4 for a public address", "2002:808:808::"],
  ["Teredo", "2001:0:4136:e378:8000:63bf:80ff:fffe"],
  ["Teredo prefix", "2001::1"],
  ["IETF protocol assignments", "2001:2::1"],
  ["IPv4-compatible loopback", "::7f00:1"],
  ["IPv4-compatible metadata", "::a9fe:a9fe"],
  ["IPv4-mapped metadata", "::ffff:a9fe:a9fe"],
  ["IPv4-mapped 10.1.2.3", "::ffff:a01:203"],
  ["IPv4-translated 10.1.2.3", "::ffff:0:a01:203"],
  ["site-local", "fec0::1"],
  ["documentation 2001:db8", "2001:db8::1"],
  ["documentation 3fff", "3fff::1"],
  ["documentation 3fff top of /20", "3fff:fff:ffff::1"],
  ["multicast", "ff02::1"],
  ["multicast global", "ff0e::1"],
  ["discard-only", "100::1"],
  ["ISATAP on a global prefix, loopback", "2a00:1450::5efe:7f00:1"],
  ["ISATAP on a global prefix, metadata", "2a00:1450::5efe:a9fe:a9fe"],
  ["ISATAP on a link-local prefix", "fe80::5efe:a9fe:a9fe"],
  ["ISATAP with the u bit", "2a00:1450::200:5efe:a9fe:a9fe"],
  ["unique-local", "fd00:ec2::254"],
  ["unspecified", "::"],
  ["loopback", "::1"],
];

const PUBLIC_V6 = ["2606:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "2620:fe::fe", "2001:1234::1", "2001:200::1", "3fff:1000::1", "::ffff:808:808", "2a00:1450::5efe:808:808"];

const SPECIAL_V4 = ["0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.0.1", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255"];
const PUBLIC_V4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "192.169.0.1", "192.0.1.1", "192.88.98.1", "198.17.0.1", "198.20.0.1", "198.51.99.1", "198.51.101.1", "203.0.112.1", "203.0.114.1", "100.63.255.255", "100.128.0.1", "223.255.255.255", "169.253.0.1", "169.255.0.1"];

describe("IPv6 special-use literals", () => {
  test.each(SPECIAL_V6)("%s (%s) is special-use", (_label, host) => {
    expect(isSpecialUseIpv6(host)).toBe(true);
    expect(isSpecialUseIpLiteral(host)).toBe(true);
  });
  test.each(PUBLIC_V6)("%s is public unicast", (host) => {
    expect(isSpecialUseIpv6(host)).toBe(false);
    expect(isNonPublicHostnameForPolicy(host)).toBe(false);
  });
  test("a name, an empty string and a malformed literal are not IP literals here", () => {
    for (const value of ["example.com", "", "localhost", "64:ff9b::g", "1:2:3:4:5:6:7:8:9", "::1::2", "[::1]"]) expect([value, isSpecialUseIpv6(value)]).toEqual([value, false]);
    expect(isSpecialUseIpLiteral("example.com")).toBe(false);
  });
  test("the spelling does not matter: expanded, upper case, dotted tail, a zone id", () => {
    for (const host of ["64:FF9B:0:0:0:0:A9FE:A9FE", "0064:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "::ffff:169.254.169.254", "fe80::1%eth0", "2002:0a00:0001:0:0:0:0:1", "2001:0DB8:0:0:0:0:0:1"]) {
      expect([host, isSpecialUseIpv6(host)]).toEqual([host, true]);
    }
  });
});

describe("IPv4 special-use literals", () => {
  test.each(SPECIAL_V4)("%s is special-use", (host) => {
    expect(isSpecialUseIpv4(host)).toBe(true);
    expect(isSpecialUseIpLiteral(host)).toBe(true);
  });
  test.each(PUBLIC_V4)("%s is public unicast", (host) => {
    expect(isSpecialUseIpv4(host)).toBe(false);
    expect(isNonPublicHostnameForPolicy(host)).toBe(false);
  });
  test("a non-dotted-quad is not an IPv4 literal here", () => {
    for (const value of ["1.2.3", "1.2.3.4.5", "256.1.1.1", "a.b.c.d", "", "10.0.0.-1"]) expect([value, isSpecialUseIpv4(value)]).toEqual([value, false]);
  });
});

describe("the policy classifier is the narrow one plus the special-use literals", () => {
  test("everything the narrow classifier calls non-public stays non-public", () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:a01:203", "box.local", "metadata.google.internal", "intranet", "router.home.arpa", ""]) {
      expect([host, isNonPublicHostname(host), isNonPublicHostnameForPolicy(host)]).toEqual([host, true, true]);
    }
  });

  test("the narrow classifier is unchanged: it does not name the special-use forms (it is the grant, not the policy)", () => {
    for (const host of ["64:ff9b::a00:1", "2002:a00:1::", "2001::1", "2001:db8::1", "fec0::1", "ff02::1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "224.0.0.1", "240.0.0.1"]) {
      expect([host, isNonPublicHostname(host)]).toEqual([host, false]);
      expect([host, isNonPublicHostnameForPolicy(host)]).toEqual([host, true]);
    }
  });

  test("a public name and a public literal stay public; a name that merely contains an address is a name", () => {
    for (const host of ["example.com", "www.squirrelscan.com", "8.8.8.8", "2606:4700::1111", "64-ff9b.example.com", "2002.example.com", "192-0-2-1.example.com"]) {
      expect([host, isNonPublicHostnameForPolicy(host)]).toEqual([host, false]);
    }
  });
});

// #1577: the connect-time egress classifier and the policy classifier agree on ISATAP literals.
const ISATAP: Array<[string, string, boolean]> = [
  ["ISATAP embedding 10.0.0.1", "::5efe:10.0.0.1", true],
  ["ISATAP embedding 10.0.0.1, hex tail", "::5efe:a00:1", true],
  ["ISATAP on a global prefix embedding 10.0.0.1", "2a00::5efe:a00:1", true],
  ["ISATAP with the u bit embedding 10.0.0.1", "2a00::200:5efe:a00:1", true],
  ["ISATAP embedding loopback", "2a00:1450::5efe:7f00:1", true],
  ["ISATAP embedding the metadata address", "fe80::5efe:a9fe:a9fe", true],
  ["ISATAP embedding 8.8.8.8", "::5efe:8.8.8.8", false],
  ["ISATAP on a global prefix embedding 8.8.8.8", "2a00:1450::5efe:808:808", false],
  ["ISATAP with the u bit embedding 8.8.8.8", "2a00::200:5efe:808:808", false],
];

describe("ISATAP literals: the egress classifier and the policy classifier agree", () => {
  test.each(ISATAP)("%s (%s)", (_label, host, nonPublic) => {
    expect(isNonPublicAddress(host)).toBe(nonPublic);
    expect(isNonPublicAddress(`[${host}]`)).toBe(nonPublic);
    expect(isSpecialUseIpv6(host)).toBe(nonPublic);
    expect(isNonPublicHostnameForPolicy(host)).toBe(nonPublic);
  });
});

// #1572: NAT64 and 6to4 with a PUBLIC embedded IPv4 are non-public for policy, by prefix; the egress guard answers by the embedded address, on purpose.
describe("translation prefixes with a public embedded IPv4", () => {
  test.each(["64:ff9b::808:808", "64:ff9b::8.8.8.8", "2002:808:808::1"])("%s: policy says non-public", (host) => {
    expect(isSpecialUseIpv6(host)).toBe(true);
    expect(isNonPublicHostnameForPolicy(host)).toBe(true);
  });
  test.each(["64:ff9b::808:808", "2002:808:808::1"])("%s: the egress guard judges the embedded address, so it differs from policy by design", (host) => {
    expect(isNonPublicAddress(host)).toBe(false);
    expect(isNonPublicAddress(host)).not.toBe(isNonPublicHostnameForPolicy(host));
  });
  test.each(["64:ff9b::a00:1", "2002:a00:1::1"])("%s: both layers refuse a private embedded IPv4", (host) => {
    expect(isNonPublicAddress(host)).toBe(true);
    expect(isNonPublicHostnameForPolicy(host)).toBe(true);
  });
});

// #1572: a colon that is not a valid IPv6 is non-public (fail closed). The narrow classifier, which backs a grant, is unchanged.
describe("a malformed IPv6 is non-public for policy", () => {
  test.each(["64:ff9b::g", "1:2:3:4:5:6:7:8:9", "::1::2", "2606:4700::1111::1", "abc:def", "1:2", "::ffff:1.2.3.999", "[::1]x:"])("%s", (host) => {
    expect(isNonPublicHostnameForPolicy(host)).toBe(true);
    expect(isNonPublicHostname(host)).toBe(false);
  });
  test("valid IPv6 literals are unaffected", () => {
    for (const host of ["2606:4700::1111", "2a00:1450::5efe:808:808", "::ffff:808:808", "fe80::1%eth0"]) {
      expect([host, isNonPublicHostnameForPolicy(host)]).toEqual([host, host.startsWith("fe80")]);
    }
  });
});
