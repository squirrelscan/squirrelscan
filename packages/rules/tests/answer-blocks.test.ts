// ax/answer-blocks: question headings need a direct answer, data tables and charts need a source (repo#3882).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { answerBlocksRule } from "../src/ax/answer-blocks";
import type { CheckResult, RuleContext } from "../src/types";

async function run(body: string, url = "https://example.com/blog/post"): Promise<CheckResult[]> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Post</title></head><body>${body}</body></html>`;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  return (await answerBlocksRule.run(ctx)).checks;
}

const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

describe("ax/answer-blocks question headings", () => {
  test("a direct answer passes", async () => {
    const c = named(
      await run(
        `<article><h1>Guide</h1><h2>What is a sitemap?</h2><p>A sitemap is an XML file that lists the URLs of a site. Crawlers read it to find pages.</p></article>`,
      ),
      "answer-blocks",
    );
    expect(c?.status).toBe("pass");
  });

  test("a pronoun opener is flagged and listed", async () => {
    const c = named(
      await run(
        `<h2>What is a sitemap?</h2><p>It is a file. Crawlers read it.</p><h2>Why does it matter?</h2><p>Search engines find pages faster.</p>`,
      ),
      "answer-blocks",
    );
    expect(c?.status).toBe("warn");
    expect(c?.items?.map((i) => i.id)).toEqual(["What is a sitemap?"]);
    expect(c?.items?.[0]?.label).toContain("opens with a pronoun");
  });

  test("a demonstrative used as a determiner is fine", async () => {
    const c = named(
      await run(`<h2>What is a sitemap?</h2><p>This file lists every URL you want crawled.</p>`),
      "answer-blocks",
    );
    expect(c?.status).toBe("pass");
  });

  test("a question followed by another heading has no answer", async () => {
    const c = named(
      await run(`<h2>What is a sitemap?</h2><h2>How do I make one?</h2><p>Use a generator.</p>`),
      "answer-blocks",
    );
    expect(c?.status).toBe("warn");
    expect(c?.items).toHaveLength(1);
    expect(c?.items?.[0]?.label).toContain("no answer");
  });

  test("an over-long opening sentence is flagged", async () => {
    const long = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
    const c = named(await run(`<h2>What is it?</h2><p>${long}.</p>`), "answer-blocks");
    expect(c?.items?.[0]?.label).toContain("too long");
  });

  test("a list answer and chrome headings are not flagged", async () => {
    const c = named(
      await run(
        `<h2>Which plans exist?</h2><ul><li>Free</li><li>Pro</li></ul><footer><h3>Questions?</h3></footer>`,
      ),
      "answer-blocks",
    );
    expect(c?.status).toBe("pass");
    expect(c?.details?.questionHeadings).toBe(1);
  });

  test("statements and short headings are not questions", async () => {
    const checks = await run(`<h2>How we work</h2><p>It is simple.</p><h2>Why?</h2><p>It is.</p>`);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("a heading wrapper reaches the answer next to it", async () => {
    const c = named(
      await run(
        `<div><div class="q"><h3>How long does it take?</h3></div><p>Most audits finish in under a minute.</p></div>`,
      ),
      "answer-blocks",
    );
    expect(c?.status).toBe("pass");
  });
});

describe("ax/answer-blocks sources", () => {
  const table = `<table><tr><th>Year</th><th>Users</th></tr><tr><td>2024</td><td>1</td></tr><tr><td>2025</td><td>2</td></tr></table>`;

  test("a table with no source is flagged", async () => {
    const c = named(await run(`<h1>Report</h1>${table}`), "figure-sources");
    expect(c?.status).toBe("warn");
    expect(c?.items?.[0]?.id).toContain("table");
  });

  test("a caption, nearby source line or link counts", async () => {
    for (const body of [
      `<table><caption>Users. Source: Census</caption><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>`,
      `${table}<p>Source: internal survey</p>`,
      `<figure><svg></svg><figcaption>Growth, <a href="https://data.example.org/g">dataset</a></figcaption></figure>`,
    ]) {
      expect(named(await run(body), "figure-sources")?.status).toBe("pass");
    }
  });

  test("a layout table is ignored", async () => {
    const checks = await run(`<table role="presentation"><tr><td>a</td><td>b</td></tr></table>`);
    expect(checks[0]?.status).toBe("skipped");
  });
});

describe("ax/answer-blocks applicability", () => {
  test("a page with nothing to judge is not applicable", async () => {
    const checks = await run(`<h1>Welcome</h1><p>Hello.</p>`);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBe("not-applicable");
  });

  test("a product page is skipped", async () => {
    const checks = await run(
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"x"}</script><h2>Does it fit?</h2><p>It does.</p>`,
    );
    expect(checks[0]?.status).toBe("skipped");
  });

  test("the rule is advisory", () => {
    expect(answerBlocksRule.meta.severity).toBe("info");
  });
});
