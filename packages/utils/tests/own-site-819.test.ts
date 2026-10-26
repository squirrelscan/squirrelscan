// squirrelscan/squirrelscan#819: one definition of "the audited site's own
// hosts" for an offline audit: the host, its www or apex twin, the project
// domains (and their twins) and the subdomains of all of them.

import { describe, expect, test } from "bun:test";

import { ownSiteHostMatcher, ownSiteUrlMatcher } from "../src/own-site";

describe("ownSiteHostMatcher", () => {
  const own = ownSiteHostMatcher({
    baseUrl: "https://www.example.com/pricing",
    domains: ["shop.example.net", "https://brand.example.org/", "Docs.Example.Dev"],
  });

  test.each([
    "www.example.com",
    "example.com",
    "WWW.EXAMPLE.COM",
    "cdn.example.com",
    "a.b.example.com",
    "shop.example.net",
    "www.shop.example.net",
    "assets.shop.example.net",
    "brand.example.org",
    "docs.example.dev",
    "example.com.",
  ])("%s is the site's own", (host) => {
    expect(own(host)).toBe(true);
  });

  test.each([
    "example.org",
    "notexample.com",
    "example.com.evil.test",
    "evil-example.com",
    "example.net",
    "localhost",
    "",
  ])("%s is not", (host) => {
    expect(own(host)).toBe(false);
  });

  test("a project domain written with a port, a wildcard or in Unicode still means that host", () => {
    const matcher = ownSiteHostMatcher({
      baseUrl: "https://example.com/",
      domains: ["shop.example.net:8443", "*.cdn.example.org", ".static.example.dev", "bücher.example"],
    });
    expect(matcher("shop.example.net")).toBe(true);
    expect(matcher("x.cdn.example.org")).toBe(true);
    expect(matcher("cdn.example.org")).toBe(true);
    expect(matcher("static.example.dev")).toBe(true);
    expect(matcher("xn--bcher-kva.example")).toBe(true);
    expect(matcher("other.example")).toBe(false);
  });

  test("an apex base host counts its www twin", () => {
    const apex = ownSiteHostMatcher({ baseUrl: "https://example.com/" });
    expect(apex("www.example.com")).toBe(true);
    expect(apex("example.com")).toBe(true);
    expect(apex("example.org")).toBe(false);
  });

  test("an IP literal or a single-label host has no twin", () => {
    const ip = ownSiteHostMatcher({ baseUrl: "http://127.0.0.1:8080/" });
    expect(ip("127.0.0.1")).toBe(true);
    expect(ip("www.127.0.0.1")).toBe(false);
    expect(ip("localhost")).toBe(false);
    const v6 = ownSiteHostMatcher({ baseUrl: "http://[::1]:8080/" });
    expect(v6("::1")).toBe(true);
    expect(v6("[::1]")).toBe(true);
    const lan = ownSiteHostMatcher({ baseUrl: "http://printer/" });
    expect(lan("printer")).toBe(true);
    // A single label has no twin, but its subdomains are still the site's.
    expect(lan("scanner.printer")).toBe(true);
    expect(lan("scanner")).toBe(false);
  });

  test("an unparseable base address matches nothing", () => {
    const none = ownSiteHostMatcher({ baseUrl: "not a url" });
    expect(none("example.com")).toBe(false);
  });
});

describe("ownSiteUrlMatcher", () => {
  const own = ownSiteUrlMatcher({ baseUrl: "https://example.com/" });
  test("reads the host of a URL", () => {
    expect(own("https://cdn.example.com/a.css")).toBe(true);
    expect(own("https://example.org/a.css")).toBe(false);
    expect(own("not a url")).toBe(false);
  });
});
