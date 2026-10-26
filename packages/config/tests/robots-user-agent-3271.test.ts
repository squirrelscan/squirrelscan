// `[crawler] robots_user_agent` (squirrelscan/repo#3271): the robots.txt group
// token, apart from the user agent the requests send.

import { describe, expect, test } from "bun:test";

import { CrawlerConfigSchema } from "../src/schema";

describe("robots_user_agent", () => {
  test("defaults to SquirrelScan, the group respect_robots is documented to follow", () => {
    expect(CrawlerConfigSchema.parse({}).robots_user_agent).toBe("SquirrelScan");
  });

  test("takes another token, or empty for the user agent's own", () => {
    expect(CrawlerConfigSchema.parse({ robots_user_agent: "MyBot" }).robots_user_agent).toBe("MyBot");
    expect(CrawlerConfigSchema.parse({ robots_user_agent: "" }).robots_user_agent).toBe("");
  });
});
