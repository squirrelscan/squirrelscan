// `[crawler] agent_access_all_tokens` (squirrelscan/repo#3788): opt-in, unset by default.

import { describe, expect, test } from "bun:test";

import { CrawlerConfigSchema } from "../src/schema";

describe("agent_access_all_tokens", () => {
  test("unset stays unset: the default probe set", () => {
    expect(CrawlerConfigSchema.parse({}).agent_access_all_tokens).toBeUndefined();
  });

  test("parses true and false, rejects other types", () => {
    expect(CrawlerConfigSchema.parse({ agent_access_all_tokens: true }).agent_access_all_tokens).toBe(true);
    expect(CrawlerConfigSchema.parse({ agent_access_all_tokens: false }).agent_access_all_tokens).toBe(false);
    expect(CrawlerConfigSchema.safeParse({ agent_access_all_tokens: "yes" }).success).toBe(false);
  });
});
