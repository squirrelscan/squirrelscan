// content/h1-title-alignment (pub#929): the H1 and the title share no meaningful word.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { stem, h1TitleAlignmentRule } from "../src/content/h1-title-alignment";
import type { ParsedPage, RuleContext } from "../src/types";

function run(opts: {
  title: string;
  h1: string[];
  lang?: string | null;
  url?: string;
  siteName?: string;
}): CheckResult {
  const url = opts.url ?? "https://example.com/blog/post";
  const lang = opts.lang === null ? "" : ` lang="${opts.lang ?? "en"}"`;
  const site = opts.siteName ? `<meta property="og:site_name" content="${opts.siteName}">` : "";
  const html = `<!doctype html><html${lang}><head><title>${opts.title}</title>${site}</head><body>${opts.h1
    .map((h) => `<h1>${h}</h1>`)
    .join("")}<p>text</p></body></html>`;
  const out = h1TitleAlignmentRule.run({
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  } as RuleContext);
  if (out instanceof Promise) throw new Error("sync rule");
  expect(out.checks).toHaveLength(1);
  return out.checks[0] as CheckResult;
}

describe("the issue's fixtures", () => {
  test("a title and H1 about different things warn, showing both strings", () => {
    const c = run({
      title: "Reddit Visibility Services, SEO &amp; AI Search | Brand",
      // The issue's H1 also says "AI", which the title carries as-is: an all-caps pair is an
      // acronym naming the subject, so it counts as shared. The warning case drops it.
      h1: ["Be recommended and showed on Google"],
      url: "https://example.com/blog/post",
    });
    expect(c.status).toBe("info");
    expect((c.details as { confident: boolean }).confident).toBe(true);
    expect(c.name).toBe("h1-title-alignment");
    const text = JSON.stringify(c);
    expect(text).toContain("Reddit Visibility Services, SEO & AI Search | Brand");
    expect(text).toContain("Be recommended and showed on Google");
  });

  test("stemming and brand stripping: running shoes passes", () => {
    const c = run({ title: "Running Shoes for Women | Brand", h1: ["Women's running shoe guide"] });
    expect(c.status).toBe("pass");
  });

  test("no H1, or two H1s: skipped, no finding", () => {
    expect(run({ title: "Running Shoes for Women", h1: [] }).status).toBe("skipped");
    expect(run({ title: "Running Shoes for Women", h1: ["One heading", "Another heading"] }).status).toBe("skipped");
  });

  test("a language with no stopword list is skipped, not passed", () => {
    for (const lang of ["ja", "zh-CN", "ru", "ko", "ar", null]) {
      const c = run({ title: "料金プランと価格表", h1: ["サービスのご案内"], lang });
      expect(c.status).toBe("skipped");
    }
  });

  test("identical title and H1 is at most info", () => {
    const c = run({ title: "Running Shoes for Women", h1: ["Running Shoes for Women"] });
    expect(c.status).toBe("info");
  });
});

describe("false-positive guards", () => {
  test("the brand does not count as the only shared word in the stripped title, but a shared brand word passes", () => {
    expect(run({ title: "Pricing plans | Acme", h1: ["Acme pricing"] }).status).toBe("pass");
  });

  test("a title that is only the brand is skipped", () => {
    expect(run({ title: "Squirrelscan", h1: ["Audit your website today"], url: "https://squirrelscan.com/x" }).status).toBe("skipped");
    expect(run({ title: "Acme", h1: ["Audit your website today"], siteName: "Acme" }).status).toBe("skipped");
  });

  test("a brand segment named by the host is not counted as a title word", () => {
    // `Squirrelscan` names the site, so the title keeps one content word: too few to judge.
    const c = run({ title: "Audits | Squirrelscan", h1: ["Check every page"], url: "https://squirrelscan.com/x" });
    expect(c.status).toBe("skipped");
  });

  test("too few content words on either side is skipped, not warned", () => {
    expect(run({ title: "Pricing", h1: ["Plans and billing"] }).status).toBe("skipped");
    expect(run({ title: "Pricing plans and billing", h1: ["Welcome"] }).status).toBe("skipped");
  });

  test("the homepage is info, never a warning", () => {
    const c = run({
      title: "Reddit Visibility Services, SEO &amp; AI Search | Brand",
      h1: ["Be recommended and showed on Google"],
      url: "https://example.com/",
    });
    expect(c.status).toBe("info");
  });

  test("numbers and stopwords never count as shared words", () => {
    const c = run({ title: "Top 10 guides for new owners | Acme", h1: ["10 things to know about the web"] });
    expect(c.status).not.toBe("pass");
  });

  test("case, diacritics and punctuation do not hide a shared word", () => {
    expect(run({ title: "Crème brûlée recipes | Acme", h1: ["Easy CREME BRULEE, step by step"] }).status).toBe("pass");
  });

  test("other supported languages", () => {
    expect(run({ title: "Schuhe für Damen kaufen | Marke", h1: ["Damenschuhe und Schuhe im Angebot"], lang: "de" }).status).toBe("pass");
    expect(run({ title: "Zapatillas de running para mujer | Marca", h1: ["Nuestra historia como empresa familiar"], lang: "es", url: "https://example.com/blog/x" }).details).toMatchObject({ confident: true });
    expect(run({ title: "Chaussures de course pour femme | Marque", h1: ["Les chaussures de course les plus légères"], lang: "fr-CA" }).status).toBe("pass");
  });
});

describe("stem", () => {
  test("light stemming", () => {
    expect(stem("services", "en")).toBe(stem("service", "en"));
    expect(stem("running", "en")).toBe(stem("run", "en"));
    expect(stem("recommended", "en")).toBe(stem("recommend", "en"));
    expect(stem("boxes", "en")).toBe("box");
    expect(stem("class", "en")).toBe("class");
    expect(stem("policies", "en")).toBe("policy");
  });
});

describe("precision fixes (review of #1024)", () => {
  const miss = { title: "Reddit Visibility Services, SEO &amp; AI Search | Brand", h1: ["Be recommended and showed on Google"] };

  test("localized roots, index files and the root are the homepage: info", () => {
    for (const path of ["/", "/de", "/de/", "/pt-br/", "/en_gb", "/index.html", "/de/index.php"]) {
      expect((run({ ...miss, url: `https://example.com${path}` }).details as { pageKind?: string }).pageKind).toBe("home");
    }
    expect(run({ ...miss, url: "https://example.com/de/blog" }).details).not.toHaveProperty("pageKind");
    expect(run({ ...miss, url: "https://example.com/blog/post" }).details).toMatchObject({ confident: true });
    for (const path of ["/", "/de/", "/index.html"]) {
      expect(run({ ...miss, url: `https://example.com${path}` }).details).toMatchObject({ pageKind: "home", confident: false });
    }
  });

  test("generic marketing pages are info, with the reason in the details", () => {
    for (const path of ["/about", "/pricing", "/features/", "/contact", "/faq", "/services", "/company", "/team", "/support", "/help", "/en/about", "/de/preise", "/kontakt"]) {
      const c = run({ ...miss, url: `https://example.com${path}` });
      expect(c.status).toBe("info");
      expect((c.details as { pageKind?: string }).pageKind).toBe("marketing");
    }
    // Subpages of them, and article or product paths, are the confident cases.
    for (const path of ["/pricing/enterprise-plan", "/blog/pricing", "/products/shoe"]) {
      const c = run({ ...miss, url: `https://example.com${path}` });
      expect(c.details).toMatchObject({ confident: true });
      expect(c.details).not.toHaveProperty("pageKind");
    }
    // A shallow page is info, never confident.
    expect(run({ ...miss, url: "https://example.com/landing" }).details).toMatchObject({ confident: false });
  });

  test("an all-caps pair (AI, UX, EA) is a word; a lower-case pair is not", () => {
    expect(run({ title: "Hiring AI engineers | Acme", h1: ["Why AI matters now for teams"] }).status).toBe("pass");
    expect(run({ title: "Hiring ai engineers | Acme", h1: ["Why ai matters now for teams"] }).status).not.toBe("pass");
  });

  test("silent e, -ing and irregular plurals meet", () => {
    expect(run({ title: "Pricing for teams | Acme", h1: ["Our price list"] }).status).toBe("pass");
    expect(run({ title: "Making coffee at home | Acme", h1: ["How to make better espresso"] }).status).toBe("pass");
    expect(run({ title: "Hiring developers fast | Acme", h1: ["We hire remote engineers"] }).status).toBe("pass");
    expect(run({ title: "Dresses for women | Acme", h1: ["The woman who wears silk"] }).status).toBe("pass");
  });

  test("a German head-last compound meets its head", () => {
    const c = run({ title: "Damenschuhe online kaufen | Marke", h1: ["Schuhe für jeden Tag"], lang: "de" });
    expect(c.status).toBe("pass");
  });

  test("sharing only a generic word is not a match", () => {
    const c = run({ title: "Free online invoice tool for freelancers | Acme", h1: ["Free payments made simple for freelance teams"], url: "https://example.com/blog/x" });
    expect(c.status).toBe("pass");
    // Only generic words shared (free, online): no match.
    const d = run({ title: "Free online invoice generator for freelancers | Acme", h1: ["Free online payments made simple today"], url: "https://example.com/blog/x" });
    expect(d.status).toBe("info");
    expect(d.name).toBe("h1-title-alignment");
  });

  test("a mostly non-Latin title or H1 under a Latin stopword language is skipped", () => {
    expect(run({ title: "料金プランの比較 | Acme", h1: ["サービスのご案内と価格"], lang: "en" }).status).toBe("skipped");
  });

  test("run-together heading text is skipped, not judged; a camel-case brand on both sides is not", () => {
    expect(run({ title: "Teacher Mentor Attestation | SkillStory", h1: ["Achievements Become TrustedWhen Educators Back Them."], url: "https://example.com/blog/x" }).status).toBe("skipped");
    expect(run({ title: "WordPress themes for makers | Acme", h1: ["A WordPress theme you will love"], url: "https://example.com/blog/x" }).status).toBe("pass");
  });

  test("a 15,000-word heading and title stay fast", () => {
    const words = Array.from({ length: 15000 }, (_, i) => `alpha${i.toString(36)}beta`).join(" ");
    const started = performance.now();
    run({ title: `${words} | Acme`, h1: [words.split("").reverse().join("")], url: "https://example.com/blog/x" });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
