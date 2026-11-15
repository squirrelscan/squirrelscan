// squirrelscan/repo#3390: the group token a configured agent is matched as, the
// way the crawler's robots parser reads it, so a rule reads the crawl's group.

import { describe, expect, test } from "bun:test";

import { isRobotsTxtDisallowed, parseRobotsTxt, robotsGroupToken } from "../src/robots-txt";

describe("robotsGroupToken (#3390)", () => {
  test("keeps the text before the first slash, trimmed", () => {
    expect(robotsGroupToken("SquirrelScan")).toBe("SquirrelScan");
    expect(robotsGroupToken("SquirrelScan/1.0")).toBe("SquirrelScan");
    expect(robotsGroupToken(" MyBot /2.0 (+https://example.test)")).toBe("MyBot");
    expect(robotsGroupToken("Mozilla/5.0 (compatible; SquirrelScan/2.0)")).toBe("Mozilla");
    expect(robotsGroupToken("")).toBe("");
    expect(robotsGroupToken("/1.0")).toBe("");
  });

  test("the token selects its own group in isRobotsTxtDisallowed", () => {
    const robots = parseRobotsTxt(
      "User-agent: SquirrelScan\nDisallow: /graphql\n\nUser-agent: *\nAllow: /\n",
      "https://example.com/robots.txt",
    );
    const url = "https://example.com/graphql";
    expect(isRobotsTxtDisallowed(url, robots, robotsGroupToken("SquirrelScan/1.0"))).toBe(true);
    expect(isRobotsTxtDisallowed(url, robots, "*")).toBe(false);
  });
});
