// ax/ai-crawlers — AI-agent crawler allow/block reporting + three-class
// taxonomy (training / ai-search / user-action) (#357).

import { describe, expect, test } from "bun:test";

import type { CheckResult, RobotsTxtData } from "@squirrelscan/core-contracts";

import { aiCrawlersRule, evaluateAiCrawlers, AI_CRAWLERS } from "../src/ax/ai-crawlers";
import type { ParsedPage, RuleContext } from "../src/types";

type Group = RobotsTxtData["rules"][number];

function robots(rules: Group[]): RobotsTxtData {
  return {
    exists: true,
    url: "https://example.com/robots.txt",
    content: "",
    sizeBytes: 0,
    sitemaps: [],
    rules,
    errors: [],
  };
}

function ctx(robotsTxt: RobotsTxtData | null): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt, sitemaps: null },
    options: {},
  };
}

function run(robotsTxt: RobotsTxtData | null): CheckResult[] {
  return aiCrawlersRule.run(ctx(robotsTxt)).checks;
}

const blockAll = () => robots([{ userAgent: "*", rules: [{ type: "disallow", path: "/" }] }]);

describe("ax/ai-crawlers", () => {
  test("treats a missing robots.txt as all-allowed", () => {
    const checks = run(null);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("all AI crawlers are allowed");
  });

  test("a robots.txt with no relevant rules allows every AI crawler", () => {
    const verdicts = evaluateAiCrawlers(robots([]));
    expect(verdicts.every((v) => !v.blocked)).toBe(true);
    const summary = run(robots([]))[0];
    expect(summary?.message).toContain(
      `${AI_CRAWLERS.length}/${AI_CRAWLERS.length} known AI crawlers allowed`,
    );
  });

  test("Disallow: / on a named UA blocks only that crawler", () => {
    const verdicts = evaluateAiCrawlers(
      robots([{ userAgent: "GPTBot", rules: [{ type: "disallow", path: "/" }] }]),
    );
    const gpt = verdicts.find((v) => v.token === "GPTBot");
    expect(gpt?.blocked).toBe(true);
    expect(gpt?.explicitlyListed).toBe(true);
    // A different bot is unaffected.
    expect(verdicts.find((v) => v.token === "ClaudeBot")?.blocked).toBe(false);
  });

  test("a wildcard Disallow: / blocks every AI crawler not given its own group", () => {
    const verdicts = evaluateAiCrawlers(blockAll());
    expect(verdicts.every((v) => v.blocked)).toBe(true);
    expect(verdicts.every((v) => !v.explicitlyListed)).toBe(true);
  });

  test("a UA-specific group overrides the wildcard block", () => {
    const verdicts = evaluateAiCrawlers(
      robots([
        { userAgent: "*", rules: [{ type: "disallow", path: "/" }] },
        { userAgent: "ClaudeBot", rules: [{ type: "allow", path: "/" }] },
      ]),
    );
    expect(verdicts.find((v) => v.token === "ClaudeBot")?.blocked).toBe(false);
    expect(verdicts.find((v) => v.token === "GPTBot")?.blocked).toBe(true);
  });

  test("matches UA tokens case-insensitively", () => {
    const verdicts = evaluateAiCrawlers(
      robots([{ userAgent: "gptbot", rules: [{ type: "disallow", path: "/" }] }]),
    );
    expect(verdicts.find((v) => v.token === "GPTBot")?.blocked).toBe(true);
  });

  test("Disallow of a sub-path is not a full block", () => {
    const verdicts = evaluateAiCrawlers(
      robots([{ userAgent: "*", rules: [{ type: "disallow", path: "/private" }] }]),
    );
    expect(verdicts.every((v) => !v.blocked)).toBe(true);
  });

  // --- four-class taxonomy ---

  test("every crawler carries a valid class, matching the documented taxonomy", () => {
    const byToken = Object.fromEntries(AI_CRAWLERS.map((c) => [c.token, c.crawlerClass]));
    expect(byToken["GPTBot"]).toBe("training");
    expect(byToken["ClaudeBot"]).toBe("training");
    expect(byToken["Amazonbot"]).toBe("training");
    expect(byToken["OAI-SearchBot"]).toBe("ai-search");
    expect(byToken["PerplexityBot"]).toBe("ai-search");
    expect(byToken["DuckAssistBot"]).toBe("ai-search");
    expect(byToken["ChatGPT-User"]).toBe("user-action");
    expect(byToken["Claude-User"]).toBe("user-action");
    expect(byToken["MistralAI-User"]).toBe("user-action");
    expect(byToken["Meta-ExternalFetcher"]).toBe("user-action");
    // Archive crawlers feed the shared corpora (Common Crawl / Wayback).
    expect(byToken["CCBot"]).toBe("archive");
    expect(byToken["ia_archiver"]).toBe("archive");
    expect(byToken["archive.org_bot"]).toBe("archive");
    // No stray classes.
    expect(
      AI_CRAWLERS.every((c) =>
        ["training", "ai-search", "user-action", "archive"].includes(c.crawlerClass),
      ),
    ).toBe(true);
  });

  test("blocking only a training crawler stays info-only (policy choice, no warn)", () => {
    const checks = run(robots([{ userAgent: "GPTBot", rules: [{ type: "disallow", path: "/" }] }]));
    expect(checks.every((c) => c.status === "info")).toBe(true);
    expect(checks.some((c) => c.name === "ai-answer-access")).toBe(false);
  });

  test("blocking an AI-search indexer escalates to a warn check", () => {
    const checks = run(
      robots([{ userAgent: "PerplexityBot", rules: [{ type: "disallow", path: "/" }] }]),
    );
    const warn = checks.find((c) => c.name === "ai-answer-access");
    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("PerplexityBot");
    expect(warn?.message).toContain("citations");
  });

  test("blocking a user-action fetcher warns and names the ClaudeBot vs Claude-User distinction", () => {
    const checks = run(
      robots([{ userAgent: "Claude-User", rules: [{ type: "disallow", path: "/" }] }]),
    );
    const warn = checks.find((c) => c.name === "ai-answer-access");
    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("Claude-User");
    expect(warn?.message).toContain("ClaudeBot");
  });

  test("blocking everything lists all as items and warns on the answer-engine subset", () => {
    const checks = run(blockAll());
    const summary = checks[0];
    expect(summary?.status).toBe("info");
    expect(summary?.items?.length).toBe(AI_CRAWLERS.length);
    const warn = checks.find((c) => c.name === "ai-answer-access");
    const answerCount = AI_CRAWLERS.filter(
      (c) => c.crawlerClass === "ai-search" || c.crawlerClass === "user-action",
    ).length;
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.length).toBe(answerCount);
  });
});
