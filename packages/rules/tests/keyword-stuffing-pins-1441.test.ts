// content/keyword-stuffing: the shapes of the #1315 residual (#1441), pinned as they behave today.
//
// These are NOT wishes: each case states what the rule does with a page shaped like the reported ones, and why. The
// anti-stuffing bounds that decide them are deliberate (a spammer can dress a phrase as card microcopy or a menu):
// text is deducted only when it varies between cards, at most 20% of a page's words in total, and a menu of plain
// `div` links counts like any other copy. If the product decision on #1441 loosens a bound, these tests are the ones
// to change, on purpose.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { keywordStuffingRule } from "../src/content/keyword-stuffing";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(html: string): RuleContext {
  return {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: parseHTML(html).document } as unknown as ParsedPage,
    options: {},
  } as unknown as RuleContext;
}
const check = (html: string) => keywordStuffingRule.run(ctx(html)).checks.find((c) => c.name === "keyword-stuffing")!;
const flagged = (html: string): string[] => (check(html).items ?? []).map((i) => i.id);
const page = (lang: string, body: string) => `<html lang="${lang}"><head><title>t</title></head><body>${body}</body></html>`;

// Distinct words, so a page's own copy never trips the density check.
const letters = (i: number): string => {
  let out = "";
  let n = i;
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
};
const copy = (n: number): string => Array.from({ length: n }, (_, i) => `zz${letters(i)}`).join(" ");

const deCard = (n: number) =>
  `<div class="card"><h3>Produkt ${letters(n)}</h3><span>Durchschnittliche Bewertung von 4.${n % 10} von 5 Sternen</span><div>Ab ${n},90 € zahlen in Raten, Versandkosten ab 4,90 €</div></div>`;
const enCard = (n: number) =>
  `<div class="card"><h3>Item ${letters(n)}</h3><span>Average rating 4.${n % 10} of 5 stars</span><div>Shipping costs from $4.90, free returns</div></div>`;
const grid = (card: (n: number) => string, cards: number) => `<div class="grid">${Array.from({ length: cards }, (_, i) => card(i)).join("")}</div>`;

describe("a product grid next to ordinary copy is clean (the case the card deduction was built for)", () => {
  test("12 German cards and 6 English cards beside 400 words of copy raise nothing", () => {
    expect(check(page("de", `<main>${grid(deCard, 12)}<p>${copy(400)}</p></main>`)).status).toBe("pass");
    expect(check(page("en", `<main>${grid(enCard, 6)}<p>${copy(400)}</p></main>`)).status).toBe("pass");
  });
  test("so does a 24-card grid in a long page (700 words): the cards stay under the 20% cap", () => {
    expect(check(page("de", `<main>${grid(deCard, 24)}<p>${copy(700)}</p></main>`)).status).toBe("pass");
    expect(check(page("en", `<main>${grid(enCard, 24)}<p>${copy(700)}</p></main>`)).status).toBe("pass");
  });
});

describe("a card-dominated category page still counts the microcopy past the 20% cap (#1441)", () => {
  test("24 German cards beside 60 words of copy: the rating sentence and the installment note are flagged", () => {
    const out = flagged(page("de", `<main>${grid(deCard, 24)}<p>${copy(60)}</p></main>`));
    // The cap on the deduction (20% of the page's words) leaves most of the cards' words counted.
    for (const word of ["durchschnittliche", "bewertung", "sternen", "zahlen", "raten"]) expect(out).toContain(word);
  });
  test("24 English cards beside 60 words of copy: a price that is identical on every card is not deducted at all", () => {
    const out = flagged(page("en", `<main>${grid(enCard, 24)}<p>${copy(60)}</p></main>`));
    // "Shipping costs from $4.90, free returns" is the same on every card: no number varies, so it is not card
    // microcopy by the rule's definition (a spammer can dress a phrase in one fixed price).
    for (const word of ["shipping", "costs", "free", "returns"]) expect(out).toContain(word);
    // The rating sentence varies by number, so it is deducted and not flagged.
    for (const word of ["average", "rating", "stars"]) expect(out).not.toContain(word);
  });
});

describe("a newsletter teaser is copy (#1441)", () => {
  const teaser = `<div class="newsletter"><p>Jetzt Abonnement abschliessen: Das Abonnement ist jederzeit kuendbar. Abonnement mit Gutschein, Abonnement ohne Risiko, Abonnement bestaetigen, Abonnement verschenken.</p><form><input placeholder="E-Mail"><button>Abonnement starten</button></form></div>`;
  test("six uses of one word in a teaser, in a form, beside 120 words of copy: counted and flagged", () => {
    expect(flagged(page("de", `<main><p>${copy(120)}</p>${teaser}</main>`))).toEqual(["abonnement"]);
  });
  test("on a page with under 100 words in total the rule says the content is too short and flags nothing", () => {
    const c = check(page("de", `<main><p>${copy(60)}</p>${teaser}</main>`));
    expect(c.status).toBe("info");
    expect(c.items).toBeUndefined();
  });
});

describe("a menu of plain div links on a contact page (#1441)", () => {
  const cats = ["bademode", "curvy", "waesche", "kleider", "roecke", "hosen", "jacken", "schuhe"];
  const menu = (label: (i: number) => string) =>
    `<div id="menu">${Array.from({ length: 20 }, (_, i) => `<div><a href="/c/${i}">${label(i)}</a></div>`).join("")}</div>`;
  const contact = (links: string, words: number) => page("de", `<body>${links}<main><h1>Kontakt</h1><p>${copy(words)}</p></main></body>`);

  test("20 links with varied category words (the real mega menu's shape) and 90 words of copy raise nothing", () => {
    const varied = menu((i) => `${cats[i % 8]} ${["neu", "sale", "alle", "top", "mehr"][i % 5]}`);
    expect(check(contact(varied, 90)).status).toBe("pass");
  });
  test("20 links that share one category word are counted and flagged, by design: a spammer writes the same plain links", () => {
    const shared = menu((i) => `bademode ${["neu", "sale", "alle", "top", "mehr"][i % 5]}`);
    expect(flagged(contact(shared, 90))).toEqual(["bademode"]);
  });
  test("a menu signal (role=menubar) leaves varied links out, but links that share one word are still counted", () => {
    const signal = (label: (i: number) => string) =>
      `<div role="menubar">${Array.from({ length: 20 }, (_, i) => `<div><a href="/c/${i}">${label(i)}</a></div>`).join("")}</div>`;
    expect(flagged(contact(signal((i) => `${cats[i % 8]} ${["neu", "sale", "alle", "top", "mehr"][i % 5]}`), 90))).toEqual([]);
    expect(flagged(contact(signal((i) => `bademode ${["neu", "sale", "alle", "top", "mehr"][i % 5]}`), 90))).toContain("bademode");
  });
  test("under 100 words in total the page is too short to measure, menu or not", () => {
    const shared = menu((i) => `bademode ${["neu", "sale", "alle", "top", "mehr"][i % 5]}`);
    expect(check(contact(shared, 40)).status).toBe("info");
  });
});
