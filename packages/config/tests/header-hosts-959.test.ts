// `[crawler] header_hosts` names hosts that also get the custom request headers,
// so an entry must be a bare host name (#959).

import { describe, expect, test } from "bun:test";

import { CrawlerConfigSchema } from "../src/schema";

const parse = (header_hosts: string[]) => CrawlerConfigSchema.safeParse({ header_hosts });

describe("header_hosts entries", () => {
  test.each([
    "assets.example.com",
    "Assets.Example.com",
    "https://cdn.example.com",
    "http://plain.example.net",
    "cdn.example.com:8443",
    "localhost",
    "[::1]",
    "127.0.0.1",
    "https://cdn.example.com/",
    "https://cdn.example.com/x",
    "cdn.example.com/",
    "bücher.de",
    "https://bücher.de/assets",
  ])("accepts %s", (entry) => {
    expect(parse([entry]).success).toBe(true);
  });

  test.each([
    "*.example.com",
    "user@example.com",
    "https://user:pw@example.com",
    "example.com.",
    "a..example.com",
    "ftp://example.com",
    " ",
  ])("rejects %s", (entry) => {
    expect(parse([entry]).success).toBe(false);
  });
});
