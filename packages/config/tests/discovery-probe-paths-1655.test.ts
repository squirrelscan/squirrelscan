// `[crawler] discovery_probe_paths` names probe paths exactly as written (#1655).

import { describe, expect, test } from "bun:test";

import { CrawlerConfigSchema } from "../src/schema";

const parse = (paths: string[]) => CrawlerConfigSchema.safeParse({ discovery_probe_paths: paths });

describe("discovery_probe_paths", () => {
  test("unset stays unset: today's behaviour", () => {
    const parsed = CrawlerConfigSchema.parse({});
    expect(parsed.discovery_probe_paths).toBeUndefined();
  });

  test.each(["/llms.txt", "/llms-full.txt", "/AGENTS.md", "/.well-known/mcp.json"])(
    "accepts %s",
    (path) => {
      expect(parse([path]).success).toBe(true);
    },
  );

  test.each([
    "llms.txt",
    "/unknown.txt",
    "https://example.com/llms.txt",
    "/llms.txt?x=1",
    "/LLMS.txt",
    "",
  ])("rejects %p", (path) => {
    expect(parse([path]).success).toBe(false);
  });
});
