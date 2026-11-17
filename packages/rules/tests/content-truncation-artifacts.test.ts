import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { cutInsideWord, splitEllipsis, truncationArtifactsRule } from "../src/content/truncation-artifacts";
import type { ParsedPage, RuleContext } from "../src/types";
import { expectDeclaredChecks } from "./helpers/declared-checks";

function run(
  body: string,
  { title = "A complete page title", description = "", head = "", headers = {} as Record<string, string> } = {},
): CheckResult {
  const desc = description ? `<meta name="description" content="${description}">` : "";
  const html = `<html><head><title>${title}</title>${desc}${head}</head><body>${body}</body></html>`;
  const url = "https://example.com/post";
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  const out = truncationArtifactsRule.run(ctx) as { checks: CheckResult[] };
  expectDeclaredChecks(truncationArtifactsRule, out.checks);
  expect(out.checks).toHaveLength(1);
  return out.checks[0]!;
}

const LONG_BODY = "Our dashboard gives every team a single place to follow audits, fixes and regressions over time.";

describe("content/truncation-artifacts helpers", () => {
  test("splitEllipsis separates the stump from the ellipsis", () => {
    expect(splitEllipsis("the dashbo...")).toMatchObject({ fragment: "the dashbo", glued: true, hadEllipsis: true });
    expect(splitEllipsis("the dashboard …")).toMatchObject({ fragment: "the dashboard", glued: false });
    expect(splitEllipsis("a whole sentence.")).toMatchObject({ hadEllipsis: false });
    expect(splitEllipsis("cut off [...]")).toMatchObject({ fragment: "cut off", glued: false });
  });

  test("cutInsideWord needs the source to carry on with a letter", () => {
    expect(cutInsideWord("the new dashbo", "the new dashboard", false)).toBe(true);
    expect(cutInsideWord("the new dashboard", "the new dashboard for teams", false)).toBe(false);
    expect(cutInsideWord("the new dashboard.", "the new dashboard. More", false)).toBe(false);
  });
});

describe("content/truncation-artifacts", () => {
  test("fail: a title that is a prefix of the H1, cut mid-word", () => {
    const c = run("<h1>Introducing the new dashboard for teams</h1>", { title: "Introducing the new dashbo" });
    expect(c.status).toBe("fail");
    expect(c.message).toContain("<title>");
    expect(c.message).toContain("Introducing the new dashbo");
  });

  test("fail: a title cut mid-word with a trailing ellipsis", () => {
    const c = run("<h1>Introducing the new dashboard for teams</h1>", { title: "Introducing the new dashbo..." });
    expect(c.status).toBe("fail");
    expect(c.items?.[0]?.snippet).toBe("Introducing the new dashbo...");
  });

  test("fail: an ellipsis glued to a partial word at 60 characters", () => {
    const stump = "Ten ways to improve your website audit workflow with autom";
    expect(stump.length).toBe(58);
    const c = run("<h1>Other</h1>", { title: `${stump}at...` });
    expect(c.status).toBe("fail");
  });

  test("fail: a description cut mid-word, proven by the body copy", () => {
    const c = run(`<p>${LONG_BODY}</p>`, { description: "Our dashboard gives every team a single place to follow audits, fixes and regress…" });
    expect(c.status).toBe("fail");
    expect(c.message).toContain("meta description");
  });

  test("fail: a description cut mid-word, proven by og:description", () => {
    const c = run("<p>Hello there</p>", {
      description: "We audit your website for search, speed and securi",
      head: '<meta property="og:description" content="We audit your website for search, speed and security issues.">',
    });
    expect(c.status).toBe("fail");
  });

  test("fail: a 60 character title that ends on a dangling word", () => {
    const title = "How to write titles that fit the search result views for the";
    expect(title.length).toBe(60);
    expect(run("<h1>Other</h1>", { title }).status).toBe("fail");
    // Same length, ends on a whole word: nothing says it was cut.
    expect(run("<h1>Other</h1>", { title: title.replace(/ the$/, " end") }).status).toBe("pass");
  });

  test("warn: body copy cut mid-word, a longer version elsewhere, no read more link", () => {
    const full = "The quarterly report covers every audit we ran across the whole customer base this year.";
    const c = run(`<p>${full}</p><div><p>The quarterly report covers every audit we ran across the whole cust…</p></div>`);
    expect(c.status).toBe("warn");
    expect(c.message).toContain("body copy");
  });

  test("warn: body copy ending in a glued ellipsis at a round limit", () => {
    const text = `${"Notes about the release process and how our team ships fixes ".repeat(2)}to productio`.slice(0, 100);
    expect(text.length).toBe(100);
    expect(run(`<p>${text}...</p>`).status).toBe("warn");
  });

  test("pass: the same cut body copy with a read more link beside it", () => {
    const text = `${"Notes about the release process and how our team ships fixes ".repeat(2)}to productio`.slice(0, 100);
    const c = run(`<article><p>${text}...</p><a href="/post">Read more</a></article>`);
    expect(c.status).toBe("pass");
  });

  test("pass: the no-false-positive page: quotation, stylistic and whole-word ellipses", () => {
    const c = run(
      `<h1>Why we stopped waiting</h1>
       <blockquote><p>We were going to ship it in the spring but the compan...</p></blockquote>
       <p>And then, after all the planning and the waiting for the perfect moment, we just did it...</p>
       <p>Then the whole thing went quiet for a while, and nobody said a word …</p>
       <p>${LONG_BODY}</p>`,
      {
        title: "Why we stopped waiting...",
        description: "A short note on why the team stopped waiting for the perfect moment to launch.",
      },
    );
    expect(c.status).toBe("pass");
  });

  test("pass: a title that is a complete prefix of the H1 at a word boundary", () => {
    expect(run("<h1>Introducing the new dashboard for teams</h1>", { title: "Introducing the new dashboard" }).status).toBe("pass");
  });

  test("pass: a title that ends where an H1 <br> breaks the line", () => {
    const c = run("<h1>The best project management tool<br>for remote teams</h1>", {
      title: "The best project management tool",
    });
    expect(c.status).toBe("pass");
  });

  test("skipped: a noindex page", () => {
    const c = run("<h1>Introducing the new dashboard for teams</h1>", {
      title: "Introducing the new dashbo",
      head: '<meta name="robots" content="noindex">',
    });
    expect(c.status).toBe("skipped");
    expect(c.skipReason).toBe("noindex");
  });

  test("skipped: nothing to read", () => {
    const html = `<html><head></head><body></body></html>`;
    const ctx: RuleContext = {
      page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, "https://example.com/") as ParsedPage,
      options: {},
    };
    const out = truncationArtifactsRule.run(ctx) as { checks: CheckResult[] };
    expect(out.checks[0]!.status).toBe("skipped");
  });
});
