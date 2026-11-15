// a11y/link-text and redirected pages (repo#3366): the crawler parses a page against its final
// URL, so the rule must resolve relative hrefs against the same URL to find each link's section.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { linkTextRule } from "../src/a11y/link-text";
import type { CheckResult, ParsedPage, RuleContext } from "../src/types";

const BODY =
  '<main><a href="/docs">Read more</a></main><footer><a href="/terms">Click here</a></footer>';

async function run(requested: string, finalUrl?: string): Promise<CheckResult[]> {
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body>${BODY}</body></html>`;
  const ctx = {
    page: {
      url: requested,
      ...(finalUrl ? { finalUrl } : {}),
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: parsePage(html, finalUrl ?? requested) as ParsedPage,
    options: {},
  } as unknown as RuleContext;
  return (await linkTextRule.run(ctx)).checks as CheckResult[];
}

const sections = (checks: CheckResult[]) =>
  JSON.stringify(checks.find((c) => c.name === "link-text-generic")?.items);

describe("a11y/link-text on a redirected page", () => {
  test("a relative footer link keeps the section the crawler assigned", async () => {
    const plain = await run("https://example.com/");
    const redirected = await run("https://old.example.org/start", "https://example.com/");
    expect(sections(plain)).toContain("footer");
    expect(sections(redirected)).toBe(sections(plain));
  });

  test("a page that did not redirect behaves as before", async () => {
    const same = await run("https://example.com/", "https://example.com/");
    expect(sections(same)).toBe(sections(await run("https://example.com/")));
  });
});
