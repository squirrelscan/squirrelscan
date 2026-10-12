// content/common-misspellings: lookup of known misspellings and doubled words on
// English pages. The fixtures pin the exclusions as much as the detections: a
// page that quotes a misspelling in code, a brand, or another language must stay
// clean.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import {
  commonMisspellingsRule,
  scanPageForMisspellings,
} from "../src/content/common-misspellings";
import { COMMON_MISSPELLINGS } from "../src/content/data/common-misspellings-data";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const page = (url: string, head: string, body: string) => {
  const html = `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;
  return { url, html };
};

async function audit(
  pages: Array<{ url: string; html: string }>,
  options: Record<string, unknown> = {},
) {
  const site = {
    baseUrl: pages[0]!.url,
    pages: pages.map((p) => {
      const { document } = parseHTML(p.html);
      return { url: p.url, statusCode: 200, parsed: { document } as unknown as ParsedPage };
    }),
    robotsTxt: null,
    sitemaps: null,
  } as unknown as SiteData;
  const ctx = {
    page: { url: pages[0]!.url, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site,
    options,
  } as unknown as RuleContext;
  return (await commonMisspellingsRule.run(ctx)).checks;
}

const named = (checks: { name: string }[], name: string) => checks.filter((c) => c.name === name);

describe("content/common-misspellings", () => {
  test("a misspelling in a paragraph is an info finding with the URL and a context snippet", async () => {
    const checks = await audit([
      page("https://example.com/a", "", "<p>We will recieve your order soon.</p>"),
    ]);
    const finding = named(checks, "misspelling:recieve");
    expect(finding).toHaveLength(1);
    expect(finding[0]!.status).toBe("info");
    expect(finding[0]!.message).toContain('"recieve" → "receive" on 1 page');
    expect(finding[0]!.items![0]!.id).toBe("https://example.com/a");
    expect(finding[0]!.items![0]!.snippet).toContain("We will recieve your order");
  });

  test("the same misspelling in a title or an h2 is a warning, not info", async () => {
    const inTitle = await audit([
      {
        url: "https://example.com/t",
        html: `<!doctype html><html lang="en"><head><title>Recieve more</title></head><body><p>x</p></body></html>`,
      },
    ]);
    expect(named(inTitle, "misspelling:recieve")[0]!.status).toBe("warn");

    const inHeading = await audit([
      page("https://example.com/h", "", "<h2>Recieve your order</h2>"),
    ]);
    expect(named(inHeading, "misspelling:recieve")[0]!.status).toBe("warn");
  });

  test("a doubled function word is reported; a grammatical repeat is not", async () => {
    const doubled = await audit([
      page("https://example.com/d", "", "<p>Click the the button.</p>"),
    ]);
    expect(named(doubled, "doubled-word:the the")).toHaveLength(1);

    const grammatical = await audit([
      page("https://example.com/g", "", "<p>She had had enough.</p>"),
    ]);
    expect(named(grammatical, "doubled-word:had had")).toHaveLength(0);
    expect(grammatical.some((c) => c.name.startsWith("doubled-word"))).toBe(false);

    // "What it is is", "as as", "in in", "it it", "on on" and "at at" can be
    // grammatical, so these six are never reported.
    const allowed = await audit([
      page(
        "https://example.com/q",
        "",
        "<p>What it is is simple. Keep as as small as you can. Log in in seconds. Make it it. " +
          "Turn it on on startup. Look at at least two.</p>",
      ),
    ]);
    expect(allowed.some((c) => c.name.startsWith("doubled-word"))).toBe(false);
  });

  test("pages in another language, pages without lang, and foreign spans are not checked", async () => {
    const de = await audit([
      {
        url: "https://example.com/de",
        html: `<!doctype html><html lang="de"><head><title>T</title></head><body><p>recieve</p></body></html>`,
      },
    ]);
    expect(de.some((c) => c.name.startsWith("misspelling"))).toBe(false);

    const noLang = await audit([
      {
        url: "https://example.com/nl",
        html: `<!doctype html><html><head><title>T</title></head><body><p>recieve</p></body></html>`,
      },
    ]);
    expect(noLang.some((c) => c.name.startsWith("misspelling"))).toBe(false);

    const span = await audit([
      page("https://example.com/s", "", '<p>Bonjour. <span lang="fr">recieve</span></p>'),
    ]);
    expect(span.some((c) => c.name.startsWith("misspelling"))).toBe(false);
  });

  test("code, preformatted, keyboard, translate=no and spellcheck=false text is never checked", async () => {
    const checks = await audit([
      page(
        "https://example.com/x",
        "",
        "<p><code>recieve</code> <pre>recieve</pre> <kbd>recieve</kbd></p>" +
          '<p translate="no">recieve</p><p spellcheck="false">recieve</p>',
      ),
    ]);
    expect(checks.some((c) => c.name.startsWith("misspelling"))).toBe(false);
  });

  test("URLs, email addresses, ALL CAPS, mixed case and mid-sentence capitals are not checked", async () => {
    const checks = await audit([
      page(
        "https://example.com/y",
        "",
        "<p>See https://example.com/recieve and mail recieve@example.com.</p>" +
          "<p>The RECIEVE button, the iRecieve app and visit Recieve Street.</p>",
      ),
    ]);
    expect(checks.some((c) => c.name.startsWith("misspelling"))).toBe(false);
  });

  test("URLs and emails inside punctuation are still skipped, without a whole-text regex", async () => {
    const checks = await audit([
      page(
        "https://example.com/u",
        "",
        "<p>(https://example.com/recieve), <recieve@example.com> and www.recieve.example.</p>",
      ),
    ]);
    expect(checks.some((c) => c.name.startsWith("misspelling"))).toBe(false);
  });

  test("one long unbroken run of text scans in linear time (no regex backtracking)", async () => {
    // 160 KB with no space: the old `\S+@\S+` span regex took seconds on this.
    const run = "a".repeat(160_000);
    const started = performance.now();
    const checks = await audit([page("https://example.com/long", "", `<p>${run} recieve</p>`)]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(named(checks, "misspelling:recieve")).toHaveLength(1);
  });

  test("a word the body capitalises mid-sentence is a name, judged nowhere on the page", async () => {
    const name = await audit([
      {
        url: "https://example.com/k",
        html: `<!doctype html><html lang="en"><head><title>Kelsey Grammer</title></head><body><h1>Grammer at home</h1><p>Grammer in 2026.</p><p>The actor Kelsey Grammer won.</p></body></html>`,
      },
    ]);
    expect(name.some((c) => c.name.startsWith("misspelling"))).toBe(false);

    const typo = await audit([
      {
        url: "https://example.com/g",
        html: `<!doctype html><html lang="en"><head><title>Grammer tips</title></head><body><p>Good grammer matters.</p></body></html>`,
      },
    ]);
    expect(named(typo, "misspelling:grammer")[0]!.status).toBe("warn");
  });

  test("a breadcrumb, link or button echoing a misspelt title does not excuse it", async () => {
    const page = (body: string) => ({
      url: "https://example.com/e",
      html: `<!doctype html><html lang="en"><head><title>Accomodation in Paris</title></head><body><h1>Shiping Policy</h1>${body}</body></html>`,
    });
    for (const echo of [
      '<div class="breadcrumbs"><a href="/">Home</a> › <a href="/a">Accomodation</a></div>',
      '<p>Read our <a href="/s">Shiping Policy</a> and our <a href="/a">Accomodation</a> guide.</p>',
      "<p><button>Book Now</button> <button>Accomodation</button> <button>Shiping</button></p>",
      "<nav><span>See Accomodation and Shiping</span></nav>",
    ]) {
      const checks = await audit([page(echo)]);
      expect(named(checks, "misspelling:accomodation")[0]?.status).toBe("warn");
      expect(named(checks, "misspelling:shiping")[0]?.status).toBe("warn");
    }
  });

  test("a capitalised word after an opening bracket is a name, not a sentence start", async () => {
    const checks = await audit([
      page("https://example.com/b", "", "<p>See the portrait (Teh Collection) here.</p>"),
    ]);
    expect(checks.some((c) => c.name.startsWith("misspelling"))).toBe(false);
  });

  test("a <title> in another language is not checked", async () => {
    const checks = await audit([
      {
        url: "https://example.com/fr",
        html: `<!doctype html><html lang="en"><head><title lang="fr">Recieve</title></head><body><p>x</p></body></html>`,
      },
    ]);
    expect(checks.some((c) => c.name.startsWith("misspelling"))).toBe(false);
  });

  test("meta severity is warning, so a misspelt title reports as a warning", () => {
    expect(commonMisspellingsRule.meta.severity).toBe("warning");
  });

  test("more than 50 distinct findings: the rest are counted in an info note", async () => {
    const words = COMMON_MISSPELLINGS.split("\n")
      .filter(Boolean)
      .slice(0, 55)
      .map((line) => line.split(" ")[0]!);
    // Spread over pages so the per-page occurrence cap does not hide any.
    const pages = words.map((w, n) =>
      page(`https://example.com/w${n}`, "", `<p>The ${w} here.</p>`),
    );
    const checks = await audit(pages);
    expect(checks.filter((c) => c.name.startsWith("misspelling:"))).toHaveLength(50);
    const note = named(checks, "common-misspellings-truncated")[0];
    expect(note?.status).toBe("info");
    expect(note?.message).toContain(
      `${words.length - 50} more misspelled or doubled word(s) not listed`,
    );
  });

  test("British and American spelling variants are not reported", async () => {
    const checks = await audit([
      page("https://example.com/v", "", "<p>Our colour palette and how we organise work.</p>"),
    ]);
    expect(checks.some((c) => c.name.startsWith("misspelling"))).toBe(false);
  });

  test("the same misspelling on several pages is one finding with a page count and capped examples", async () => {
    const pages = [1, 2, 3, 4, 5].map((n) =>
      page(`https://example.com/p${n}`, "", "<p>We will recieve it.</p>"),
    );
    const checks = await audit(pages);
    const finding = named(checks, "misspelling:recieve");
    expect(finding).toHaveLength(1);
    expect(finding[0]!.message).toContain("on 5 pages");
    expect(finding[0]!.items!.length).toBeLessThanOrEqual(5);
  });

  test("a word in ignore_words is never reported", async () => {
    const pages = [page("https://example.com/i", "", "<p>We will recieve it.</p>")];
    const checks = await audit(pages, { ignore_words: ["recieve"] });
    expect(checks.some((c) => c.name.startsWith("misspelling"))).toBe(false);
  });

  test("a clean English site passes", async () => {
    const checks = await audit([
      page("https://example.com/c", "", "<p>We will receive your order.</p>"),
    ]);
    expect(checks).toEqual([
      expect.objectContaining({ name: "common-misspellings", status: "pass" }),
    ]);
  });
});

describe("content/common-misspellings on the streamed path", () => {
  test("the rule aggregates the page-time scan from collectedSignals, with no DOM", async () => {
    const { scanPageForMisspellings } = await import("../src/content/common-misspellings");
    const english = parseHTML(
      page("https://example.com/s1", "", "<p>We will recieve it.</p>").html,
    ).document;
    const german = parseHTML(
      `<!doctype html><html lang="de"><head><title>T</title></head><body><p>recieve</p></body></html>`,
    ).document;
    const ctx = {
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: {
        baseUrl: "https://example.com/",
        pages: [],
        robotsTxt: null,
        sitemaps: null,
      } as unknown as SiteData,
      collectedSignals: {
        pages: [
          { url: "https://example.com/s1", misspellings: scanPageForMisspellings(english) },
          { url: "https://example.com/de", misspellings: scanPageForMisspellings(german) },
        ],
      },
      options: {},
    } as unknown as RuleContext;
    const checks = (await commonMisspellingsRule.run(ctx)).checks;
    const finding = named(checks, "misspelling:recieve");
    expect(finding).toHaveLength(1);
    expect(finding[0]!.message).toContain("on 1 page");
    expect(finding[0]!.items![0]!.id).toBe("https://example.com/s1");
  });
});

describe("content/common-misspellings per-page caps", () => {
  /** The first `n` misspellings in the bundled list, all plain lowercase words. */
  const listed = (n: number) =>
    COMMON_MISSPELLINGS.split("\n")
      .filter(Boolean)
      .slice(0, n)
      .map((line) => line.split(" ")[0]!);
  const scan = (head: string, body: string) =>
    scanPageForMisspellings(
      parseHTML(
        `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`,
      ).document,
    ).occurrences;

  test("misspelt headings past their quota stop scanning and cannot crowd out the body", () => {
    const words = listed(40);
    const headings = words
      .slice(0, 30)
      .map((w) => `<h2>${w}</h2>`)
      .join("");
    const body = words
      .slice(30)
      .map((w) => `<p>We ${w} it.</p>`)
      .join("");
    const found = scan("", headings + body);
    expect(found.filter((o) => o.prominent)).toHaveLength(25);
    // Thirty misspelt headings, yet exactly the ten body words are body findings:
    // the headings past their quota are not read again as body copy.
    expect(found.filter((o) => !o.prominent).map((o) => o.word)).toEqual(words.slice(30));
  });

  test("sixty misspelt headings leave the body's whole quota to the body", () => {
    const words = listed(70);
    const headings = words
      .slice(0, 60)
      .map((w) => `<h2>${w}</h2>`)
      .join("");
    const body = words
      .slice(60)
      .map((w) => `<p>We ${w} it.</p>`)
      .join("");
    const found = scan("", headings + body);
    expect(found).toHaveLength(35);
    expect(found.filter((o) => !o.prominent).map((o) => o.word)).toEqual(words.slice(60));
  });

  test("the cap is strict: recording stops at exactly the quota, doubled words included", () => {
    const words = listed(24);
    const found = scan("", `<p>${words.map((w) => `we ${w}`).join(" ")} the the end and and</p>`);
    expect(found).toHaveLength(25);
    expect(found.filter((o) => o.kind === "doubled").map((o) => o.word)).toEqual(["the the"]);
  });

  test("a word repeated on a page counts once against the quota", () => {
    const words = listed(10);
    const body = `<p>${"we recieve ".repeat(200)}${words.map((w) => `we ${w}`).join(" ")}</p>`;
    const found = scan("", body);
    expect(found.filter((o) => o.word === "recieve")).toHaveLength(1);
    for (const w of words) expect(found.some((o) => o.word === w)).toBe(true);
  });

  test("code and foreign-language text inside a heading are not judged", () => {
    const found = scan(
      "",
      '<h2>Use <code>teh</code> flag</h2><h3>Le <span lang="fr">recieve</span></h3><h2>We recieve</h2>',
    );
    expect(found).toEqual([expect.objectContaining({ word: "recieve", prominent: true })]);
    expect(found[0]!.context).toBe("We recieve");
  });

  test("a word in the title and the body is one prominent occurrence", () => {
    const found = scan("", "<p>We recieve it.</p>");
    expect(found).toEqual([expect.objectContaining({ word: "recieve", prominent: false })]);
    const both = scanPageForMisspellings(
      parseHTML(
        `<!doctype html><html lang="en"><head><title>Recieve</title></head><body><p>We recieve it.</p></body></html>`,
      ).document,
    ).occurrences;
    expect(both).toEqual([expect.objectContaining({ word: "recieve", prominent: true })]);
  });
});

describe("content/common-misspellings bundled data", () => {
  test("the data is one plain string of sorted, unique lowercase pairs", () => {
    const lines = COMMON_MISSPELLINGS.split("\n").filter(Boolean);
    // Pinned so an accidental truncation or a pasted-in list shows up in review.
    expect(lines.length).toBe(523);
    for (const line of lines) expect(line).toMatch(/^[a-z]+ [a-z]+$/);
    const keys = lines.map((line) => line.split(" ")[0]!);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
    expect(lines).toContain("recieve receive");
  });

  test("the rule loads it from a TypeScript module, with no JSON import or import attribute", async () => {
    // Every runtime that imports the rules (compiled CLI, test runner, a Workers
    // bundle) loads a string literal the same way; an import attribute is not.
    const source = await Bun.file(
      new URL("../src/content/common-misspellings.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(/\bwith\s*\{\s*type:/);
    expect(source).not.toMatch(/from\s+["'][^"']*\.json["']/);
  });
});
