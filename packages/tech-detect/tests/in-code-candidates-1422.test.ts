// #1422: an `inCode` detector read a whole bundle and gave up after 64 matches that started inside strings, so the
// real call or config after them was never reached. The search now continues past the string a match was in, and
// its candidate bound is high enough for a whole bundle.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { inString, scanJs, stringEnd } from "../src/js-scan";

const SHELL = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>`;
const WHOLE = { maxScriptChars: 32 * 1024 * 1024 };
const detect = (content: string): string[] =>
  detectTechnologies({ url: "https://example.com/", headers: {}, html: SHELL, scripts: [{ url: "https://example.com/a.js", content }] }, undefined, WHOLE).map((t) => t.id);

const CODE_CONFIG = `var cfg={apiKey:"k",authDomain:"demo-app.firebaseapp.com",projectId:"demo-app"};initializeApp(cfg);`;
/** A mention of the config inside a string literal: docs text in a bundle, never the config. */
const mention = (i: number): string => `var d${i}='see {authDomain:"docs-${i}.firebaseapp.com"} in the docs';\n`;
const filler = (n: number): string => "var q=(a<<3)+b;if(q>9){q-=9}\n".repeat(n);

describe("the real match after many that start inside strings (#1422)", () => {
  test("65 separate mentions in strings, then the config in code, is found (64 used to be the limit)", () => {
    const body = Array.from({ length: 65 }, (_, i) => mention(i)).join("") + filler(50) + CODE_CONFIG;
    expect(detect(body)).toContain("firebase");
  });

  test("3,000 separate mentions, then the config in code, is found", () => {
    const body = Array.from({ length: 3_000 }, (_, i) => mention(i)).join("") + filler(50) + CODE_CONFIG;
    expect(detect(body)).toContain("firebase");
  });

  test("many mentions inside ONE string are one candidate", () => {
    const one = `var docs='${Array.from({ length: 20_000 }, (_, i) => `{authDomain:"docs-${i}.firebaseapp.com"} `).join("")}';\n`;
    expect(detect(one + CODE_CONFIG)).toContain("firebase");
  });

  test("comments are blanked, so a config only in comments and strings is still not detected", () => {
    const body = Array.from({ length: 200 }, (_, i) => mention(i)).join("") + `/* ${CODE_CONFIG} */\n// ${CODE_CONFIG}\n`;
    expect(detect(body)).not.toContain("firebase");
  });

  test("hostile bodies stay bounded: 8 MB of mentions with no real match, and one match in code at the very end", () => {
    const unit = mention(1);
    const body = unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length));
    const started = performance.now();
    expect(detect(body)).not.toContain("firebase");
    expect(detect(`${body}${CODE_CONFIG}`)).not.toContain("firebase"); // past the candidate bound: the bound is the work limit
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 60_000);
});

describe("the candidate bound is exactly 4,096 (a silent miss past it) (#1422)", () => {
  const withMentions = (mentions: number): string =>
    Array.from({ length: mentions }, (_, i) => mention(i)).join("") + CODE_CONFIG;

  test("the config after 4,095 string mentions is the 4,096th candidate and is found; after 4,096 or 4,097 it is not reached", () => {
    expect(detect(withMentions(4_095))).toContain("firebase");
    expect(detect(withMentions(4_096))).not.toContain("firebase");
    expect(detect(withMentions(4_097))).not.toContain("firebase");
  }, 60_000);
});

describe("stringEnd (#1422)", () => {
  const src = 'var a="one two";var b=\'three\';x=1;';
  const { strings } = scanJs(src);

  test("gives the closing quote of the string an index is inside, and -1 for code, the opening quote and past the end", () => {
    const aOpen = src.indexOf('"');
    const aClose = src.indexOf('"', aOpen + 1);
    for (const inside of [aOpen + 1, aOpen + 4, aClose]) expect(stringEnd(strings, inside)).toBe(aClose);
    const bOpen = src.indexOf("'");
    const bClose = src.indexOf("'", bOpen + 1);
    expect(stringEnd(strings, bOpen + 2)).toBe(bClose);
    expect(stringEnd(strings, aOpen)).toBe(-1); // the opening quote is code
    expect(stringEnd(strings, 0)).toBe(-1);
    expect(stringEnd(strings, src.indexOf("x=1"))).toBe(-1);
    expect(stringEnd(strings, src.length + 50)).toBe(-1);
    expect(stringEnd([], 5)).toBe(-1);
  });

  test("agrees with inString for every index of a mixed body", () => {
    const body = 'a="x";b=`t${1}y`;c=/r[/]/.test(d);e=\'z\';f(g);';
    const scanned = scanJs(body).strings;
    for (let i = 0; i <= body.length; i++) expect(stringEnd(scanned, i) !== -1, `index ${i}`).toBe(inString(scanned, i));
  });
});
