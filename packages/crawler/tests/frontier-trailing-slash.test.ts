// The frontier's normalized URL is the URL the crawler actually FETCHES, so
// stripping a trailing slash from it made the crawler request `/about` on a site
// that only ever links `/about/`. The origin answered 301, and the report blamed
// the site for a redirect it had never been asked to serve (#1510).

import { describe, expect, test } from "bun:test";

import { normalizeUrl } from "../src/frontier";

const opts = { baseUrl: "https://example.com/", allowQueryParams: [] as string[] };

describe("frontier normalizeUrl — trailing slash", () => {
  test("a linked trailing slash survives normalization", () => {
    expect(normalizeUrl("https://example.com/o-mnie/", opts)).toBe("https://example.com/o-mnie/");
  });

  test("a linked no-slash URL is not given one", () => {
    expect(normalizeUrl("https://example.com/o-mnie", opts)).toBe("https://example.com/o-mnie");
  });

  test("the two forms stay distinct — they are distinct resources on the wire", () => {
    expect(normalizeUrl("https://example.com/a/", opts)).not.toBe(
      normalizeUrl("https://example.com/a", opts),
    );
  });

  test("relative hrefs resolve with their slash intact", () => {
    expect(normalizeUrl("/blog/", opts)).toBe("https://example.com/blog/");
    expect(normalizeUrl("blog/", { ...opts, baseUrl: "https://example.com/x/" })).toBe(
      "https://example.com/x/blog/",
    );
  });

  test("the root path keeps its slash", () => {
    expect(normalizeUrl("https://example.com", opts)).toBe("https://example.com/");
  });

  test("everything else still normalizes", () => {
    expect(normalizeUrl("HTTPS://EXAMPLE.COM:443/A/?utm_source=x#frag", opts)).toBe(
      "https://example.com/A/",
    );
  });
});
