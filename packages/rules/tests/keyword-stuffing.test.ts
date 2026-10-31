// content/keyword-stuffing — function-word stopwords + repeated CTA label
// exclusion (#695). Before this fix, generic function words ("get", "your")
// and repeated short CTA/button labels ("Learn more" x11 cards) tripped the
// density check on ordinary pages. Real prose stuffing must still flag.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { keywordStuffingRule, keywordTokens } from "../src/content/keyword-stuffing";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(html: string, options: Record<string, unknown> = {}): RuleContext {
  const doc = parseHTML(html).document;
  return {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: doc } as unknown as ParsedPage,
    options,
  } as unknown as RuleContext;
}

// Distinct low-frequency filler words (each capped at 5 repeats — at or
// below `min_occurrences`) so padding content never trips density itself.
const FILLER_BANK = [
  "zephyr",
  "quokka",
  "tundra",
  "basalt",
  "ember",
  "glacier",
  "meadow",
  "canyon",
  "harbor",
  "lattice",
  "marble",
  "nectar",
  "orchid",
  "pebble",
  "quartz",
  "ripple",
  "sable",
  "thicket",
  "umbra",
  "velvet",
  "willow",
  "xenial",
  "yonder",
  "zabra",
  "amber",
  "brisk",
  "cedar",
  "dune",
  "flint",
  "grove",
];

function filler(wordCount: number): string {
  return Array.from({ length: wordCount }, (_, i) => FILLER_BANK[i % FILLER_BANK.length]).join(" ");
}

describe("content/keyword-stuffing false-positive fixes (#695)", () => {
  test("'get' used heavily as a generic verb does not flag", () => {
    const html = `<html><body><p>${"get ".repeat(10)}${filler(120)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("'your' used heavily on a privacy-policy-style page does not flag", () => {
    const html = `<html><body><p>${"your ".repeat(10)}${filler(120)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("11 repeated 'Learn more' CTA links do not flag 'learn'", () => {
    // Real templated markup always has whitespace/newlines between sibling
    // cards; joining with "\n" keeps word tokenization realistic (adjacent
    // elements with zero separator would merge into a bogus compound token).
    const cards = Array.from(
      { length: 11 },
      () => `<div class="card"><a href="/x">Learn more</a></div>`,
    ).join("\n");
    const html = `<html><body>${cards}<p>${filler(120)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("true positive: real prose keyword stuffing outside CTAs still flags", () => {
    const html = `<html><body><p>${"widget ".repeat(30)}${filler(90)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((i) => i.id === "widget")).toBe(true);
  });

  test("true positive: CTA exclusion does not mask unrelated prose stuffing on the same page", () => {
    const cards = Array.from(
      { length: 11 },
      () => `<div class="card"><a href="/x">Learn more</a></div>`,
    ).join("\n");
    const html = `<html><body>${cards}<p>${"widget ".repeat(30)}${filler(90)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((i) => i.id === "widget")).toBe(true);
    expect(checks[0].items?.some((i) => i.id === "learn")).toBe(false);
  });

  test("review regression: nested <a><button> CTA counts once, so stuffing isn't masked", () => {
    // Each card matches BOTH the <a> and the <button>; double-counting the
    // label would over-deduct and could zero out organicTotal, silently
    // skipping the scan of the genuinely stuffed word below.
    const cards = Array.from(
      { length: 20 },
      () => `<div class="card"><a href="/x"><button>Learn more</button></a></div>`,
    ).join("\n");
    const html = `<html><body>${cards}<p>${"widget ".repeat(30)}${filler(60)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((i) => i.id === "widget")).toBe(true);
    expect(checks[0].items?.some((i) => i.id === "learn")).toBe(false);
  });

  test("true positive: repeated COMMERCIAL anchor text (not a generic CTA) still flags", () => {
    // The CTA exclusion is an allowlist of known boilerplate phrases, not
    // "any repeated short anchor text" — a spam/doorway page repeating a
    // real target keyword as a link label must still count fully.
    const links = Array.from(
      { length: 11 },
      () => `<div class="card"><a href="/plumber">Emergency Plumber</a></div>`,
    ).join("\n");
    const html = `<html><body>${links}<p>${filler(100)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((i) => i.id === "emergency")).toBe(true);
    expect(checks[0].items?.some((i) => i.id === "plumber")).toBe(true);
  });

  test("whitelist option still suppresses a configured brand/keyword", () => {
    const html = `<html><body><p>${"widget ".repeat(30)}${filler(90)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html, { whitelist: ["widget"] }));
    expect(checks[0].status).toBe("pass");
  });
});

describe("content/keyword-stuffing language stop words (#1042)", () => {
  test.each([
    ["de-DE", "und"],
    ["es", "para"],
    ["fr", "avec"],
    ["pt-BR", "para"],
    ["it", "della"],
    ["nl", "voor"],
  ])("%s excludes its own function word %p", (lang, word) => {
    const html = `<html lang="${lang}"><body><p>${`${word} `.repeat(30)}${filler(120)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("the German reproduction excludes its stop words", () => {
    const paragraph =
      "Hier findest du alles für den Sommer, alles aus weicher Baumwolle. " +
      "Unsere Shirts kommen aus fairer Produktion und halten lange. " +
      "Wähle aus vielen Farben die Bademode, die zu dir passt. " +
      "Versand und Rückgabe sind kostenlos, die Lieferung dauert zwei Tage. " +
      "Die Stoffe stammen aus Portugal, genäht wird in kleinen Werkstätten. " +
      "Pflegehinweise findest du auf jedem Etikett und in unserem Ratgeber.";
    const html = `<html lang="de"><body><p>${paragraph.repeat(12)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    const reported = new Set(checks[0].items?.map((item) => item.id));
    for (const stopWord of ["alles", "aus", "die", "und"]) {
      expect(reported.has(stopWord)).toBe(false);
    }
  });

  test("a German content word over the threshold is still reported", () => {
    const html = `<html lang="de"><body><p>${"bademode ".repeat(30)}${filler(120)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === "bademode")).toBe(true);
  });

  test.each(["", "x-default", "und", "mul", "zxx", "xx", "qaa"])(
    "%p keeps the English common-word exclusions when it has no usable function-word list",
    (lang) => {
      const html = `<html lang="${lang}"><body><p>${"the ".repeat(30)}${filler(120)}</p></body></html>`;
      const { checks } = keywordStuffingRule.run(ctx(html));
      expect(checks[0].status).toBe("pass");
    },
  );

  test.each(["en-GB", "EN", "en_US"])("%p keeps the English price-note exclusions", (lang) => {
    const html = `<html lang="${lang}"><body><p>${"VAT ".repeat(30)}${filler(120)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test.each(["ja", "pl", "tr", "sv", "cs", "id", "vi"])(
    "%p still detects Latin-script stuffing without its own function-word list",
    (lang) => {
      const html = `<html lang="${lang}"><body><p>${"widget ".repeat(30)}${filler(120)}</p></body></html>`;
      const { checks } = keywordStuffingRule.run(ctx(html));
      expect(checks[0].status).toBe("warn");
      expect(checks[0].items?.some((item) => item.id === "widget")).toBe(true);
    },
  );

  test("an unsupported lang alone cannot turn off Latin-script stuffing detection", () => {
    const html = `<html lang="ru"><body><p>${"widget ".repeat(30)}${filler(120)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === "widget")).toBe(true);
  });

  test("a natural Russian paragraph is not judged without a Russian function-word list", () => {
    const paragraph =
      "Городская библиотека открывает новые залы для читателей, которые хотят спокойно работать, изучать архивы и обсуждать книги с друзьями. " +
      "По утрам сотрудники готовят столы для студентов, которым нужны справочники, редкие журналы, карты и удобные места рядом с окнами. " +
      "После обеда приходит семейная группа для занятий, где дети слушают рассказы, рисуют героев и выбирают произведения на следующую неделю. " +
      "В отдельной комнате проходят встречи для исследователей, которые делятся результатами, задают вопросы и помогают коллегам находить надежные источники. " +
      "Небольшая студия создана для музыкантов, желающих записывать подкасты, читать стихи и сохранять устные воспоминания жителей старого района. " +
      "Во дворе устроили сад для соседей, где волонтеры выращивают травы, проводят лекции о природе и отдыхают после долгой прогулки. " +
      "Электронный каталог полезен для посетителей, которые заранее проверяют наличие изданий, бронируют материалы и продлевают срок возврата через сайт. " +
      "Зимой сотрудники организуют курсы для пожилых людей, объясняя безопасную работу с почтой, видеосвязью, государственными услугами и цифровыми фотографиями. " +
      "Весной библиотека приглашает переводчиков для открытых бесед, на которых звучат современные тексты, местные истории и голоса разных поколений. " +
      "Каждый проект задуман для сообщества, поэтому программа меняется после опросов, личных разговоров и внимательного анализа предложений постоянных гостей.";
    expect(keywordTokens(paragraph).length).toBeGreaterThanOrEqual(150);
    const html = `<html lang="ru-RU"><body><p>${paragraph}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).not.toBe("warn");
    expect(checks[0]).toMatchObject({
      status: "skipped",
      message: "Most content uses a script without a function-word list",
    });
  });
});

describe("content/keyword-stuffing main copy and Unicode words (#1182)", () => {
  test("navigation and header links outside main content do not affect density", () => {
    const links = Array.from(
      { length: 20 },
      (_, index) => `<a href="/${index}">Bademode ${FILLER_BANK[index]}</a>`,
    ).join("\n");
    const html = `<html lang="de"><body><header><nav>${links}</nav></header><main><p>${filler(120)}</p></main></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
    expect(checks[0].items?.some((item) => item.id === "bademode")).not.toBe(true);
  });

  test("commercial anchor text inside main content still flags", () => {
    const links = Array.from({ length: 12 }, () => '<a href="/plumber">Emergency Plumber</a>').join(
      "\n",
    );
    const html = `<html><body><header><nav><a href="/">Home</a></nav></header><main>${links}<p>${filler(100)}</p></main></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === "plumber")).toBe(true);
  });

  test("a thin main falls back to substantial body copy", () => {
    const html = `<html><body><main><p>Short introduction only</p></main><section><p>${"widget ".repeat(20)}${filler(120)}</p></section></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === "widget")).toBe(true);
  });

  test("the largest substantial main landmark is measured", () => {
    const html = `<html><body><main><p>${filler(100)}</p></main><main><p>${"widget ".repeat(20)}${filler(100)}</p></main></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === "widget")).toBe(true);
  });

  test("thousands of nested main landmarks stay within a bounded scan", { timeout: 30_000 }, () => {
    const depth = 5_000;
    const html = `<html><body>${"<main>".repeat(depth)}<p>${filler(120)}</p>${"</main>".repeat(depth)}</body></html>`;
    const context = ctx(html);
    const started = performance.now();
    const { checks } = keywordStuffingRule.run(context);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(checks[0].status).toBe("pass");
  });

  test("a listing without main keeps every article", () => {
    const html = `<html><body><article><p>${filler(100)}</p></article><article><p>${"widget ".repeat(20)}${filler(20)}</p></article></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === "widget")).toBe(true);
  });

  test("an article inside a sidebar is not selected as the page's main copy", () => {
    const html = `<html><body><aside><article><p>${filler(100)}</p></article></aside><section><p>${"widget ".repeat(20)}${filler(100)}</p></section></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === "widget")).toBe(true);
  });

  test("a thin sole article falls back to the rest of the body", () => {
    const html = `<html><body><article><p>Short article</p></article><section><p>${"widget ".repeat(20)}${filler(120)}</p></section></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === "widget")).toBe(true);
  });

  test("article headers remain part of body-fallback copy", () => {
    const html = `<html><body><header>${"global ".repeat(30)}</header><article><header>${"widget ".repeat(20)}</header><p>${filler(100)}</p></article><article><p>${filler(20)}</p></article></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === "widget")).toBe(true);
    expect(checks[0].items?.some((item) => item.id === "global")).not.toBe(true);
  });

  test("umlauts, ß and decomposed letters stay in one normalized word", () => {
    expect(keywordTokens("gemäß gema\u0308ß Straße")).toEqual(["gemäß", "gemäß", "straße"]);
    const html = `<html lang="de"><body><main><p>${"gemäß ".repeat(15)}${filler(120)}</p></main></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].items?.some((item) => item.id === "gemäß")).toBe(true);
    expect(checks[0].items?.some((item) => item.id === "gem")).toBe(false);
  });

  test("German price-note boilerplate is ignored", () => {
    const notes = "inkl MwSt zzgl Versandkosten ".repeat(12);
    const html = `<html lang="de"><body><main><p>${notes}${filler(120)}</p></main></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test("English price-note boilerplate is ignored", () => {
    const html = `<html lang="en"><body><main><p>${"incl VAT ".repeat(12)}${filler(120)}</p></main></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("pass");
  });

  test.each(["incl", "VAT"])("German copy does not ignore the English price term %p", (word) => {
    const html = `<html lang="de"><body><main><p>${`${word} `.repeat(20)}${filler(120)}</p></main></body></html>`;
    const { checks } = keywordStuffingRule.run(ctx(html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((item) => item.id === word.toLowerCase())).toBe(true);
  });

  test.each(["incl", "VAT"])(
    "German body-fallback copy does not ignore the English price term %p",
    (word) => {
      const html = `<html lang="de"><body><p>${`${word} `.repeat(20)}${filler(120)}</p></body></html>`;
      const { checks } = keywordStuffingRule.run(ctx(html));
      expect(checks[0].status).toBe("warn");
      expect(checks[0].items?.some((item) => item.id === word.toLowerCase())).toBe(true);
    },
  );

  test("a token longer than the item limit is ignored instead of split", () => {
    const longToken = "ä".repeat(80);
    expect(keywordTokens(`${longToken} normal`)).toEqual(["normal"]);
  });

  test("compatibility normalization is bounded to one short token", () => {
    expect(keywordTokens("ａｃｍｅ ﬀoo gemäß")).toEqual(["acme", "ffoo", "gemäß"]);
    expect(keywordTokens(`${"\uFDFA.".repeat(2_000)} normal`)).toEqual(["normal"]);
  });

  test("Han, Kana and Hangul runs are not treated as whole words", () => {
    expect(keywordTokens("検索検索 검색검색 カタカナカタカナ normal")).toEqual(["normal"]);
  });
});

describe("content/keyword-stuffing ignores the site's own brand name", () => {
  function siteCtx(url: string, html: string): RuleContext {
    const doc = parseHTML(html).document;
    return {
      page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document: doc } as unknown as ParsedPage,
      options: {},
    } as unknown as RuleContext;
  }
  const launchPage = (name: string, head = "") =>
    `<html><head>${head}</head><body><h1>${name}</h1><p>${`${name} `.repeat(30)}${filler(90)}</p></body></html>`;

  test("a landing page repeating its own domain name does not flag it", () => {
    const { checks } = keywordStuffingRule.run(siteCtx("https://acme.com/", launchPage("Acme")));
    expect(checks[0].status).toBe("pass");
  });

  test("a launch domain prefix or suffix still resolves to the product name", () => {
    for (const url of ["https://getacme.com/", "https://acmehq.io/", "https://www.tryacme.co.uk/"]) {
      const { checks } = keywordStuffingRule.run(siteCtx(url, launchPage("Acme")));
      expect(checks[0].status).toBe("pass");
    }
  });

  test("a multi-word og:site_name carried by the domain is exempt word by word", () => {
    const head = `<meta property="og:site_name" content="Rocket Notes">`;
    const html = `<html><head>${head}</head><body><p>${"rocket notes ".repeat(20)}${filler(90)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(siteCtx("https://rocketnotes.app/", html));
    expect(checks[0].status).toBe("pass");
  });

  test("true positive: a site name the domain does not carry is not a free pass", () => {
    const head = `<meta property="og:site_name" content="Plumber">`;
    const html = `<html><head>${head}</head><body><p>${"plumber ".repeat(30)}${filler(90)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(siteCtx("https://acme.com/", html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.some((i) => i.id === "plumber")).toBe(true);
  });

  test("true positive: other stuffed words on the brand's own page still flag", () => {
    const html = `<html><body><p>${"acme ".repeat(30)}${"widget ".repeat(30)}${filler(90)}</p></body></html>`;
    const { checks } = keywordStuffingRule.run(siteCtx("https://acme.com/", html));
    expect(checks[0].status).toBe("warn");
    expect(checks[0].items?.map((i) => i.id)).toEqual(["widget"]);
  });
});

describe("content/keyword-stuffing: German function words, menu chrome, card microcopy (#1315)", () => {
  const flagged = (html: string): string[] => {
    const check = keywordStuffingRule.run(ctx(html)).checks.find((c) => c.name === "keyword-stuffing");
    return check?.items?.map((i) => i.id) ?? [];
  };
  const page = (lang: string, body: string) => `<html lang="${lang}"><head><title>t</title></head><body>${body}</body></html>`;

  test("German function words are not reported, a content word still is", () => {
    const words = "sie für dich dir deinen deinem deiner ihn ihm";
    const prose = Array.from({ length: 12 }, () => `${words} ${filler(8)}`).join(" ");
    const html = page("de", `<main><p>${prose} ${"zahlung ".repeat(14)}</p></main>`);
    const out = flagged(html);
    for (const w of words.split(" ")) expect(out).not.toContain(w);
    expect(out).toContain("zahlung");
  });

  test("`out` is not reported on an English page", () => {
    const html = page("en", `<main><p>${Array.from({ length: 12 }, () => `out ${filler(8)}`).join(" ")}</p></main>`);
    expect(flagged(html)).not.toContain("out");
  });

  test("a mega menu of plain div links on a page with little copy is not measured", () => {
    const cats = ["bademode", "curvy", "wäsche", "kleider", "röcke", "hosen"];
    const links = Array.from({ length: 60 }, (_, i) => `<a href="/c/${i}">${cats[i % cats.length]} ${["neu", "sale", "alle", "top"][i % 4]}</a>`).join(" ");
    const html = page("de", `<body><div role="menubar"><div>${links}</div></div><div class="copy"><p>Kontakt ${filler(70)}</p></div></body>`);
    expect(flagged(html)).toEqual([]);
  });

  test("the issue's shape: 20 plain-div links repeating one category word, under 100 words of copy (#1315)", () => {
    // Link text built like a mega menu: 20 links, each a different second word, one shared category word.
    const sub = ["damen", "herren", "kinder", "neu", "sale", "top", "alle", "marken", "pflege", "sets", "mehr", "info", "hilfe", "tipps", "wahl", "form", "stil", "farbe", "preis", "test"];
    const links = sub.map((w, i) => `<a href="/c/${i}">bademode ${w}</a>`).join(" ");
    const copy = `<div class="copy"><p>Kontakt ${filler(60)}</p></div>`;
    // No signal at all (no nav, header, role or aria state): the accepted cost. The words count toward density,
    // because a keyword spammer writes the same plain links (docs: "Link menus built without landmarks").
    expect(flagged(page("de", `<body><div>${links}</div>${copy}</body>`))).toContain("bademode");
    // Class and id names are not signals either.
    expect(flagged(page("de", `<body><div class="mega-menu" id="menu">${links}</div>${copy}</body>`))).toContain("bademode");
    // The same links with a real menu signal and a varied set of category words are left out, as the docs say.
    const varied = Array.from({ length: 20 }, (_, i) => `<a href="/c/${i}">${["bademode", "curvy", "wäsche", "kleider", "röcke", "hosen"][i % 6]} ${sub[i]}</a>`).join(" ");
    expect(flagged(page("de", `<body><div role="menubar">${varied}</div>${copy}</body>`))).toEqual([]);
    // The reporter's real mega-menu shape: varied labels in plain divs, no signal. Still counted (the signal gate
    // is what separates it from the menubar case above, not the labels).
    // One category word (repeated in its label) on a quarter of the links stays under the keyword-cloud share, so only the signal decides.
    const quarter = Array.from({ length: 20 }, (_, i) => `<a href="/c/${i}">${["bademode bademode bademode bademode", "curvy", "wäsche", "kleider"][i % 4]} ${sub[i]}</a>`).join(" ");
    expect(flagged(page("de", `<body><div role="menubar">${quarter}</div>${copy}</body>`))).toEqual([]);
    expect(flagged(page("de", `<body><div>${quarter}</div>${copy}</body>`))).toContain("bademode");
    expect(flagged(page("de", `<body><div class="mega-menu" id="menu">${quarter}</div>${copy}</body>`))).toContain("bademode");
    // A shared word is a keyword cloud even with the signal, so the issue's literal shape is counted by design.
    expect(flagged(page("de", `<body><div role="menubar">${links}</div>${copy}</body>`))).toContain("bademode");
  });

  test("true positive: one anchor repeated 20 times is not a menu, it still flags", () => {
    const links = Array.from({ length: 20 }, () => `<a href="/p">emergency plumber</a>`).join(" ");
    const html = page("en", `<body><div>${links}</div><p>${filler(60)}</p></body>`);
    expect(flagged(html)).toContain("plumber");
  });

  const card = (n: number) => `<div class="card"><h3>${FILLER_BANK[n % 30]} ${FILLER_BANK[(n + 7) % 30]}</h3><span class="rating">Durchschnittliche Bewertung von 4.${n} von 5 Sternen</span><div class="inst">Ab ${n},90 € zahlen in Raten</div></div>`;

  // Distinct words, so the page's own copy never trips the density check; sized so the cards stay under the 20% deduction cap.
  const letters = (i: number): string => { let out = ""; let n = i; do { out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0); return out; };
  const unique = (n: number) => Array.from({ length: n }, (_, i) => `zz${letters(i)}`).join(" ");

  test("price-shaped means currency, percent, \"of 5\" or stars/reviews only: a bare decimal is not a card", () => {
    const lines = Array.from({ length: 45 }, (_, n) => `<p>plumber ${n % 10}${n % 7}.99</p>`).join("");
    expect(flagged(page("en", `<main>${lines}<p>${unique(255)}</p></main>`))).toContain("plumber");
  });

  test("a word that is 10% or more of the page is never deducted, however it is dressed", () => {
    const lines = Array.from({ length: 45 }, (_, n) => `<div><h3>Item ${n}</h3><span>plumber from $${n + 1}</span></div>`).join("");
    expect(flagged(page("en", `<main>${lines}<p>${unique(255)}</p></main>`))).toContain("plumber");
  });

  test("a deduction is clamped, not skipped, and large real grids are still deducted", () => {
    const en = Array.from({ length: 40 }, (_, n) => `<div><h3>Item ${n}</h3><span>Average rating 4.${n % 10} of 5 stars</span><span>from ${n + 1},90 EUR in instalments</span></div>`).join("");
    const outEn = flagged(page("en", `<main><div class="grid">${en}</div><p>${unique(700)}</p></main>`));
    for (const w of ["average", "rating", "stars", "instalments", "eur"]) expect(outEn).not.toContain(w);
    const de = Array.from({ length: 60 }, (_, n) => `<div><h3>Nr ${n}</h3><span>Preis ab ${n + 1},90 \u20ac inkl. MwSt</span></div>`).join("");
    expect(flagged(page("de", `<main><div class="grid">${de}</div><p>${unique(500)}</p></main>`))).not.toContain("preis");
    const rating = Array.from({ length: 80 }, (_, n) => `<div><h3>Item ${n}</h3><span>Average rating 4.${n % 10} of 5 stars</span></div>`).join("");
    const outRating = flagged(page("en", `<main><div class="grid">${rating}</div><p>${unique(800)}</p></main>`));
    for (const w of ["average", "rating", "stars"]) expect(outRating).not.toContain(w);
  });

  test("the deduction never takes a word below half the flag threshold", () => {
    // 25 priced lines of the stuffed phrase in 500 words: the card deduction is bounded (counted down to the floor, not to nothing)
    const lines = Array.from({ length: 25 }, (_, n) => `<div><h3>Item ${n}</h3><span>emergency plumber london from $${n + 1}</span></div>`).join("");
    const html = page("en", `<main>${lines}<p>${unique(425)}</p></main>`);
    const check = keywordStuffingRule.run(ctx(html)).checks[0]!;
    expect(["warn", "pass"]).toContain(check.status);
    const word = check.items?.find((i) => i.id === "plumber");
    if (word) expect((word.meta as { count: number }).count).toBeGreaterThanOrEqual(8);
  });

  test("text repeated once per product card does not count toward density", () => {
    const html = page("de", `<main><div class="grid">${Array.from({ length: 12 }, (_, i) => card(i)).join("")}</div><p>${unique(500)}</p></main>`);
    const out = flagged(html);
    expect(out).not.toContain("durchschnittliche");
    expect(out).not.toContain("bewertung");
    expect(out).not.toContain("sternen");
    expect(out).not.toContain("zahlen");
  });

  test("true positive: 24 keyword links in one bare div (no list, no menu name) still count and flag", () => {
    const cities = ["london", "leeds", "bristol", "york", "bath", "derby"];
    const links = Array.from({ length: 24 }, (_, i) => `<a href="/p/${i}">emergency plumber ${cities[i % 6]}</a>`).join(" ");
    const html = page("en", `<body><div>${links}</div><p>${filler(90)}</p></body>`);
    expect(flagged(html)).toContain("plumber");
    // Class and id names and a plain list are not menu signals: a keyword spammer writes them too.
    const lis = Array.from({ length: 24 }, (_, i) => `<li><a href="/p/${i}">emergency plumber ${cities[i % 6]}</a></li>`).join("");
    for (const wrapper of [`<div class="nav"><div>${links}</div></div>`, `<div id="footer-menu">${links}</div>`, `<ul>${lis}</ul>`, `<div class="site-menu"><ul>${lis}</ul></div>`]) {
      expect(flagged(page("en", `<body>${wrapper}<p>${filler(90)}</p></body>`)), wrapper.slice(0, 30)).toContain("plumber");
    }
    // Even a real menu signal does not excuse a keyword cloud: one phrase in most of the labels
    expect(flagged(page("en", `<body><div role="menubar">${links}</div><p>${filler(90)}</p></body>`))).toContain("plumber");
  });

  test("a keyword cloud is not excused by a menu signal, at 40% or 58% of the labels sharing a word", () => {
    for (const shared of [10, 14]) {
      const labels = Array.from({ length: 24 }, (_, i) => (i < shared ? `emergency plumber area${i}` : `service${i} option${i} page${i}`));
      const links = labels.map((l, i) => `<a href="/p/${i}">${l}</a>`).join(" ");
      for (const wrapper of [`<div role="menubar">${links}</div>`, `<div aria-expanded="true">${links}</div>`]) {
        expect(flagged(page("en", `<body>${wrapper}<p>${filler(90)}</p></body>`)), `${shared} ${wrapper.slice(0, 22)}`).toContain("plumber");
      }
    }
    // a menu of varied categories (each word in a few labels) with a real signal is still left out
    const cats = Array.from({ length: 24 }, (_, i) => `<a href="/c/${i}">category${i} range${i % 8} line${i}</a>`).join(" ");
    expect(flagged(page("en", `<body><div role="menubar">${cats}</div><p>${filler(90)}</p></body>`))).not.toContain("category1");
  });

  test("true positive: a repeated phrase is never a card, however its wrapper looks", () => {
    const wrapped = Array.from({ length: 25 }, () => `<div class="sec"><p>cheap emergency plumber london</p></div>`).join("");
    expect(flagged(page("en", `<main>${wrapped}<p>${filler(110)}</p></main>`))).toContain("plumber");
    const lists = Array.from({ length: 25 }, () => `<ul><li>cheap emergency plumber london</li></ul>`).join("");
    expect(flagged(page("en", `<main>${lists}<p>${filler(110)}</p></main>`))).toContain("plumber");
    const one = `<ul>${Array.from({ length: 25 }, () => `<li>cheap emergency plumber london</li>`).join("")}</ul>`;
    expect(flagged(page("en", `<main>${one}<p>${filler(110)}</p></main>`))).toContain("plumber");
    // extra text in the wrapper must not hide it
    const withMore = Array.from({ length: 25 }, (_, n) => `<div><p>cheap emergency plumber london</p><p>call ${n}</p></div>`).join("");
    expect(flagged(page("en", `<main>${withMore}<p>${filler(110)}</p></main>`))).toContain("plumber");
    const lis = Array.from({ length: 25 }, () => `<ul><li>cheap emergency plumber london</li><li>more info</li></ul>`).join("");
    expect(flagged(page("en", `<main>${lis}<p>${filler(110)}</p></main>`))).toContain("plumber");
    // identical digits are not a varying rating or price: still stuffing
    const digits = Array.from({ length: 25 }, () => `<div><span>24 hour emergency plumber london</span><b>x</b></div>`).join("");
    expect(flagged(page("en", `<main>${digits}<p>${filler(110)}</p></main>`))).toContain("plumber");
    // a bare integer that varies is doorway numbering, not a rating or a price
    for (const lines of [
      Array.from({ length: 25 }, (_, n) => `<div><span>emergency plumber london call ${n}</span><b>x</b></div>`).join(""),
      Array.from({ length: 25 }, (_, n) => `<div><p>${n + 1} cheap emergency plumber london</p></div>`).join(""),
      Array.from({ length: 25 }, (_, n) => `<section><p>24 hour emergency plumber ${n}</p></section>`).join(""),
    ]) {
      expect(flagged(page("en", `<main>${lines}<p>${filler(110)}</p></main>`)), lines.slice(0, 40)).toContain("plumber");
    }
    // a decimal or a currency amount that varies still reads as a card, but never more than 20% of the words
    const priced = Array.from({ length: 25 }, (_, n) => `<div><h3>Item ${n}</h3><span>emergency plumber from ${n + 1}.99 EUR</span></div>`).join("");
    expect(flagged(page("en", `<main>${priced}<p>${filler(110)}</p></main>`))).toContain("plumber");
  });

  test("the card bound counts candidate cards, not every element, so a large grid is still deducted", () => {
    const big = Array.from({ length: 700 }, (_, n) => card(n % 30)).join("");
    const out = flagged(page("de", `<main><div class="grid">${big}</div><p>${unique(45_000)}</p></main>`));
    expect(out).not.toContain("durchschnittliche");
    expect(out).not.toContain("zahlen");
  });

  test("true positive: the same sentence written 12 times as body copy still flags", () => {
    const sentence = "Günstige Matratzen kaufen";
    const html = page("de", `<main><article><p>${Array.from({ length: 12 }, () => sentence).join(". ")}. ${filler(90)}</p></article></main>`);
    expect(flagged(html)).toContain("matratzen");
    // and as separate paragraphs in ONE container
    const html2 = page("de", `<main><article>${Array.from({ length: 12 }, () => `<p>${sentence}</p>`).join("")}<p>${filler(90)}</p></article></main>`);
    expect(flagged(html2)).toContain("matratzen");
  });
});

describe("content/keyword-stuffing link-list and card heuristics stay bounded (#1315)", () => {
  test("thousands of nested anchors and repeated cards finish quickly", () => {
    const nest = (depth: number, inner: string) => Array.from({ length: depth }, () => "<div>").join("") + inner + Array.from({ length: depth }, () => "</div>").join("");
    const links = Array.from({ length: 6000 }, (_, i) => `<a href="/x/${i}">label ${i % 97}</a>`).join("");
    const cards = Array.from({ length: 6000 }, (_, i) => `<div><span>Durchschnittliche Bewertung ${i}</span></div>`).join("");
    const html = `<html lang="de"><body>${nest(40, links)}${cards}<p>${filler(120)}</p></body></html>`;
    const started = performance.now();
    keywordStuffingRule.run(ctx(html));
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("content/keyword-stuffing stays near-linear on hostile shapes (#1315)", () => {
  const timeIt = (html: string): number => {
    const started = performance.now();
    keywordStuffingRule.run(ctx(html));
    return performance.now() - started;
  };
  const wrap = (body: string) => `<html lang="en"><body><main>${body}<p>${filler(120)}</p></main></body></html>`;

  test("40,000 spans under one div", () => {
    expect(timeIt(wrap(`<div>${Array.from({ length: 40_000 }, (_, i) => `<span>tag${i % 50} value ${i}</span>`).join("")}</div>`))).toBeLessThan(1500);
  });

  test("3,000 cards under a parent with two million characters of text", () => {
    const cards = Array.from({ length: 3000 }, (_, i) => `<div><h3>Item ${i}</h3><span>Rating 4.${i % 10} of 5 stars</span></div>`).join("");
    const pad = "lorem ".repeat(330_000);
    expect(timeIt(wrap(`<section>${pad}${cards}</section>`))).toBeLessThan(1500);
  });

  test("a list of 8,000 items and 2,000 groups", () => {
    expect(timeIt(wrap(`<ul>${Array.from({ length: 8000 }, (_, i) => `<li>entry number ${i}</li>`).join("")}</ul>`))).toBeLessThan(1500);
    expect(timeIt(wrap(Array.from({ length: 2000 }, (_, i) => `<div class="${"c".repeat(500)}"><a href="/x${i}">link ${i}</a></div>`).join("")))).toBeLessThan(1500);
  });
});
