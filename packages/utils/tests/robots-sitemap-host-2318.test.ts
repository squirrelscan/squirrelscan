import { describe, expect, test } from "bun:test";

import { resolveRobotsSitemapUrl } from "../src/robots-txt";

const BASE = "https://site.test/deep/page";

describe("robots.txt Sitemap host reading needs a public suffix (repo#2318)", () => {
  test.each([
    ["sitemap.xml/news", "https://site.test/sitemap.xml/news"],
    ["sitemap.php/posts", "https://site.test/sitemap.php/posts"],
    ["index.php/sitemap", "https://site.test/index.php/sitemap"],
  ])("%s stays a path on the audited origin", (value, expected) => {
    const r = resolveRobotsSitemapUrl(value, BASE);
    expect(r.reading).toBe("relative");
    expect(r.url).toBe(expected);
  });

  test.each([
    ["worldairops.com/sitemap.xml", "https://worldairops.com/sitemap.xml"],
    ["example.co.uk/s.xml", "https://example.co.uk/s.xml"],
    ["example.com:8080/s.xml", "https://example.com:8080/s.xml"],
  ])("%s is still read as a host", (value, expected) => {
    const r = resolveRobotsSitemapUrl(value, BASE);
    expect(r.reading).toBe("scheme-less-host");
    expect(r.url).toBe(expected);
  });

  test("a filename whose extension is a real TLD is still read as a host (documented edge)", () => {
    expect(resolveRobotsSitemapUrl("sitemap.pl/x", BASE).reading).toBe("scheme-less-host");
  });
});
