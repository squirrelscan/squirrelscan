// core/charset — placement advice vs encoding problems, pub#659.
//
// A page correctly declared as UTF-8 whose charset meta followed a viewport
// meta warned at the same level as a real encoding problem. Placement is now
// advice at info status (score-neutral). Two cases the rule never checked are
// now findings: a declaration not serialized within the first 1024 bytes (HTML
// Standard §4.2.5.4), and a Content-Type header that disagrees with the page
// about UTF-8 (the header decides the decoding).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { charsetRule } from "../src/core/charset";
import type { ParsedPage, RuleContext } from "../src/types";

const URL = "https://example.com/";
const UTF8_HEADER = "text/html; charset=utf-8";
const VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1">`;
const CHARSET = `<meta charset="utf-8">`;

function doc(head: string, before = ""): string {
  return `<!doctype html>${before}<html lang="de"><head>\n${head}\n<title>Charset placement</title>\n</head><body>Grüße</body></html>`;
}

function run(html: string, contentType?: string, rendered?: boolean): CheckResult {
  const headers: Record<string, string> = {};
  if (contentType !== undefined) headers["content-type"] = contentType;
  const ctx: RuleContext = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers, rendered },
    parsed: parsePage(html, URL) as ParsedPage,
    options: {},
  };
  const checks = charsetRule.run(ctx).checks as CheckResult[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

const STATUS_RANK: Record<string, number> = { pass: 0, info: 1, warn: 2, fail: 3 };

describe("core/charset placement is advice (pub#659)", () => {
  test("viewport first, UTF-8 header and meta: info advice, not an encoding warning", () => {
    const check = run(doc(`${VIEWPORT}\n${CHARSET}`), UTF8_HEADER);
    expect(check.status).toBe("info");
    expect(check.message).toBe(
      "UTF-8 is declared correctly; consider placing the charset meta first in head (best practice)"
    );
    expect(check.value).toBe("utf-8");
  });

  test("viewport first with no header (meta inside 1024 bytes) is the same advice", () => {
    expect(run(doc(`${VIEWPORT}\n${CHARSET}`)).status).toBe("info");
  });

  test("the advice ranks below the missing and conflicting cases", () => {
    const advice = run(doc(`${VIEWPORT}\n${CHARSET}`), UTF8_HEADER);
    const missing = run(doc(VIEWPORT));
    const conflict = run(doc(CHARSET), "text/html; charset=iso-8859-1");
    expect(STATUS_RANK[advice.status]!).toBeLessThan(STATUS_RANK[missing.status]!);
    expect(STATUS_RANK[advice.status]!).toBeLessThan(STATUS_RANK[conflict.status]!);
  });

  test("charset meta first (the control) passes", () => {
    const check = run(doc(`${CHARSET}\n${VIEWPORT}`), UTF8_HEADER);
    expect(check.status).toBe("pass");
    expect(check.message).toBe("UTF-8 charset declared early in head");
  });

  test("header only, no meta: passes via header", () => {
    const check = run(doc(VIEWPORT), UTF8_HEADER);
    expect(check.status).toBe("pass");
    expect(check.message).toBe("UTF-8 charset declared via header");
  });

  test("a quoted header charset is read as its value", () => {
    const check = run(doc(VIEWPORT), 'text/html; charset="UTF-8"');
    expect(check.status).toBe("pass");
    expect(check.value).toBe("UTF-8");
  });
});

describe("core/charset declaration beyond the first 1024 bytes (pub#659)", () => {
  test("first in head but after a 2,000-byte comment, no header: a conformance warning", () => {
    const html = doc(CHARSET, `<!-- ${"x".repeat(2000)} -->`);
    const check = run(html);
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Charset meta is not within the first 1024 bytes");
  });

  test("beyond 1024 bytes with no header warns too", () => {
    const html = doc(`<style>${"a{}".repeat(400)}</style>\n${CHARSET}`);
    expect(html.indexOf(CHARSET)).toBeGreaterThan(1024);
    expect(run(html).status).toBe("warn");
  });

  test("bytes, not characters: 1,200 bytes of 2-byte text before an in-window-by-length meta", () => {
    const html = doc(CHARSET, `<!-- ${"ü".repeat(600)} -->`);
    expect(html.indexOf(CHARSET) + CHARSET.length).toBeLessThan(1024);
    expect(run(html).message).toBe("Charset meta is not within the first 1024 bytes");
  });

  test("a meta that starts inside the window but ends past byte 1024 is not serialized within it", () => {
    const before = doc(CHARSET, "<!--  -->").indexOf(CHARSET);
    const html = doc(CHARSET, `<!-- ${"x".repeat(1024 - 10 - before)} -->`);
    const start = new TextEncoder().encode(html.slice(0, html.indexOf(CHARSET))).length;
    expect(start).toBeLessThan(1024);
    expect(start + CHARSET.length).toBeGreaterThan(1024);
    expect(run(html).status).toBe("warn");
  });

  test("a charset meta inside a comment is not the declaration", () => {
    const html = doc(CHARSET, `<!-- ${CHARSET} ${"x".repeat(2000)} -->`);
    expect(run(html).status).toBe("warn");
  });

  test("a quoted > inside the charset meta does not end the tag early", () => {
    const early = doc(`<meta data-note=">" charset="utf-8">\n${VIEWPORT}`);
    expect(run(early, UTF8_HEADER).status).toBe("pass");
    // The tag's real `>` is past byte 1024; a quoted `>` near its start is not it.
    const long = doc(`<meta charset="utf-8" data-note=">${"x".repeat(1100)}">`);
    expect(run(long).message).toBe("Charset meta is not within the first 1024 bytes");
  });

  test("lookalikes before a late declaration do not count: <meta-data>, a quoted <meta in another tag", () => {
    const late = `<style>${"a{}".repeat(400)}</style>\n${CHARSET}`;
    for (const lookalike of [
      `<meta-data charset="utf-8">`,
      `<link rel="alternate" title='<meta charset="utf-8">' href="/x">`,
      // The quote closes past the window: scanning must not resume inside it.
      `<link rel="alternate" title='<meta charset="utf-8">${"x".repeat(1100)}' href="/x">`,
    ]) {
      const html = doc(`${lookalike}\n${late}`);
      expect([lookalike, run(html).status]).toEqual([lookalike, "warn"]);
    }
  });

  test("a http-equiv declaration beyond 1024 bytes is flagged the same way", () => {
    const equiv = `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`;
    const html = doc(equiv, `<!-- ${"x".repeat(2000)} -->`);
    expect(run(html).message).toBe("Charset meta is not within the first 1024 bytes");
  });

  test("a rendered page is not byte-checked: its html is the serialized DOM", () => {
    const html = doc(CHARSET, `<!-- ${"x".repeat(2000)} -->`);
    expect(run(html, UTF8_HEADER, true).status).toBe("pass");
  });
});

describe("core/charset header vs page conflicts (pub#659)", () => {
  test("header iso-8859-1, meta utf-8: the header decides, so it warns", () => {
    const check = run(doc(CHARSET), "text/html; charset=iso-8859-1");
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Conflicting charset declarations: header iso-8859-1, page utf-8");
    expect(check.value).toBe("iso-8859-1");
  });

  test("header utf-8, meta windows-1252: warns", () => {
    const check = run(doc(`<meta charset="windows-1252">`), UTF8_HEADER);
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Conflicting charset declarations: header utf-8, page windows-1252");
  });

  test("header and http-equiv disagree: warns", () => {
    const equiv = `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`;
    expect(run(doc(equiv), "text/html; charset=windows-1252").message).toBe(
      "Conflicting charset declarations: header windows-1252, page utf-8"
    );
  });

  test("utf8 and UTF-8 are one charset, not a conflict", () => {
    expect(run(doc(`<meta charset="utf8">`), "text/html; charset=UTF-8").status).toBe("pass");
  });

  test("two non-UTF-8 labels keep the Non-UTF-8 warning, naming the header's", () => {
    const check = run(doc(`<meta charset="windows-1252">`), "text/html; charset=iso-8859-1");
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Non-UTF-8 charset declared: iso-8859-1");
  });
});

describe("core/charset unchanged cases", () => {
  test("no declaration anywhere still fails", () => {
    const check = run(doc(VIEWPORT), "text/html");
    expect(check.status).toBe("fail");
    expect(check.message).toBe("No charset declaration found");
  });

  test("a non-UTF-8 meta with no header still warns", () => {
    const check = run(doc(`<meta charset="iso-8859-1">`));
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Non-UTF-8 charset declared: iso-8859-1");
  });

  test("http-equiv UTF-8 with no charset meta passes via http-equiv", () => {
    const equiv = `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`;
    expect(run(doc(equiv)).message).toBe("UTF-8 charset declared via http-equiv");
  });
});

// pub#1220: the header decides the decoding before any prescan, so a late meta
// that agrees with it is advice, not a warning.
describe("core/charset late meta with an agreeing Content-Type header (pub#1220)", () => {
  // The reporter's fixture: a ~7.8 kB inline script right after <head>.
  const FIXTURE = `<!doctype html>\n<html lang="en"><head><script data-source-attribution="shopify.exit_interstitial">/*${"x".repeat(7800)}*/</script><meta charset="utf-8"><title>Charset position test page</title><meta name="description" content="A page whose charset meta follows a large inline script."></head><body><h1>Test</h1><p>Hello</p></body></html>`;
  const MESSAGE =
    "The Content-Type header already sets UTF-8; moving the charset meta into the first 1024 bytes is a conformance fix only";

  test("the reporter's fixture with a UTF-8 header is info and says so", () => {
    expect(FIXTURE.indexOf(CHARSET)).toBeGreaterThan(1024);
    const check = run(FIXTURE, UTF8_HEADER);
    expect(check.status).toBe("info");
    expect(check.message).toBe(MESSAGE);
  });

  test("header labels the decoder treats alike agree: utf8, UTF-8, quoted", () => {
    for (const header of ["text/html; charset=utf8", "text/html; charset=UTF-8", 'text/html; charset="utf-8"']) {
      expect([header, run(FIXTURE, header).status]).toEqual([header, "info"]);
    }
  });

  test("a late http-equiv declaration with an agreeing header is info too", () => {
    const equiv = `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`;
    const html = doc(equiv, `<!-- ${"x".repeat(2000)} -->`);
    expect(run(html, UTF8_HEADER).status).toBe("info");
  });

  test("the same page with no charset in the header still warns", () => {
    for (const header of ["text/html", undefined]) {
      const check = run(FIXTURE, header);
      expect(check.status).toBe("warn");
      expect(check.message).toBe("Charset meta is not within the first 1024 bytes");
    }
  });

  test("a conflicting header still gives the conflict warning, wherever the meta sits", () => {
    const check = run(FIXTURE, "text/html; charset=iso-8859-1");
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Conflicting charset declarations: header iso-8859-1, page utf-8");
  });

  test("a non-UTF-8 page keeps the non-UTF-8 warning", () => {
    const late = FIXTURE.replace(CHARSET, `<meta charset="windows-1252">`);
    const check = run(late, "text/html; charset=windows-1252");
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Non-UTF-8 charset declared: windows-1252");
  });

  test("an early meta with the header is unchanged", () => {
    expect(run(doc(CHARSET), UTF8_HEADER).status).toBe("pass");
  });

  test("the verdict stays per page", () => {
    expect(charsetRule.meta.verdictScope).toBe("page");
  });
});
