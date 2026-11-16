// content/keyword-stuffing: classifier regions and the footer link check (repo#3544).

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";
import { setDocumentPlacer } from "@squirrelscan/parser";

import { keywordStuffingRule } from "../src/content/keyword-stuffing";
import type { ParsedPage, RuleContext } from "../src/types";

type Region = "navigation" | "footer" | "site_header" | "sidebar" | "main_content";

/** A fake placer: the nearest ancestor carrying data-region answers, like the real nearest-labelled-ancestor lookup. */
function classify(html: string) {
  const { document } = parseHTML(html);
  setDocumentPlacer(document, (el) => {
    for (let cur: any = el; cur; cur = cur.parentElement) {
      const label = cur.getAttribute?.("data-region") as Region | null;
      if (label) return { region: { label, confidence: 0.99, source: "model" }, section: null } as never;
    }
    return null;
  });
  return document;
}

function ctx(html: string, classified: boolean): RuleContext {
  const document = classified ? classify(html) : parseHTML(html).document;
  return {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: {},
  } as unknown as RuleContext;
}
const run = async (html: string, classified: boolean) => (await keywordStuffingRule.run(ctx(html, classified))).checks;
const density = async (html: string, classified: boolean) => (await run(html, classified)).find((c) => c.name === "keyword-stuffing")!;

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
const page = (body: string) => `<html lang="en"><head><title>t</title></head><body>${body}</body></html>`;

// A div-only mega menu: no landmark, no role, no aria: only the model can tell it is chrome.
const megaMenu = (attrs = "") =>
  `<div class="mm"${attrs}>${Array.from({ length: 20 }, (_, i) => `<div><a href="/c${i}">Gadgets ${letters(i)}</a></div>`).join("")}</div>`;

describe("div-only mega menu with the classifier on", () => {
  const html = page(`${megaMenu(' data-region="navigation"')}<div class="body"><p>${copy(380)}</p></div>`);
  test("the category word is not reported", async () => {
    const check = await density(html, true);
    expect(check.status).toBe("pass");
    expect((check.items ?? []).map((i) => i.id)).not.toContain("gadgets");
  });
  test("the same page with the classifier off counts the menu like any copy (no worse than before)", async () => {
    expect((await density(html, false)).items?.map((i) => i.id)).toContain("gadgets");
  });
  test("model-labelled header and sidebar text is dropped too", async () => {
    const body = (region: string) =>
      page(`<div data-region="${region}">${"Widgets ".repeat(20)}</div><div><p>${copy(380)}</p></div>`);
    for (const region of ["site_header", "sidebar", "footer", "navigation"]) {
      expect((await density(body(region), true)).status).toBe("pass");
    }
    expect((await density(body("main_content"), true)).status).toBe("warn");
  });
});

describe("classifier off keeps the markup landmarks", () => {
  test("a <nav> mega menu is still excluded", async () => {
    const html = page(`<nav>${megaMenu()}</nav><div><p>${copy(380)}</p></div>`);
    expect((await density(html, false)).status).toBe("pass");
  });
});

describe("footer link block repeating a commercial keyword", () => {
  const footer = `<footer>${Array.from({ length: 16 }, (_, i) => `<a href="/p${i}">Emergency plumber ${letters(i)}</a>`).join(" ")}</footer>`;
  const html = page(`<div><p>${copy(380)}</p></div>${footer}`);
  test("is flagged as its own check, markup footer, classifier off", async () => {
    const checks = await run(html, false);
    expect(checks.find((c) => c.name === "keyword-stuffing")!.status).toBe("pass");
    const f = checks.find((c) => c.name === "keyword-stuffing-footer")!;
    expect(f.status).toBe("warn");
    expect(f.items?.map((i) => i.id)).toContain("plumber");
  });
  test("is flagged for a div footer the model labelled footer", async () => {
    const div = html.replace("<footer>", '<div data-region="footer">').replace("</footer>", "</div>");
    expect((await run(div, true)).find((c) => c.name === "keyword-stuffing-footer")?.status).toBe("warn");
    expect((await run(div, false)).find((c) => c.name === "keyword-stuffing-footer")).toBeUndefined();
  });
  test("a nav menu repeating a category word is not a footer finding", async () => {
    const nav = page(`<nav>${megaMenu()}</nav><div><p>${copy(380)}</p></div>`);
    expect((await run(nav, false)).find((c) => c.name === "keyword-stuffing-footer")).toBeUndefined();
  });
  test("an ordinary varied footer raises nothing", async () => {
    const names = ["About", "Pricing", "Careers", "Press", "Terms", "Privacy", "Contact", "Blog", "Docs", "Status", "Security", "Support"];
    const ok = page(`<div><p>${copy(380)}</p></div><footer>${names.map((n) => `<a href="/${n}">${n}</a>`).join(" ")}</footer>`);
    expect((await run(ok, false)).find((c) => c.name === "keyword-stuffing-footer")).toBeUndefined();
  });
});

describe("cost with the classifier on", () => {
  test("a 2000-element page with a placer stays well under the per-page rule budget", async () => {
    const html = page(`${megaMenu(' data-region="navigation"')}${Array.from({ length: 1500 }, (_, i) => `<p>${copy(8)} ${letters(i)}</p>`).join("")}`);
    const doc = ctx(html, true);
    const start = performance.now();
    await keywordStuffingRule.run(doc);
    const ms = performance.now() - start;
    console.log(`keyword-stuffing with placer, 1500 paragraphs: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});
