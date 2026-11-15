// squirrelscan/repo#3390: the site data handed to rules carries the robots.txt
// group token the crawl was matched as, so security/graphql-probe reads the same
// group as the crawl (`robots_user_agent`, default `SquirrelScan`), not `*`.

import { describe, expect, test } from "bun:test";

import type { Config } from "@squirrelscan/config";

import { crawlRobotsUserAgent } from "../src/adapter";

const cfg = (crawler: Record<string, unknown>) => ({ crawler }) as unknown as Config;
const row = (config: Record<string, unknown>) => ({ config });

describe("crawlRobotsUserAgent (#3390)", () => {
  test("a crawl row's robotsUserAgent decides, whatever this run's config says", () => {
    expect(
      crawlRobotsUserAgent(
        row({ userAgent: "Mozilla/5.0", robotsUserAgent: "SquirrelScan", respectRobots: true }),
        cfg({ robots_user_agent: "OtherBot" }),
      ),
    ).toBe("SquirrelScan");
  });

  test("a row with no token was matched on its user agent's product token", () => {
    expect(
      crawlRobotsUserAgent(
        row({
          userAgent: "MyBot/1.0 (+https://example.test)",
          robotsUserAgent: "",
          respectRobots: true,
        }),
        cfg({ robots_user_agent: "SquirrelScan" }),
      ),
    ).toBe("MyBot");
    expect(
      crawlRobotsUserAgent(row({ userAgent: "MyBot/2.0", respectRobots: true }), cfg({})),
    ).toBe("MyBot");
  });

  test("without a row, this run's config names the token (default SquirrelScan)", () => {
    expect(crawlRobotsUserAgent(null, cfg({ robots_user_agent: "SquirrelScan" }))).toBe(
      "SquirrelScan",
    );
    expect(
      crawlRobotsUserAgent(undefined, cfg({ robots_user_agent: "", user_agent: "Acme/3" })),
    ).toBe("Acme");
  });

  test("undefined when the crawl did not respect robots.txt, so rules read *", () => {
    expect(
      crawlRobotsUserAgent(
        row({ userAgent: "x", robotsUserAgent: "SquirrelScan", respectRobots: false }),
        cfg({ respect_robots: true }),
      ),
    ).toBeUndefined();
    expect(crawlRobotsUserAgent(null, cfg({ respect_robots: false }))).toBeUndefined();
  });
});
