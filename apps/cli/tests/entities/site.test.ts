// The entity map's `site` comes from the crawl, for every producer (#492).
//
// `squirrel audit`, `squirrel analyze` and the map `squirrel entities` reads
// back from the store all name the site through `entityMapSite`, so they agree.
// The audit used to pass its own invocation URL and the other two the crawl's
// origin, and a `--resume` of an audit begun on another path of the site would
// have split them again.

import { describe, expect, test } from "bun:test";

import { entityMapSite } from "@/audit/entity-map";

describe("entityMapSite", () => {
  test("is the URL the audit was run on", () => {
    expect(
      entityMapSite({
        baseUrl: "https://shop.test",
        originalUrl: "https://shop.test/blog/",
      })
    ).toBe("https://shop.test/blog/");
  });

  test("falls back to the origin for a crawl that did not record it", () => {
    expect(entityMapSite({ baseUrl: "https://shop.test" })).toBe(
      "https://shop.test"
    );
    expect(
      entityMapSite({ baseUrl: "https://shop.test", originalUrl: "" })
    ).toBe("https://shop.test");
  });
});
