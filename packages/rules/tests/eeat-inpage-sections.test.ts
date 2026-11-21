// eeat about/contact — in-page #about / #contact sections on single-page sites (#1208).

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

import { aboutPageRule } from "../src/eeat/about-page";
import { contactPageRule } from "../src/eeat/contact-page";

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

function ctxFor(body: string, url = "https://example.com/"): RuleContext {
  const html = `<html><body>${body}</body></html>`;
  const pages: SiteData["pages"] = [
    { url, statusCode: 200, parsed: parsePage(html, url) },
  ];
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: pages[0]!.parsed ?? ({} as ParsedPage),
    site: {
      baseUrl: "https://example.com",
      pages,
      robotsTxt: null,
      sitemaps: null,
    },
    options: {},
  };
}

const run = async (
  rule: Rule,
  ctx: RuleContext,
  name: string
): Promise<CheckResult | undefined> =>
  (await rule.run(ctx)).checks.find((c) => c.name === name);

describe("eeat/about-page: in-page section", () => {
  test("passes with a linked #about section of 200+ words, naming the section", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(
        `<nav><a href="#about">About</a></nav><section id="about"><p>${words(220)}</p></section>`
      ),
      "about-page"
    );
    expect(c?.status).toBe("pass");
    expect(c?.message).toBe("About section found on the homepage (#about)");
  });

  test("reports info, not warn, for a 50-word section", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(
        `<a href="#about">About</a><section id="about"><p>${words(50)}</p></section>`
      ),
      "about-page"
    );
    expect(c?.status).toBe("info");
    expect(c?.message).toContain("limited content");
  });

  test("an id with no fragment link pointing at it does not count", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(`<section id="about"><p>${words(220)}</p></section>`),
      "about-page"
    );
    expect(c?.status).toBe("warn");
  });

  test("a fragment link with no matching element does not count", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(`<a href="#about">About</a><p>${words(220)}</p>`),
      "about-page"
    );
    expect(c?.status).toBe("warn");
  });

  test("recognises a localised section id", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(
        `<a href="#uber-uns">Uber uns</a><section id="uber-uns"><p>${words(220)}</p></section>`
      ),
      "about-page"
    );
    expect(c?.status).toBe("pass");
  });

  test("an unrelated section id is ignored", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(
        `<a href="#pricing">Pricing</a><section id="pricing"><p>${words(220)}</p></section>`
      ),
      "about-page"
    );
    expect(c?.status).toBe("warn");
  });

  test("a real /about page still takes precedence", async () => {
    const ctx = ctxFor(`<p>${words(220)}</p>`, "https://example.com/about");
    const c = await run(aboutPageRule, ctx, "about-page");
    expect(c?.message).toBe("About page exists with substantial content");
  });
});

describe("in-page section edge cases", () => {
  test("script content inside a thin About section does not reach the word bar", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(
        `<a href="#about">About</a><section id="about"><p>${words(40)}</p><script>${words(300)}</script></section>`
      ),
      "about-page"
    );
    expect(c?.status).toBe("info");
  });

  test("a section on a non-root page is named by its path", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(
        `<a href="#about">About</a><section id="about"><p>${words(220)}</p></section>`,
        "https://example.com/en/"
      ),
      "about-page"
    );
    expect(c?.message).toBe("About section found on /en/ (#about)");
  });

  test("an id holding a slash or query is not read as a deeper path", async () => {
    for (const id of ["about/x", "about?x=1"]) {
      const c = await run(
        aboutPageRule,
        ctxFor(
          `<a href="#${encodeURIComponent(id)}">x</a><section id="${id}"><p>${words(220)}</p></section>`
        ),
        "about-page"
      );
      expect(c?.status).toBe("warn");
    }
  });

  test("an id differing only in case from the link is not the section", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(
        `<a href="#About">About</a><section id="about"><p>${words(220)}</p></section>`
      ),
      "about-page"
    );
    expect(c?.status).toBe("warn");
  });
});

describe("eeat/contact-page: in-page section", () => {
  test("a real /contact page takes precedence over a section", async () => {
    const c = await run(
      contactPageRule,
      ctxFor(
        `<a href="#contact">c</a><section id="contact"><p>hi</p></section>`,
        "https://example.com/contact"
      ),
      "contact-page"
    );
    expect(c?.message).toBe("Contact page exists");
  });

  test("a page-level mailto link counts for an empty section", async () => {
    const c = await run(
      contactPageRule,
      ctxFor(
        `<a href="#contact">c</a><section id="contact"></section><footer><a href="mailto:a@b.co">m</a></footer>`
      ),
      "contact-page"
    );
    expect(c?.status).toBe("pass");
  });

  test("passes with a linked #contact section and a mailto link", async () => {
    const c = await run(
      contactPageRule,
      ctxFor(
        `<a href="#contact">Contact</a><section id="contact"><a href="mailto:hi@example.com">Email us</a></section>`
      ),
      "contact-page"
    );
    expect(c?.status).toBe("pass");
    expect(c?.message).toBe("Contact section found on the homepage (#contact)");
  });

  test("passes with a form or a tel link", async () => {
    for (const inner of [
      `<form action="/send"><input name="e"></form>`,
      `<a href="tel:+15550100">Call</a>`,
    ]) {
      const c = await run(
        contactPageRule,
        ctxFor(
          `<a href="#contact">Contact</a><section id="contact">${inner}</section>`
        ),
        "contact-page"
      );
      expect(c?.status).toBe("pass");
    }
  });

  test("reports info when the section has no way to make contact", async () => {
    const c = await run(
      contactPageRule,
      ctxFor(
        `<a href="#contact">Contact</a><section id="contact"><p>Get in touch</p></section>`
      ),
      "contact-page"
    );
    expect(c?.status).toBe("info");
  });

  test("an id with no fragment link does not count", async () => {
    const c = await run(
      contactPageRule,
      ctxFor(
        `<section id="contact"><a href="mailto:hi@example.com">Email</a></section>`
      ),
      "contact-page"
    );
    expect(c?.status).toBe("warn");
  });

  test("recognises a localised id (#contacto)", async () => {
    const c = await run(
      contactPageRule,
      ctxFor(
        `<a href="#contacto">Contacto</a><section id="contacto"><a href="mailto:a@b.es">x</a></section>`
      ),
      "contact-page"
    );
    expect(c?.status).toBe("pass");
  });

  test("a page with no # links is not judged a section", async () => {
    const c = await run(
      aboutPageRule,
      ctxFor(`<section id="about"><p>${words(220)}</p></section>`),
      "about-page"
    );
    expect(c?.status).toBe("warn");
  });
});

// A streaming snapshot cached before inPageSections existed (#1236).
describe("legacy collected records", () => {
  const legacy = (rule: Rule, name: string, pageCount = 1) => {
    const ctx = ctxFor(`<p>${words(220)}</p>`);
    const pages = ctx.site!.pages;
    if (pageCount > 1) {
      pages.push({ ...pages[0]!, url: "https://example.com/other" });
    }
    ctx.collectedSignals = {
      pages: pages.map((p) => ({
        url: p.url,
        secrets: [],
        inlineCssLen: 0,
        inlineJsLen: 0,
        externalCssCount: 0,
        externalJsCount: 0,
        imageCount: 0,
        fingerprint: null,
        signals: [],
        scriptSrcs: [],
        subprocessorMatch: null,
        commercialOffer: false,
      })),
    };
    return run(rule, ctx, name);
  };

  test("a one-page site is skipped, not warned, with a re-run hint", async () => {
    expect((await legacy(aboutPageRule, "about-page"))?.status).toBe("skipped");
    expect((await legacy(contactPageRule, "contact-page"))?.status).toBe(
      "skipped"
    );
    expect((await legacy(aboutPageRule, "about-page"))?.message).toContain(
      "--refresh"
    );
  });

  test("a multi-page site keeps the plain missing-page warning", async () => {
    expect((await legacy(aboutPageRule, "about-page", 2))?.status).toBe("warn");
  });
});
