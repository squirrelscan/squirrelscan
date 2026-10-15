// pub#812: a schemeless audit target on a local-only name defaults to http.
//
// `squirrel audit myapp.test` was audited as `https://myapp.test/`: the scheme
// default knew only localhost and private IPs. Laravel Valet and Herd serve
// `.test` sites over plain http unless the site is secured, and a `box.local`
// or `nas.lan` box usually does too, so the audit failed to connect. The
// default now follows the one local/private-network classifier.

import { describe, expect, test } from "bun:test";

import { parseUserUrl } from "../src/url";

function url(input: string): string {
  const result = parseUserUrl(input);
  if (!result.ok) throw new Error(result.error);
  return result.url;
}

describe("parseUserUrl scheme default for local-only names (pub#812)", () => {
  test("a schemeless .test, .local or .lan host defaults to http, as localhost does", () => {
    expect(url("myapp.test")).toBe("http://myapp.test/");
    expect(url("box.local")).toBe("http://box.local/");
    expect(url("nas.lan")).toBe("http://nas.lan/");
    expect(url("myapp.test:8080/docs")).toBe("http://myapp.test:8080/docs");
    expect(url("MyApp.Test")).toBe("http://myapp.test/");
    expect(url("router.home.arpa")).toBe("http://router.home.arpa/");
    expect(url("db.internal")).toBe("http://db.internal/");
    expect(url("localhost:3000")).toBe("http://localhost:3000/");
  });

  test("a schemeless public host still defaults to https", () => {
    expect(url("example.com")).toBe("https://example.com/");
    expect(url("testing.com")).toBe("https://testing.com/");
    expect(url("my.local.example.com")).toBe("https://my.local.example.com/");
    expect(url("lan.dev")).toBe("https://lan.dev/");
  });

  test("an explicit scheme is kept as given", () => {
    expect(url("https://myapp.test")).toBe("https://myapp.test/");
    expect(url("https://box.local/")).toBe("https://box.local/");
    expect(url("http://example.com")).toBe("http://example.com/");
  });
});
