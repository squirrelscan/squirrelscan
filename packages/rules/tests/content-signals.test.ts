// ax/content-signals — Content-Signal parsing + contradiction detection.

import { describe, expect, test } from "bun:test";

import type { CheckResult, RobotsTxtData } from "@squirrelscan/core-contracts";

import {
  contentSignalsRule,
  parseContentSignals,
  findContradictions,
} from "../src/ax/content-signals";
import type { ParsedPage, RuleContext } from "../src/types";

type Group = RobotsTxtData["rules"][number];

function robots(content: string, rules: Group[] = []): RobotsTxtData {
  return {
    exists: true,
    url: "https://example.com/robots.txt",
    content,
    sizeBytes: content.length,
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
  return contentSignalsRule.run(ctx(robotsTxt)).checks;
}

describe("parseContentSignals", () => {
  test("parses a wildcard-group signal into known key/value pairs", () => {
    const parsed = parseContentSignals(
      "User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /",
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.userAgents).toEqual(["*"]);
    expect(parsed[0]?.signals).toEqual([
      { key: "search", value: "yes" },
      { key: "ai-input", value: "yes" },
      { key: "ai-train", value: "no" },
    ]);
    expect(parsed[0]?.unknownKeys).toEqual([]);
    expect(parsed[0]?.malformed).toEqual([]);
  });

  test("associates a signal with the group's user-agent and strips comments", () => {
    const parsed = parseContentSignals(
      "User-agent: GPTBot\nContent-Signal: ai-train=no  # opt out\nDisallow: /",
    );
    expect(parsed[0]?.userAgents).toEqual(["gptbot"]);
    expect(parsed[0]?.signals).toEqual([{ key: "ai-train", value: "no" }]);
  });

  test("flags unknown keys and malformed tokens", () => {
    const parsed = parseContentSignals("User-agent: *\nContent-Signal: search=maybe, foo=yes, bare");
    expect(parsed[0]?.unknownKeys).toEqual(["foo"]);
    // search=maybe (bad value) and `bare` (no =) are both malformed.
    expect(parsed[0]?.malformed).toEqual(["search=maybe", "bare"]);
    expect(parsed[0]?.signals).toEqual([]);
  });

  test("Cloudflare managed line with use= aux key parses clean (no unknown/malformed)", () => {
    // Verbatim shape of Cloudflare's managed robots.txt rollout.
    const parsed = parseContentSignals("User-agent: *\nContent-Signal: search=yes,ai-train=no,use=reference\nAllow: /");
    expect(parsed[0]?.unknownKeys).toEqual([]);
    expect(parsed[0]?.malformed).toEqual([]);
    expect(parsed[0]?.aux).toEqual([{ key: "use", value: "reference" }]);
    expect(parsed[0]?.signals).toEqual([
      { key: "search", value: "yes" },
      { key: "ai-train", value: "no" },
    ]);
  });

  test("use= with a bad value is malformed, not unknown", () => {
    const parsed = parseContentSignals("Content-Signal: use=always");
    expect(parsed[0]?.malformed).toEqual(["use=always"]);
    expect(parsed[0]?.unknownKeys).toEqual([]);
  });

  test("returns nothing when robots.txt has no Content-Signal line", () => {
    expect(parseContentSignals("User-agent: *\nDisallow: /private")).toEqual([]);
  });
});

describe("findContradictions", () => {
  test("ai-train=yes while a training bot is fully blocked is a contradiction", () => {
    const r = robots("User-agent: *\nContent-Signal: ai-train=yes", [
      { userAgent: "GPTBot", rules: [{ type: "disallow", path: "/" }] },
    ]);
    const contradictions = findContradictions(parseContentSignals(r.content ?? ""), r);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.signal).toBe("ai-train");
    expect(contradictions[0]?.blockedTokens).toContain("GPTBot");
  });

  test("search=yes while an AI-search indexer is blocked is a contradiction", () => {
    const r = robots("Content-Signal: search=yes", [
      { userAgent: "PerplexityBot", rules: [{ type: "disallow", path: "/" }] },
    ]);
    const contradictions = findContradictions(parseContentSignals(r.content ?? ""), r);
    expect(contradictions[0]?.signal).toBe("search");
    expect(contradictions[0]?.crawlerClass).toBe("ai-search");
  });

  test("no contradiction when the declared policy matches the blocks", () => {
    const r = robots("User-agent: *\nContent-Signal: ai-train=no, search=yes", [
      { userAgent: "GPTBot", rules: [{ type: "disallow", path: "/" }] },
    ]);
    expect(findContradictions(parseContentSignals(r.content ?? ""), r)).toEqual([]);
  });

  test("signal scoped to another UA group does not contradict a different bot's block", () => {
    // ai-train=yes is declared only for Googlebot's group; GPTBot's Disallow
    // lives in a separate group the signal never spoke for.
    const r = robots("User-agent: GPTBot\nDisallow: /\n\nUser-agent: Googlebot\nContent-Signal: ai-train=yes", [
      { userAgent: "GPTBot", rules: [{ type: "disallow", path: "/" }] },
    ]);
    expect(findContradictions(parseContentSignals(r.content ?? ""), r)).toEqual([]);
  });

  test("signal scoped to the blocked bot's own group still contradicts", () => {
    const r = robots("User-agent: GPTBot\nContent-Signal: ai-train=yes\nDisallow: /", [
      { userAgent: "GPTBot", rules: [{ type: "disallow", path: "/" }] },
    ]);
    const contradictions = findContradictions(parseContentSignals(r.content ?? ""), r);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.blockedTokens).toContain("GPTBot");
  });
});

describe("ax/content-signals rule", () => {
  test("absent Content-Signal reports info, not a failure", () => {
    const checks = run(robots("User-agent: *\nDisallow: /admin"));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("No Content-Signal");
  });

  test("no robots.txt at all still reports info", () => {
    const checks = run(null);
    expect(checks[0]?.status).toBe("info");
  });

  test("a clean policy reports the declared signals as info", () => {
    const checks = run(robots("User-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /"));
    const policy = checks.find((c) => c.name === "content-signals-policy");
    expect(policy?.status).toBe("info");
    expect(policy?.message).toContain("search=yes");
    expect(policy?.message).toContain("ai-train=no");
    expect(checks.every((c) => c.status === "info")).toBe(true);
  });

  test("Cloudflare managed policy with use= reports clean info incl. the aux key", () => {
    const checks = run(robots("User-agent: *\nContent-Signal: search=yes,ai-train=no,use=reference\nAllow: /"));
    expect(checks.find((c) => c.name === "content-signals-syntax")).toBeUndefined();
    const policy = checks.find((c) => c.name === "content-signals-policy");
    expect(policy?.message).toContain("use=reference");
  });

  test("invalid syntax warns", () => {
    const checks = run(robots("Content-Signal: foo=bar, search=maybe"));
    const syntax = checks.find((c) => c.name === "content-signals-syntax");
    expect(syntax?.status).toBe("warn");
    expect(syntax?.message).toContain("foo");
  });

  test("a contradiction warns", () => {
    const checks = run(
      robots("User-agent: *\nContent-Signal: ai-train=yes", [
        { userAgent: "ClaudeBot", rules: [{ type: "disallow", path: "/" }] },
      ]),
    );
    const contradiction = checks.find((c) => c.name === "content-signals-contradiction");
    expect(contradiction?.status).toBe("warn");
    expect(contradiction?.message).toContain("ClaudeBot");
  });
});
