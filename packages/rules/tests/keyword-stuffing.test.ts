// content/keyword-stuffing — function-word stopwords + repeated CTA label
// exclusion (#695). Before this fix, generic function words ("get", "your")
// and repeated short CTA/button labels ("Learn more" x11 cards) tripped the
// density check on ordinary pages. Real prose stuffing must still flag.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { keywordStuffingRule } from "../src/content/keyword-stuffing";
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
