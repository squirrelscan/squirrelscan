// local/nap-consistency: a button label beside the phone number is not part of
// its format (pub#741).
//
// The reporter's bilingual site renders one `tel:` link on every page, the same
// number with a translated label: "Jetzt anrufen" on 7 German pages (and the
// homepage), "Call now" on 5 English ones. The whole anchor text used to be
// stored as the format, so one byte-identical number read as two renderings.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { extractNapSignal, napPhoneKey, napPhoneToken } from "@squirrelscan/utils";

import { parsePage } from "@squirrelscan/parser";

import { napConsistencyRule } from "../src/local/nap-consistency";
import type { ParsedPage, RuleContext } from "../src/types";

const ORIGIN = "http://localhost:8766";
const NUMBER = "+49 (0)6061 630 980 0";
const KEY = napPhoneKey("+4960616309800")!;

const LD =
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Repro GmbH","telephone":"+4960616309800","address":{"@type":"PostalAddress","streetAddress":"Hauptstr. 1","addressLocality":"Michelstadt","postalCode":"64720","addressCountry":"DE"}}</script>';

/** One page of the reporter's generator, with `anchor` as the header tel: link body. */
function reproPage(lang: string, name: string, anchor: string): string {
  return `<!doctype html><html lang="${lang}"><head><title>Repro ${name}</title>${LD}</head><body><header><a href="tel:+4960616309800">${anchor}</a></header><main><h1>Page ${name}</h1><p>Text.</p></main></body></html>`;
}

const labelled = (label: string) => `<span>${NUMBER}</span> <span>${label}</span>`;

/** The reporter's 13 pages: index (a copy of de1), de1-de7 and en1-en5. */
function reproPages(
  anchorFor: (lang: string, i: number) => string,
): { url: string; html: string }[] {
  const pages = [
    ...Array.from({ length: 7 }, (_, i) => ({ lang: "de", name: `de${i + 1}`, i })),
    ...Array.from({ length: 5 }, (_, i) => ({ lang: "en", name: `en${i + 1}`, i })),
  ].map(({ lang, name, i }) => ({
    url: `${ORIGIN}/${name}.html`,
    html: reproPage(lang, name, anchorFor(lang, i)),
  }));
  return [{ url: `${ORIGIN}/`, html: pages[0]!.html }, ...pages];
}

function siteCtx(pagesHtml: { url: string; html: string }[]): RuleContext {
  // The rule folds pages in normalized-url order, as both engine paths do.
  const pages = [...pagesHtml]
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .map((p) => ({ url: p.url, statusCode: 200, parsed: parsePage(p.html, p.url) as ParsedPage }));
  return {
    page: { url: `${ORIGIN}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    options: {},
    site: { baseUrl: `${ORIGIN}/`, pages, robotsTxt: null, sitemaps: null },
  };
}

function phoneCheck(ctx: RuleContext): CheckResult {
  const result = napConsistencyRule.run(ctx);
  if (result instanceof Promise) throw new Error("legacy path must be synchronous");
  const found = result.checks.find((c) => c.name === "phone-consistency");
  if (!found) throw new Error("no phone-consistency check");
  return found;
}

describe("local/nap-consistency: the reporter's bilingual fixture (pub#741)", () => {
  test("one number with a translated label passes as one format", () => {
    const check = phoneCheck(
      siteCtx(reproPages((lang) => labelled(lang === "de" ? "Jetzt anrufen" : "Call now"))),
    );
    expect(check).toEqual({
      name: "phone-consistency",
      status: "pass",
      message: "The same phone number is used consistently across 13 pages",
      value: NUMBER,
    });
  });

  test("a genuinely different rendering of the same number still warns", () => {
    // Three English pages write the number as "Telefon: 060616309800".
    const check = phoneCheck(
      siteCtx(
        reproPages((lang, i) =>
          lang === "en" && i < 3 ? "Telefon: 060616309800" : labelled("Jetzt anrufen"),
        ),
      ),
    );
    expect(check.status).toBe("warn");
    expect(check.message).toBe(
      "The same phone number is formatted 2 different ways across 13 pages",
    );
    expect(check.items?.map((item) => item.id)).toEqual([NUMBER, "060616309800"]);
  });

  test("the bare number and the labelled number are one format", () => {
    const check = phoneCheck(
      siteCtx(reproPages((lang) => (lang === "de" ? NUMBER : labelled("Call now")))),
    );
    expect(check.status).toBe("pass");
    expect(check.value).toBe(NUMBER);
  });
});

describe("extractNapSignal: only the phone token is stored", () => {
  const signal = (anchor: string, schemaPhone?: string) => {
    const ld = schemaPhone
      ? `<script type="application/ld+json">{"@type":"LocalBusiness","telephone":"${schemaPhone}"}</script>`
      : "";
    const html = `<html><head>${ld}</head><body><a href="tel:+4960616309800">${anchor}</a></body></html>`;
    return extractNapSignal(parsePage(html, `${ORIGIN}/`));
  };

  test("the label beside the number is dropped", () => {
    expect(signal(labelled("Jetzt anrufen")).phoneFormats).toEqual([NUMBER]);
    expect(signal(labelled("Call now")).phoneFormats).toEqual([NUMBER]);
  });

  test("anchor text without the number falls back to the href payload", () => {
    expect(signal("Call us").phoneFormats).toEqual(["+4960616309800"]);
  });

  test("the comparison key is unchanged", () => {
    expect(signal(labelled("Call now")).phones).toEqual([KEY]);
  });
});

describe("napPhoneToken", () => {
  const cases: [string, string, string | null][] = [
    ["+49 (0)6061 630 980 0 Jetzt anrufen", KEY, NUMBER],
    ["Jetzt anrufen: +49 (0)6061 630 980 0", KEY, NUMBER],
    ["+49 (0)6061 630 980 0Call now", KEY, NUMBER],
    ["Telefon: 060616309800", KEY, "060616309800"],
    ["+49 (0)6061 630 980 0 24/7", KEY, NUMBER],
    // Label digits before the number: a `+` marks where the number starts.
    ["Open 9-5 +49 (0)6061 630 980 0", KEY, NUMBER],
    ["24/7 +49 6061 630 980 0", KEY, "+49 6061 630 980 0"],
    // Without a `+` nothing marks the start, so a leading group is kept: it is
    // as likely a trunk prefix as a label.
    ["1 (555) 123-4567", napPhoneKey("5551234567")!, "1 (555) 123-4567"],
    ["24/7 060616309800", KEY, "24/7 060616309800"],
    ["Call +1 (555) 123-4567 now", napPhoneKey("5551234567")!, "+1 (555) 123-4567"],
    ["Call 555.123.4567.", napPhoneKey("5551234567")!, "555.123.4567"],
    ["(02) 9222 3333", napPhoneKey("0292223333")!, "(02) 9222 3333"],
    ["+49 6061 630980 0", KEY, "+49 6061 630980 0"],
    ["Call us", KEY, null],
    ["Call 555 999 0000", KEY, null],
  ];
  for (const [text, key, expected] of cases) {
    test(`${JSON.stringify(text)} -> ${JSON.stringify(expected)}`, () => {
      expect(napPhoneToken(text, key)).toBe(expected);
    });
  }

  test("a wall of digit groups is bounded work", () => {
    const wall = "1 ".repeat(50_000);
    const started = performance.now();
    expect(napPhoneToken(wall, KEY)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
