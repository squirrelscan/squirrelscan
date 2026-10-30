// `[[ignore]]` waivers (#1262): one engine-level filter on every rule's result.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { readIgnoredDetails } from "@squirrelscan/core-contracts/ignore";

import { IGNORED_SKIP_REASON, IgnoreTable, isIgnorable, type IgnoreEntry } from "../src/ignore";
import type { RuleNamespace } from "../src/loader";
import { RuleRunner, type RulesConfig } from "../src/runner";
import type { PageData, Rule, RuleContext, RuleResult, SiteData } from "../src/types";

// Built at runtime: a nested-quantifier literal in a test file reads as a ReDoS to static analysis, and is the point of the test.

const URL_A = "https://shop.example/products/a";
const URL_APPS = "https://shop.example/apps/reviews";

function runner(ignore: IgnoreEntry[] | undefined, rules?: Rule[]): RuleRunner {
  const config: RulesConfig = {
    rule_options: {},
    rules: { enable: rules ? rules.map((r) => r.meta.id) : ["security/cookie-flags"] },
    ...(ignore ? { ignore } : {}),
  };
  const additionalNamespaces: RuleNamespace[] = rules ? [{ name: "test", rules }] : [];
  return new RuleRunner({ config, additionalNamespaces });
}

function page(url: string, cookies: string[]): PageData {
  return {
    url,
    html: "<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>",
    statusCode: 200,
    loadTime: 0,
    headers: { "set-cookie": cookies.join("\n") },
  };
}

const siteData = (): SiteData => ({ baseUrl: "https://shop.example", pages: [], robotsTxt: null, sitemaps: null });

async function checksOf(r: RuleRunner, p: PageData): Promise<CheckResult[]> {
  const out = await r.runPageRules(p, siteData());
  return out.ruleResults.get("security/cookie-flags")!.checks;
}

const byName = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

// Shopify sets `localization` and `cart_currency` itself; the merchant's own cookie must stay reported.
const SHOPIFY_COOKIES = ["localization=DE; Path=/", "cart_currency=EUR; Path=/", "merchant_pref=1; Path=/"];

describe("the cookie case from the issue", () => {
  test("the two Shopify cookies are waived, the merchant cookie is still reported, counts follow", async () => {
    const checks = await checksOf(
      runner([{ rule: "security/cookie-flags", items: ["localization", "cart_currency"], reason: "Shopify sets these" }]),
      page(URL_A, SHOPIFY_COOKIES),
    );
    const httpOnly = byName(checks, "cookie-httponly")!;
    expect(httpOnly.status).toBe("warn");
    expect(httpOnly.items?.map((i) => i.id)).toEqual(["merchant_pref"]);
    expect(httpOnly.message).toBe("1 cookie(s) missing the HttpOnly flag (2 ignored)");
    expect(readIgnoredDetails(httpOnly.details)).toEqual({ items: 2, entries: [0] });
    const secure = byName(checks, "cookie-secure")!;
    expect(secure.items?.map((i) => i.id)).toEqual(["merchant_pref"]);
  });

  test("with only the waived cookies, every check is a pass that says how many were waived", async () => {
    const checks = await checksOf(
      runner([{ rule: "security/cookie-flags", items: ["localization", "cart_currency"] }]),
      page(URL_A, ["localization=DE; Path=/", "cart_currency=EUR; Path=/"]),
    );
    for (const name of ["cookie-secure", "cookie-httponly", "cookie-samesite"]) {
      const check = byName(checks, name)!;
      expect(check.status).toBe("pass");
      expect(check.items).toBeUndefined();
      expect(check.message).toStartWith("2 waived by squirrel.toml: ");
      expect(readIgnoredDetails(check.details)?.items).toBe(2);
    }
  });

  test("without an ignore list nothing changes: the same check objects come back", async () => {
    const plain = await checksOf(runner(undefined), page(URL_A, SHOPIFY_COOKIES));
    const empty = await checksOf(runner([]), page(URL_A, SHOPIFY_COOKIES));
    expect(empty).toEqual(plain);
    expect(plain.every((c) => c.details === undefined || readIgnoredDetails(c.details) === null)).toBe(true);
  });

  test("a check restricted by `checks` is the only one filtered", async () => {
    const checks = await checksOf(
      runner([{ rule: "security/cookie-flags", checks: ["cookie-httponly"], items: ["localization"] }]),
      page(URL_A, ["localization=DE; Path=/"]),
    );
    expect(byName(checks, "cookie-httponly")?.status).toBe("pass");
    expect(byName(checks, "cookie-secure")?.status).toBe("warn");
  });
});

describe("urls: a page waiver", () => {
  test("an entry with urls alone skips the rule on a matching page, visibly, and does not run it", async () => {
    let runs = 0;
    const rule: Rule = {
      meta: { id: "test/perf", name: "t", description: "t", category: "core", scope: "page", severity: "warning", weight: 1 },
      run: (): RuleResult => {
        runs++;
        return { checks: [{ name: "slow", status: "warn", message: "slow" }] };
      },
    };
    const r = runner([{ rule: "test/perf", urls: ["/apps/"], reason: "app proxy" }], [rule]);
    const waived = (await r.runPageRules(page(URL_APPS, []), siteData())).ruleResults.get("test/perf")!.checks;
    expect(runs).toBe(0);
    expect(waived).toHaveLength(1);
    expect(waived[0]).toMatchObject({ status: "skipped", skipReason: IGNORED_SKIP_REASON });
    expect(waived[0]!.message).toContain("app proxy");
    expect(readIgnoredDetails(waived[0]!.details)).toEqual({ pages: 1, entries: [0] });
    const other = (await r.runPageRules(page(URL_A, []), siteData())).ruleResults.get("test/perf")!.checks;
    expect(runs).toBe(1);
    expect(other[0]!.status).toBe("warn");
  });

  test("items AND urls: the cookie is waived only on the matching pages", async () => {
    const r = runner([{ rule: "security/cookie-flags", items: ["localization"], urls: ["/apps/"] }]);
    const onApps = await checksOf(r, page(URL_APPS, ["localization=DE; Path=/"]));
    expect(byName(onApps, "cookie-httponly")?.status).toBe("pass");
    const elsewhere = await checksOf(r, page(URL_A, ["localization=DE; Path=/"]));
    expect(byName(elsewhere, "cookie-httponly")?.status).toBe("warn");
  });

  test("a rule an entry names by url is disqualified from template fan-out, others are not", () => {
    const r = runner([{ rule: "security/cookie-flags", urls: ["/apps/"] }, { rule: "core/*", items: ["x"] }]);
    expect(r.ignoresByPage("security/cookie-flags")).toBe(true);
    expect(r.ignoresByPage("core/meta-title")).toBe(false);
  });
});

describe("site rules and items with source pages", () => {
  const siteRule: Rule = {
    meta: { id: "test/links", name: "t", description: "t", category: "core", scope: "site", severity: "warning", weight: 1 },
    run: (): RuleResult => ({
      checks: [
        {
          name: "dead",
          status: "fail",
          message: "2 dead links",
          items: [
            { id: "https://x.test/a", sourcePages: ["https://shop.example/", "https://shop.example/apps/x"] },
            { id: "https://x.test/b", sourcePages: ["https://shop.example/apps/y"] },
          ],
        },
      ],
    }),
  };

  test("urls remove matching source pages and drop an item left with none", async () => {
    const r = runner([{ rule: "test/links", urls: ["/apps/"] }], [siteRule]);
    const out = await r.runSiteRules(siteData());
    const check = out.ruleResults.get("test/links")!.checks[0]!;
    expect(check.items).toEqual([{ id: "https://x.test/a", sourcePages: ["https://shop.example/"] }]);
    expect(check.status).toBe("fail");
    expect(readIgnoredDetails(check.details)).toMatchObject({ items: 1, pages: 1 });
  });

  test("an item matched by a glob on its id", async () => {
    const r = runner([{ rule: "test/*", items: ["glob:https://x.test/*"] }], [siteRule]);
    const check = (await r.runSiteRules(siteData())).ruleResults.get("test/links")!.checks[0]!;
    expect(check.status).toBe("pass");
    expect(check.message).toStartWith("2 waived by squirrel.toml");
  });
});

describe("matchers", () => {
  const table = (entries: IgnoreEntry[]) => new IgnoreTable(entries);
  const run = (entries: IgnoreEntry[], ids: string[], label?: string): string[] => {
    const checks: CheckResult[] = [
      { name: "c", status: "warn", message: "m", items: ids.map((id) => ({ id, ...(label ? { label } : {}) })) },
    ];
    return (table(entries).filterChecks("r/x", "https://a.test/", checks)[0]!.items ?? []).map((i) => i.id);
  };

  test("exact is the default and is not a substring match", () => {
    expect(run([{ rule: "r/x", items: ["localization"] }], ["localization", "localization_x", "xlocalization"])).toEqual([
      "localization_x",
      "xlocalization",
    ]);
  });

  test("glob and regex prefixes, and a match on the label", () => {
    expect(run([{ rule: "r/x", items: ["glob:cart_*"] }], ["cart_currency", "cart", "x_cart_y"])).toEqual(["cart", "x_cart_y"]);
    expect(run([{ rule: "r/x", items: ["regex:^_shopify_.+$"] }], ["_shopify_y", "shopify"])).toEqual(["shopify"]);
    expect(run([{ rule: "r/x", items: ["The label"] }], ["id-1"], "The label")).toEqual([]);
  });

  test("a rule glob and `*` select rules; a different rule is untouched", () => {
    const checks: CheckResult[] = [{ name: "c", status: "warn", message: "m", items: [{ id: "a" }] }];
    expect(table([{ rule: "a11y/*", items: ["a"] }]).filterChecks("a11y/x", undefined, checks)[0]!.status).toBe("pass");
    expect(table([{ rule: "a11y/*", items: ["a"] }]).filterChecks("seo/x", undefined, checks)).toBe(checks);
    expect(table([{ rule: "*", items: ["a"] }]).filterChecks("seo/x", undefined, checks)[0]!.status).toBe("pass");
  });

  test("entries OR across entries, fields AND within one", () => {
    const entries: IgnoreEntry[] = [
      { rule: "r/x", items: ["a"], urls: ["/one/"] },
      { rule: "r/x", items: ["b"] },
    ];
    const mk = (id: string, pageUrl: string) =>
      table(entries).filterChecks("r/x", pageUrl, [{ name: "c", status: "warn", message: "m", items: [{ id }] }])[0]!.status;
    expect(mk("a", "https://a.test/one/x")).toBe("pass");
    expect(mk("a", "https://a.test/two/x")).toBe("warn");
    expect(mk("b", "https://a.test/two/x")).toBe("pass");
  });

  test("pass and skipped checks are never touched", () => {
    const checks: CheckResult[] = [
      { name: "p", status: "pass", message: "ok", items: [{ id: "a" }] },
      { name: "s", status: "skipped", message: "no", items: [{ id: "a" }] },
    ];
    expect(table([{ rule: "r/x", items: ["a"] }]).filterChecks("r/x", undefined, checks)).toBe(checks);
  });

  test("unsafe or invalid regexes are refused and reported, never run", () => {
    const t = new IgnoreTable([
      { rule: "r/x", items: ["regex:(a)\\1"] },
      { rule: "r/x", items: ["regex:(unclosed"] },
      { rule: "r/x", items: [`regex:${"a".repeat(201)}`] },
      { rule: "r/x", urls: ["regex:(?<=a)b"] },
    ]);
    expect(t.problems.map((p) => p.entry)).toEqual([0, 1, 2, 3]);
    expect(t.empty).toBe(true);
    expect(t.problems[0]!.message).toContain("back-references");
  });

  test("a long item id is compared on its first characters by glob and regex, in bounded time", () => {
    const huge = "a".repeat(5_000_000);
    const started = performance.now();
    const out = run([{ rule: "r/x", items: ["glob:*b"] }], [huge]);
    expect(out).toEqual([huge]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a rule that is not ignorable has no entries", () => {
    const t = new IgnoreTable([{ rule: "integrity/*", items: ["a"] }], { isIgnorableRule: (id) => !id.startsWith("integrity/") });
    expect(t.forRule("integrity/cloaking")).toHaveLength(0);
    expect(isIgnorable({ ignorable: false })).toBe(false);
    expect(isIgnorable({})).toBe(true);
  });
});

describe("the cache signature", () => {
  test("includes only the entries that name the rule, so editing one invalidates exactly those rules", () => {
    const base: IgnoreEntry[] = [
      { rule: "security/cookie-flags", items: ["localization"] },
      { rule: "core/meta-title", urls: ["/apps/"] },
    ];
    const edited: IgnoreEntry[] = [
      { rule: "security/cookie-flags", items: ["localization", "cart_currency"] },
      { rule: "core/meta-title", urls: ["/apps/"] },
    ];
    const sig = (entries: IgnoreEntry[]) =>
      new Map(runner(entries, undefined).pageRuleSignature().map((s) => [s.id, s.ignore] as const));
    const a = sig(base);
    const b = sig(edited);
    expect(a.get("security/cookie-flags")).toBeDefined();
    expect(a.get("security/cookie-flags")).not.toBe(b.get("security/cookie-flags"));
    const noIgnore = runner(undefined).pageRuleSignature();
    expect(noIgnore.every((s) => s.ignore === undefined)).toBe(true);
  });

  test("an entry for another rule leaves this rule's signature alone", () => {
    const a = runner([{ rule: "core/meta-title", urls: ["/a/"] }]).pageRuleSignature().find((s) => s.id === "security/cookie-flags");
    const b = runner([{ rule: "core/meta-title", urls: ["/b/"] }]).pageRuleSignature().find((s) => s.id === "security/cookie-flags");
    expect(a).toEqual(b);
  });
});

describe("compromise detection cannot be waived", () => {
  test("every integrity rule is ignorable: false", async () => {
    const { loadAllRules } = await import("../src/loader");
    const rules = [...loadAllRules({ includeOptIn: true }).values()].filter((r) => r.meta.id.startsWith("integrity/"));
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) expect(r.meta.ignorable).toBe(false);
    const others = [...loadAllRules({ includeOptIn: true }).values()].filter((r) => !r.meta.id.startsWith("integrity/"));
    expect(others.every((r) => r.meta.ignorable !== false)).toBe(true);
  });

  test("the runner leaves an integrity rule's findings alone even when an entry names it", async () => {
    const rule: Rule = {
      meta: { id: "integrity/test", name: "t", description: "t", category: "core", scope: "page", severity: "warning", weight: 1, ignorable: false },
      run: (_ctx: RuleContext): RuleResult => ({ checks: [{ name: "bad", status: "fail", message: "1 bad", items: [{ id: "x" }] }] }),
    };
    const r = runner([{ rule: "integrity/*", items: ["x"] }], [rule]);
    const checks = (await r.runPageRules(page(URL_A, []), siteData())).ruleResults.get("integrity/test")!.checks;
    expect(checks[0]).toMatchObject({ status: "fail" });
  });
});

describe("a partial waiver prunes what still counted the waived items (review of #1333)", () => {
  test("drops element and resource evidence and pages only the waived item sat on", () => {
    const t = new IgnoreTable([{ rule: "r/x", items: ["gone"] }]);
    const check = {
      name: "c",
      status: "warn" as const,
      message: "2 items",
      items: [
        { id: "gone", sourcePages: ["https://e.com/a", "https://e.com/b"] },
        { id: "stay", sourcePages: ["https://e.com/b"] },
      ],
      pages: ["https://e.com/a", "https://e.com/b"],
      componentOccurrences: [{}],
      siteResourceOccurrences: [{}],
    } as never as CheckResult;
    const [out] = t.filterChecks("r/x", undefined, [check]);
    expect(out!.pages).toEqual(["https://e.com/b"]);
    expect(out!.componentOccurrences).toBeUndefined();
    expect(out!.siteResourceOccurrences).toBeUndefined();
    expect(out!.items).toHaveLength(1);
  });

  test("the reason is part of the cache signature", () => {
    const sig = (reason: string) => new IgnoreTable([{ rule: "r/x", items: ["a"], reason }]).signatureFor("r/x");
    expect(sig("one")).not.toBe(sig("two"));
  });
});
