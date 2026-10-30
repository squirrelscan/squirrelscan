// eeat/about-page, eeat/contact-page and eeat/privacy-policy: German about slugs and a `paths`
// option for site-specific pages (#1261).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";

import { aboutPageRule } from "../src/eeat/about-page";
import { contactPageRule } from "../src/eeat/contact-page";
import { privacyPolicyRule } from "../src/eeat/privacy-policy";
import { checkRuleOptions } from "../src/rule-options-check";
import type { CheckResult, ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

const ORIGIN = "https://shop.example";
const FILLER = `<p>${Array.from({ length: 220 }, (_, i) => `word${i}`).join(" ")}</p>`;

const html = (title: string, body: string): string =>
  `<!doctype html><html lang="de"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

function ctxFor(
  pagesHtml: Array<{ url: string; html: string }>,
  options: object = {},
): RuleContext {
  const pages: SiteData["pages"] = pagesHtml.map((p) => ({
    url: p.url,
    statusCode: 200,
    parsed: parsePage(p.html, p.url),
  }));
  return {
    page: { url: pages[0]!.url, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: pages[0]?.parsed ?? ({} as ParsedPage),
    site: { baseUrl: ORIGIN, pages, robotsTxt: null, sitemaps: null },
    options,
  };
}

const run = (rule: Rule, ctx: RuleContext): CheckResult[] => {
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error("async rule");
  return result.checks;
};

const home = { url: `${ORIGIN}/`, html: html("Startseite", "<p>Willkommen</p>") };

describe("eeat/about-page German slugs (#1261)", () => {
  test.each([
    "/wer-wir-sind",
    "/unsere-geschichte",
    "/pages/wer-wir-sind",
    "/pages/unsere-geschichte/",
    "/unsere-geschichte.html",
  ])("%s is the About page", (path) => {
    const checks = run(
      aboutPageRule,
      ctxFor([home, { url: `${ORIGIN}${path}`, html: html("Über", FILLER) }]),
    );
    expect(checks[0]).toMatchObject({ name: "about-page", status: "pass" });
  });

  test.each(["/team", "/the-team", "/das-team", "/agentur", "/agency", "/pages/team"])(
    "%s is not an About page by default",
    (path) => {
      expect(EEAT_PAGE_PATTERNS.about.some((p) => p.test(path))).toBe(false);
      const checks = run(
        aboutPageRule,
        ctxFor([home, { url: `${ORIGIN}${path}`, html: html("Team", FILLER) }]),
      );
      expect(checks[0]).toMatchObject({ status: "warn", message: "No About page found" });
    },
  );
});

describe("the paths option (#1261)", () => {
  const cases = [
    {
      rule: aboutPageRule,
      id: "eeat/about-page",
      name: "about-page",
      label: "About page",
      pass: "About page exists with substantial content",
    },
    {
      rule: contactPageRule,
      id: "eeat/contact-page",
      name: "contact-page",
      label: "Contact page",
      pass: "Contact page exists",
    },
  ] as const;

  for (const c of cases) {
    describe(c.id, () => {
      const target = `${ORIGIN}/pages/manufaktur`;
      const page = { url: target, html: html("Manufaktur", FILLER) };

      test("without the option an unconventional path is not the page", () => {
        expect(run(c.rule, ctxFor([home, page]))[0]).toMatchObject({ status: "warn" });
      });

      test("a configured path makes the crawled page satisfy the rule, with no schema type", () => {
        const checks = run(c.rule, ctxFor([home, page], { paths: ["/pages/manufaktur"] }));
        expect(checks.find((k) => k.name === c.name)).toMatchObject({
          status: "pass",
          message: c.pass,
        });
      });

      test("exact-segment and regex patterns work like excludePatterns", () => {
        for (const paths of [["/pages/manufaktur/"], ["regex:^/pages/manu"]]) {
          expect(run(c.rule, ctxFor([home, page], { paths }))[0]).toMatchObject({ status: "pass" });
        }
        expect(run(c.rule, ctxFor([home, page], { paths: ["/pages/other"] }))[0]).toMatchObject({
          status: "warn",
        });
      });

      test("a configured path that was linked but not crawled is reported as such", () => {
        const linked = {
          url: `${ORIGIN}/`,
          html: html("Startseite", `<footer><a href="/pages/manufaktur">Manufaktur</a></footer>`),
        };
        const checks = run(c.rule, ctxFor([linked], { paths: ["/pages/manufaktur"] }));
        expect(checks).toEqual([
          {
            name: c.name,
            status: "info",
            message: `${c.label} linked but not crawled`,
            value: target,
            details: { linkedFrom: `${ORIGIN}/` },
          },
        ]);
        // Without the option the same link is not recognised.
        expect(run(c.rule, ctxFor([linked]))[0]).toMatchObject({ status: "warn" });
      });

      test("the built-in slugs still work beside a configured path", () => {
        const slug = {
          url: `${ORIGIN}/${c.name === "about-page" ? "about-us" : "contact"}`,
          html: html("X", FILLER),
        };
        expect(
          run(c.rule, ctxFor([home, slug], { paths: ["/pages/manufaktur"] }))[0],
        ).toMatchObject({ status: "pass" });
      });
    });
  }

  describe("eeat/privacy-policy", () => {
    const page = { url: `${ORIGIN}/pages/rechtliches`, html: html("Rechtliches", FILLER) };
    const linkedHome = {
      url: `${ORIGIN}/`,
      html: html("Startseite", `<a href="/pages/rechtliches">Rechtliches</a>`),
    };

    test("a configured path is the policy, and links to it count toward coverage", () => {
      const without = run(privacyPolicyRule, ctxFor([linkedHome, page]));
      expect(without[0]).toMatchObject({ status: "warn" });
      const checks = run(
        privacyPolicyRule,
        ctxFor([linkedHome, page], { paths: ["/pages/rechtliches"] }),
      );
      expect(checks.find((k) => k.name === "privacy-policy")).toMatchObject({ status: "pass" });
      expect(checks.find((k) => k.name === "privacy-linked")?.message).toBe(
        "Privacy policy linked from 50% of pages",
      );
    });

    test("a configured path linked but not crawled is reported as linked but not crawled", () => {
      const checks = run(
        privacyPolicyRule,
        ctxFor([linkedHome], { paths: ["/pages/rechtliches"] }),
      );
      expect(checks[0]).toMatchObject({ name: "privacy-policy", status: "info" });
    });
  });
});

describe("paths match the URL's path only, never the host, query or fragment (#1261 review)", () => {
  const target = (url: string, paths: string[]) => {
    const checks = run(aboutPageRule, ctxFor([home, { url, html: html("X", FILLER) }], { paths }));
    return checks[0]?.status;
  };

  test("a path pattern matches the page's path", () => {
    expect(target(`${ORIGIN}/pages/manufaktur`, ["/pages/manufaktur"])).toBe("pass");
    expect(target(`${ORIGIN}/pages/manufaktur?utm=1`, ["/pages/manufaktur"])).toBe("pass");
    expect(target(`${ORIGIN}/pages/manufaktur#top`, ["/pages/manufaktur"])).toBe("pass");
  });

  test("a bare word does not match the host", () => {
    expect(target("https://manufaktur.de/shop", ["manufaktur"])).toBe("warn");
    expect(target("https://manufaktur.de/manufaktur/team", ["manufaktur"])).toBe("pass");
  });

  test("a path in the query string or fragment is not the page", () => {
    expect(target(`${ORIGIN}/shop?next=/pages/manufaktur`, ["/pages/manufaktur"])).toBe("warn");
    expect(target(`${ORIGIN}/shop#/pages/manufaktur`, ["/pages/manufaktur"])).toBe("warn");
    expect(target(`${ORIGIN}/shop?x=1`, ["regex:manufaktur"])).toBe("warn");
  });
});

describe("rule-options preflight for paths (#1261)", () => {
  test.each(["eeat/about-page", "eeat/contact-page", "eeat/privacy-policy"])(
    "%s flags a regex that does not compile, naming the entry",
    (id) => {
      const problems = checkRuleOptions({ [id]: { paths: ["/ok", "regex:([unclosed"] } });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ kind: "invalid-value", ruleId: id });
      expect(problems[0]?.message).toContain(`[rule_options."${id}"] paths.1`);
      expect(problems[0]?.message).toContain("not a valid regular expression");
    },
  );

  test("a regex with flags and a plain path both pass", () => {
    expect(
      checkRuleOptions({ "eeat/about-page": { paths: ["regex:^/pages/manu:i", "/pages/x/"] } }),
    ).toEqual([]);
  });

  test.each(["eeat/about-page", "eeat/contact-page", "eeat/privacy-policy"])(
    "%s accepts an array of strings",
    (id) => {
      expect(checkRuleOptions({ [id]: { paths: ["/pages/manufaktur"] } })).toEqual([]);
    },
  );

  test.each(["eeat/about-page", "eeat/contact-page", "eeat/privacy-policy"])(
    "%s flags a paths value that is not an array of strings",
    (id) => {
      for (const paths of ["/pages/manufaktur", [1, 2], { a: 1 }, [""]]) {
        const problems = checkRuleOptions({ [id]: { paths } });
        expect(problems.length).toBeGreaterThan(0);
        expect(problems.every((p) => p.kind === "invalid-value" && p.ruleId === id)).toBe(true);
        expect(problems[0]?.message).toContain(`[rule_options."${id}"] paths`);
      }
    },
  );

  test("an unknown option now lists paths among the options", () => {
    const [problem] = checkRuleOptions({ "eeat/about-page": { path: ["/x"] } });
    expect(problem?.kind).toBe("unknown-option");
    expect(problem?.message).toContain("options: paths");
  });
});
