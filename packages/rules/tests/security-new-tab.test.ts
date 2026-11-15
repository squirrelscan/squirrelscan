// security/new-tab: implicit noopener, noreferrer implies noopener, rel tokens.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { newTabRule } from "../src/security/new-tab";
import type { ParsedPage, RuleContext } from "../src/types";

async function run(links: string): Promise<CheckResult[]> {
  const url = "https://example.com/";
  const html = `<html><body>${links}</body></html>`;
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  return (await newTabRule.run(ctx)).checks as CheckResult[];
}

const a = (rel: string | null) =>
  `<a href="https://other.example/x" target="_blank"${rel === null ? "" : ` rel="${rel}"`}>x</a>`;
const noopener = (c: CheckResult[]) => c.find((x) => x.name === "noopener");
const noreferrer = (c: CheckResult[]) => c.find((x) => x.name === "noreferrer");

describe("security/new-tab", () => {
  test("absent rel is implicitly isolated: no security warning", async () => {
    expect(noopener(await run(a(null)))?.status).toBe("pass");
  });
  test("noreferrer alone does not warn about opener isolation", async () => {
    const c = await run(a("noreferrer"));
    expect(noopener(c)?.status).toBe("pass");
    expect(noreferrer(c)?.status).toBe("pass");
  });
  test("noopener passes", async () => {
    expect(noopener(await run(a("noopener")))?.status).toBe("pass");
  });
  test("explicit opener warns", async () => {
    const c = await run(a("opener"));
    expect(noopener(c)?.status).toBe("warn");
    expect(noopener(c)?.items?.length).toBe(1);
  });
  test("opener with noopener or noreferrer is isolated", async () => {
    expect(noopener(await run(a("opener noopener")))?.status).toBe("pass");
    expect(noopener(await run(a("opener noreferrer")))?.status).toBe("pass");
  });
  test("mixed case and extra whitespace are tokenised", async () => {
    expect(noopener(await run(a("  NoOpener\n NoReferrer ")))?.status).toBe("pass");
    expect(noopener(await run(a("OPENER")))?.status).toBe("warn");
  });
  test("misleading substrings are not tokens", async () => {
    const c = await run(a("noopenerx xnoreferrer opener-not"));
    expect(noopener(c)?.status).toBe("pass");
    expect(noreferrer(c)?.status).toBe("info");
    expect(noopener(await run(a("noopenerx opener")))?.status).toBe("warn");
  });
  test("missing noreferrer is info (privacy), never warn", async () => {
    expect(noreferrer(await run(a("noopener")))?.status).toBe("info");
    expect(noreferrer(await run(a(null)))?.status).toBe("info");
  });
});
