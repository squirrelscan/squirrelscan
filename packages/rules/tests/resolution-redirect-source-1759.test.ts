import { describe, expect, test } from "bun:test";

import { buildPublishResolution } from "../src/resolution";

describe("the publish resolution names a followed redirect by its source URL (#1759)", () => {
  test("a redirect row is a crawled page and its status is the 3xx, so a seeded redirect is not a skipped page", () => {
    const out = buildPublishResolution({}, [
      { url: "https://a.test/old", statusCode: 301 },
      { url: "https://a.test/gone", statusCode: 410 },
      { url: "https://a.test/live", statusCode: 200 },
    ]);
    expect(out.pageStatuses).toEqual([
      { url: "https://a.test/old", status: 301 },
      { url: "https://a.test/gone", status: 410 },
    ]);
  });
});
