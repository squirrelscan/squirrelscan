// ax/ai-crawlers — AI-agent crawler allow/block reporting + three-class
// taxonomy (training / ai-search / user-action) (#357).

import { describe, expect, test } from "bun:test";

import type { CheckResult, RobotsTxtData } from "@squirrelscan/core-contracts";
import { parseRobotsTxt } from "@squirrelscan/utils/robots-txt";

import {
  aiCrawlersRule,
  evaluateAiCrawlers,
  evaluateSearchEngineBots,
  AI_CRAWLERS,
  SEARCH_ENGINE_BOTS,
} from "../src/ax/ai-crawlers";
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

  test("stacked user agents parsed from robots.txt are both reported as blocked", () => {
    const data = parseRobotsTxt(
      "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n",
      "https://example.com/robots.txt",
    );
    const verdicts = evaluateAiCrawlers(data);

    expect(verdicts.find((v) => v.token === "GPTBot")?.blocked).toBe(true);
    expect(verdicts.find((v) => v.token === "ClaudeBot")?.blocked).toBe(true);
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

  test("a wildcard block is ONE warning row, not a row per crawler (#1780)", () => {
    const checks = run(blockAll());
    const summary = checks[0];
    expect(summary?.status).toBe("info");
    expect(summary?.items?.length).toBe(AI_CRAWLERS.length);
    // No per-crawler warning checks: the crawlers are not named in the file.
    expect(checks.find((c) => c.name === "ai-answer-access")).toBeUndefined();
    expect(checks.find((c) => c.name === "archive-crawler-access")).toBeUndefined();
    const wildcard = checks.filter((c) => c.name === "ai-crawlers-wildcard-blocked");
    expect(wildcard).toHaveLength(1);
    const row = wildcard[0]!;
    expect(row.status).toBe("warn");
    expect(row.message).toContain("all");
    expect(row.message).toContain("wildcard group");
    expect(row.message).toContain("crawl/robots-txt");
    // One item, so a comparison sees one finding; the affected crawlers are listed in it.
    expect(row.items).toHaveLength(1);
    expect(row.items![0]!.id).toBe("User-agent: *");
    expect(row.items![0]!.meta?.crawlers).toEqual(AI_CRAWLERS.map((c) => c.token));
    expect(row.details?.crawlers).toEqual(AI_CRAWLERS.map((c) => c.token));
    // One warning row for the AI crawlers. (Googlebot, blocked by the same wildcard, keeps its own
    // `search-engine-access` row: a different set of bots, and unchanged.)
    expect(checks.filter((c) => c.status === "warn" && c.name !== "search-engine-access")).toHaveLength(1);
  });

  const named = (token: string) => ({ userAgent: token, rules: [{ type: "disallow" as const, path: "/" }] });

  test("crawlers blocked by their own group keep their own rows (no wildcard)", () => {
    const checks = run(robots([named("OAI-SearchBot"), named("CCBot")]));
    expect(checks.find((c) => c.name === "ai-crawlers-wildcard-blocked")).toBeUndefined();
    expect(checks.find((c) => c.name === "ai-answer-access")?.items?.map((i) => i.id)).toEqual(["OAI-SearchBot"]);
    expect(checks.find((c) => c.name === "archive-crawler-access")?.items?.map((i) => i.id)).toEqual(["CCBot"]);
  });

  test("a wildcard block and a named block together: the named one is its own row, the rest are the wildcard row", () => {
    const checks = run(
      robots([{ userAgent: "*", rules: [{ type: "disallow", path: "/" }] }, named("OAI-SearchBot")])
    );
    expect(checks.find((c) => c.name === "ai-answer-access")?.items?.map((i) => i.id)).toEqual(["OAI-SearchBot"]);
    const wide = checks.find((c) => c.name === "ai-crawlers-wildcard-blocked")!;
    const crawlers = wide.items![0]!.meta?.crawlers as string[];
    expect(crawlers).not.toContain("OAI-SearchBot");
    expect(crawlers).toHaveLength(AI_CRAWLERS.length - 1);
  });

  test("a crawler the file allows by name while the wildcard blocks everything is not listed as blocked", () => {
    const checks = run(
      robots([
        { userAgent: "*", rules: [{ type: "disallow", path: "/" }] },
        { userAgent: "GPTBot", rules: [{ type: "allow", path: "/" }] },
      ])
    );
    const wide = checks.find((c) => c.name === "ai-crawlers-wildcard-blocked")!;
    expect(wide.items![0]!.meta?.crawlers).not.toContain("GPTBot");
    expect(checks[0]?.details?.blocked).not.toContain("GPTBot");
  });

  test("the row's identity is stable between audits: same check name and item id however the crawler list moves", () => {
    const before = run(blockAll()).find((c) => c.name === "ai-crawlers-wildcard-blocked")!;
    const after = run(
      robots([{ userAgent: "*", rules: [{ type: "disallow", path: "/" }] }, named("ClaudeBot")])
    ).find((c) => c.name === "ai-crawlers-wildcard-blocked")!;
    expect([before.name, before.items![0]!.id]).toEqual([after.name, after.items![0]!.id]);
  });

  test("a wildcard that blocks only crawlers whose block never warns is an info row", () => {
    // Every consequential crawler is allowed by name, so only training crawlers are left to the wildcard.
    const consequential = AI_CRAWLERS.filter((c) => c.crawlerClass !== "training").map((c) => ({
      userAgent: c.token,
      rules: [{ type: "allow" as const, path: "/" }],
    }));
    const checks = run(robots([{ userAgent: "*", rules: [{ type: "disallow", path: "/" }] }, ...consequential]));
    expect(checks.find((c) => c.name === "ai-crawlers-wildcard-blocked")?.status).toBe("info");
  });
});

// Search-engine bot class with a per-bot, path-aware verdict.
describe("ax/ai-crawlers search-engine bots", () => {
  const verdictOf = (data: RobotsTxtData, url: string, token: string) =>
    evaluateSearchEngineBots(data, url).find((v) => v.token === token);

  test("Googlebot, Bingbot and Applebot are classified as search-engine", () => {
    expect(SEARCH_ENGINE_BOTS.map((b) => b.token)).toEqual(["Googlebot", "Bingbot", "Applebot"]);
    const all = evaluateSearchEngineBots(robots([]), "https://example.com/");
    expect(all.every((v) => v.crawlerClass === "search-engine" && v.verdict === "allowed")).toBe(
      true,
    );
    // Not mixed into the AI crawler list.
    expect(AI_CRAWLERS.some((c) => c.token === "Googlebot")).toBe(false);
  });

  test("root block: Disallow / on a named bot is root-blocked, others stay allowed", () => {
    const data = robots([{ userAgent: "Bingbot", rules: [{ type: "disallow", path: "/" }] }]);
    const bing = verdictOf(data, "https://example.com/docs/page", "Bingbot");
    expect(bing?.verdict).toBe("root-blocked");
    expect(bing?.explicitlyListed).toBe(true);
    expect(verdictOf(data, "https://example.com/docs/page", "Googlebot")?.verdict).toBe("allowed");
  });

  test("path block: the root is open but the audited path is disallowed", () => {
    const data = robots([{ userAgent: "*", rules: [{ type: "disallow", path: "/private" }] }]);
    const hit = verdictOf(data, "https://example.com/private/report", "Googlebot");
    expect(hit?.verdict).toBe("path-blocked");
    expect(hit?.rootBlocked).toBe(false);
    expect(hit?.pathBlocked).toBe(true);
    expect(hit?.explicitlyListed).toBe(false);
    expect(verdictOf(data, "https://example.com/public", "Googlebot")?.verdict).toBe("allowed");
  });

  test("allow override: root disallowed, the audited path re-permitted by a longer Allow", () => {
    const data = robots([
      {
        userAgent: "Applebot",
        rules: [
          { type: "disallow", path: "/" },
          { type: "allow", path: "/docs/" },
        ],
      },
    ]);
    expect(verdictOf(data, "https://example.com/docs/intro", "Applebot")?.verdict).toBe(
      "allow-override",
    );
    expect(verdictOf(data, "https://example.com/other", "Applebot")?.verdict).toBe("root-blocked");
  });

  test("the rule reports the search-engine check for the entry URL; Googlebot blocked for it warns", () => {
    const c = ctx(robots([{ userAgent: "*", rules: [{ type: "disallow", path: "/private" }] }]));
    c.site!.entryUrls = ["https://example.com/private/start"];
    const checks = aiCrawlersRule.run(c).checks;
    const check = checks.find((x) => x.name === "search-engine-access");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("Googlebot blocked for this path only");
    expect((check?.details as { auditedUrl: string }).auditedUrl).toBe(
      "https://example.com/private/start",
    );
    expect(check?.items?.map((i) => i.id)).toEqual(["Googlebot", "Bingbot", "Applebot"]);
  });

  test("no robots.txt: no search-engine check, everything is allowed by default", () => {
    expect(run(null).some((c) => c.name === "search-engine-access")).toBe(false);
  });

  test("Applebot with no group of its own follows the Googlebot group before *", () => {
    const data = robots([
      { userAgent: "Googlebot", rules: [{ type: "disallow", path: "/x" }] },
      { userAgent: "*", rules: [] },
    ]);
    expect(verdictOf(data, "https://example.com/x", "Applebot")?.verdict).toBe("path-blocked");
    expect(verdictOf(data, "https://example.com/x", "Googlebot")?.verdict).toBe("path-blocked");
    expect(verdictOf(data, "https://example.com/x", "Bingbot")?.verdict).toBe("allowed");
    // An Applebot group wins over the Googlebot one, and Applebot-Extended is a different token.
    const own = robots([
      { userAgent: "Googlebot", rules: [{ type: "disallow", path: "/x" }] },
      { userAgent: "Applebot", rules: [{ type: "allow", path: "/" }] },
    ]);
    expect(verdictOf(own, "https://example.com/x", "Applebot")?.verdict).toBe("allowed");
    const extended = robots([
      { userAgent: "Applebot-Extended", rules: [{ type: "disallow", path: "/" }] },
    ]);
    expect(verdictOf(extended, "https://example.com/x", "Applebot")?.verdict).toBe("allowed");
  });

  describe("search-engine-access status (Googlebot decides)", () => {
    const status = (rules: Group[], url = "https://example.com/") => {
      const c = ctx(robots(rules));
      c.site!.entryUrls = [url];
      const check = aiCrawlersRule.run(c).checks.find((x) => x.name === "search-engine-access");
      return { check, status: check?.status };
    };
    const deny = (path: string) => [{ type: "disallow" as const, path }];

    test("Googlebot blocked from the root warns", () => {
      const r = status([{ userAgent: "Googlebot", rules: deny("/") }]);
      expect(r.status).toBe("warn");
      expect(r.check?.message).toContain("robots.txt blocks Googlebot (blocked from the site root)");
    });

    test("Googlebot blocked for the entry path warns", () => {
      const r = status([{ userAgent: "*", rules: deny("/shop") }], "https://example.com/shop/a");
      expect(r.status).toBe("warn");
      expect(r.check?.message).toContain("Googlebot (blocked for this path only)");
    });

    test("a wildcard Disallow / warns too, since Googlebot falls under it", () => {
      expect(status([{ userAgent: "*", rules: deny("/") }]).status).toBe("warn");
    });

    test("an Allow override for the entry path stays info", () => {
      const r = status(
        [{ userAgent: "Googlebot", rules: [...deny("/"), { type: "allow", path: "/docs/" }] }],
        "https://example.com/docs/intro",
      );
      expect(r.status).toBe("info");
      expect(r.check?.message).not.toContain("robots.txt blocks Googlebot");
    });

    test("Googlebot allowed while another engine is blocked stays info", () => {
      for (const token of ["Bingbot", "Applebot-Extended"]) {
        const r = status([{ userAgent: token, rules: deny("/") }]);
        expect(r.status, token).toBe("info");
        expect(r.check?.message).not.toContain("robots.txt blocks Googlebot");
      }
      // Bingbot listed as blocked, but only as an item: it is still reported.
      const bing = status([{ userAgent: "Bingbot", rules: deny("/") }]);
      expect(bing.check?.items?.map((i) => i.id)).toEqual(["Bingbot"]);
    });

    test("a robots.txt that allows everything stays info", () => {
      expect(status([]).status).toBe("info");
    });

    test("details.bots still lists every bot with its class, warn or not", () => {
      for (const rules of [[], [{ userAgent: "Googlebot", rules: deny("/") }]] as Group[][]) {
        const bots = (status(rules).check?.details as { bots: Array<{ token: string; crawlerClass: string }> }).bots;
        expect(bots.map((b) => [b.token, b.crawlerClass])).toEqual([
          ["Googlebot", "search-engine"],
          ["Bingbot", "search-engine"],
          ["Applebot", "search-engine"],
        ]);
      }
    });

    test("a missing robots.txt emits no search-engine check at all", () => {
      expect(run(null).some((c) => c.name === "search-engine-access")).toBe(false);
    });

    test("the AI-crawler checks keep their own statuses beside a Googlebot warn", () => {
      const checks = aiCrawlersRule.run(ctx(blockAll())).checks;
      expect(checks[0]?.name).toBe("ai-crawler-access");
      expect(checks[0]?.status).toBe("info");
      expect(checks.find((c) => c.name === "search-engine-access")?.status).toBe("warn");
    });
  });
});
