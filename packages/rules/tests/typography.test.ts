// content/typography: low-severity typographic hygiene. The risk is false positives
// (code blocks, French copy, ellipses, CLI flags), so those fixtures matter most.

import { parseHTML } from "@squirrelscan/parser/dom";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, RuleContext } from "../src/types";

import {
  findTypographyIssues,
  typographyRule,
} from "../src/content/typography";

async function run(body: string, lang = "en") {
  const html = `<html lang="${lang}"><head></head><body>${body}</body></html>`;
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: {
      url: "https://example.com/",
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: { document } as unknown as ParsedPage,
    options: {},
  };
  return (await typographyRule.run(ctx)).checks;
}

const kinds = (checks: Awaited<ReturnType<typeof run>>) =>
  (
    (checks[0]!.details as { kinds: { kind: string }[] } | undefined)?.kinds ??
    []
  ).map((k) => k.kind);

describe("content/typography", () => {
  test("rule metadata is info severity with a minimal weight", () => {
    expect(typographyRule.meta.severity).toBe("info");
    expect(typographyRule.meta.weight).toBeLessThanOrEqual(2);
  });

  test("pass: clean copy, ellipsis, domain, emoticon and a CLI flag", async () => {
    const c = await run(
      "<p>Hello, world. This is fine... see example.com or use the --verbose flag :) “Quoted” text, it’s tidy.</p>"
    );
    expect(c[0]!.status).toBe("pass");
  });

  test("warn: double space between words", async () => {
    const c = await run("<p>Two  spaces here.</p>");
    expect(c[0]!.status).toBe("warn");
    expect(kinds(c)).toEqual(["double-space"]);
  });

  test("spaces where two text nodes meet are not a double space", async () => {
    // A browser collapses whitespace across node boundaries: each renders one space.
    expect((await run("<p><b>Two </b> spaces here.</p>"))[0]!.status).toBe(
      "pass"
    );
    expect(
      (await run("<p>Read <a href='/'> the docs</a> first.</p>"))[0]!.status
    ).toBe("pass");
    expect(
      (await run("<p><span>Hello </span> <span>world</span></p>"))[0]!.status
    ).toBe("pass");
  });

  test("double spaces are counted inside each text node", async () => {
    const c = await run("<p>One  here and <em>two  more  here</em>.</p>");
    expect(kinds(c)).toEqual(["double-space"]);
    expect(c[0]!.value).toBe(3);
  });

  test("double spaces inside code never count, even beside prose", async () => {
    const c = await run("<p>Run <code>a  b</code> now.</p>");
    expect(c[0]!.status).toBe("pass");
  });

  test("warn: mixed straight and curly quotes", async () => {
    const c = await run('<p>He said "hi" and then “bye”.</p>');
    expect(c[0]!.status).toBe("warn");
    expect(kinds(c)).toEqual(["mixed-quotes"]);
  });

  test("warn: mixed apostrophes", async () => {
    const c = await run("<p>It's fine but don’t worry.</p>");
    expect(kinds(c)).toEqual(["mixed-quotes"]);
  });

  test("all straight or all curly is not mixed", async () => {
    expect((await run("<p>\"a\" and 'b'</p>"))[0]!.status).toBe("pass");
    expect((await run("<p>“a” and ‘b’</p>"))[0]!.status).toBe("pass");
  });

  test("warn: space before punctuation", async () => {
    const c = await run("<p>Wait , what ? Really !</p>");
    expect(kinds(c)).toEqual(["space-before-punctuation"]);
  });

  test("warn: -- used as a dash", async () => {
    const c = await run("<p>It works -- mostly. Or maybe--not.</p>");
    expect(kinds(c)).toEqual(["double-hyphen-dash"]);
  });

  test("fail: many occurrences", async () => {
    const c = await run(`<p>${"word , ".repeat(25)}</p>`);
    expect(c[0]!.status).toBe("fail");
  });

  test("pre and code are never flagged", async () => {
    const c = await run(
      '<p>Plain text.</p><pre>a  b , c -- d "x" “y”</pre><p>Use <code>x  --  y , z</code> here.</p>'
    );
    expect(c[0]!.status).toBe("pass");
  });

  test("French copy is not flagged for space before punctuation", async () => {
    const c = await run(
      "<p>Bonjour ! Comment allez-vous ? Voici : un exemple ; merci.</p>",
      "fr-FR"
    );
    expect(c[0]!.status).toBe("pass");
  });

  test("a page with no lang is not checked for space before punctuation", async () => {
    const c = await run("<p>Wait , what ?</p>", "");
    expect(c[0]!.status).toBe("pass");
  });

  test("French still gets the other checks", async () => {
    const c = await run("<p>Deux  espaces ici.</p>", "fr");
    expect(kinds(c)).toEqual(["double-space"]);
  });

  test("skipped: no document and no body", async () => {
    const noDoc = await typographyRule.run({
      page: {
        url: "https://example.com/",
        html: "",
        statusCode: 200,
        loadTime: 0,
        headers: {},
      },
      parsed: { document: null } as unknown as ParsedPage,
      options: {},
    });
    expect(noDoc.checks[0]!.status).toBe("skipped");
    const doc = parseHTML("<html></html>").document;
    doc.querySelector("body")?.remove();
    const noBody = await typographyRule.run({
      page: {
        url: "https://example.com/",
        html: "",
        statusCode: 200,
        loadTime: 0,
        headers: {},
      },
      parsed: { document: doc } as unknown as ParsedPage,
      options: {},
    });
    expect(noBody.checks[0]!.status).toBe("skipped");
  });

  test("findTypographyIssues respects the punctuation switch", () => {
    expect(findTypographyIssues("a , b", false)).toEqual([]);
    expect(findTypographyIssues("a , b", true)[0]!.kind).toBe(
      "space-before-punctuation"
    );
  });
});
