// Which URLs robots.txt allows, as the crawl decides it. Moved from the CLI's
// robots copy (#756), whose own matcher the crawl no longer ran, to the
// crawler's evaluator.

import { describe, expect, test } from "bun:test";

import { createRobotsEvaluator } from "../src/robots";

const ROBOTS_URL = "https://example.com/robots.txt";

const allowed = (content: string | null, url: string, userAgent = "*") =>
  createRobotsEvaluator(ROBOTS_URL, content, userAgent).isAllowed(url);

describe("createRobotsEvaluator().isAllowed", () => {
  test("allows everything when there is no robots.txt or no rule", () => {
    expect(allowed(null, "https://example.com/anything")).toBe(true);
    expect(allowed("", "https://example.com/page")).toBe(true);
  });

  test("blocks a disallowed path and allows the rest", () => {
    const robots = "User-agent: *\nDisallow: /private";
    expect(allowed(robots, "https://example.com/private/page")).toBe(false);
    expect(allowed(robots, "https://example.com/public")).toBe(true);
  });

  test("an allow rule allows its path", () => {
    expect(allowed("User-agent: *\nAllow: /allowed", "https://example.com/allowed/page")).toBe(true);
  });

  test("a group for a named agent applies to it, the wildcard group to the others", () => {
    const robots = [
      "User-agent: Googlebot",
      "Disallow: /google-blocked",
      "",
      "User-agent: *",
      "Disallow: /all-blocked",
    ].join("\n");
    expect(allowed(robots, "https://example.com/google-blocked", "Googlebot/2.1")).toBe(false);
    expect(allowed(robots, "https://example.com/google-blocked", "Bingbot")).toBe(true);
    expect(allowed(robots, "https://example.com/all-blocked", "Bingbot")).toBe(false);
  });

  test("a root disallow blocks every path", () => {
    const robots = "User-agent: *\nDisallow: /";
    expect(allowed(robots, "https://example.com/anything")).toBe(false);
    expect(allowed(robots, "https://example.com/")).toBe(false);
  });
});
