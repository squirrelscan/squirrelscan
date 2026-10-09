// The entity `page` filter rule, and the table every surface's tests share.

import { describe, expect, test } from "bun:test";

import {
  ENTITY_PAGE_MATCH_CASES,
  entityPageMatchMode,
  matchesEntityPage,
} from "../src/entity-page-match";

describe("matchesEntityPage", () => {
  test.each(ENTITY_PAGE_MATCH_CASES)(
    "$pattern against $url matches: $matches",
    ({ pattern, url, matches }) => {
      expect(matchesEntityPage(url, pattern)).toBe(matches);
    }
  );
});

describe("entityPageMatchMode", () => {
  test("an absolute http(s) URL is a URL prefix", () => {
    expect(entityPageMatchMode("https://example.com/blog")).toBe("prefix-url");
    expect(entityPageMatchMode("http://example.com")).toBe("prefix-url");
  });

  test("a leading slash is a path prefix", () => {
    expect(entityPageMatchMode("/blog")).toBe("prefix-path");
  });

  test("anything else is a substring, including a host:port that parses as a URL", () => {
    expect(entityPageMatchMode("blog")).toBe("substring");
    expect(entityPageMatchMode("localhost:3000/blog")).toBe("substring");
    expect(entityPageMatchMode("example.com/blog")).toBe("substring");
  });
});
