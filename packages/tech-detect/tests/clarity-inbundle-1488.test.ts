// #1488: Microsoft Clarity's loader bundled into a first-party script is found as code; the URL named in prose, a
// docs string, a comment or another host's `src` assignment is not.

import { describe, expect, test } from "bun:test";

import { bundleHints, detectTechnologies, SEGMENT_SEPARATOR, sampleBundleExtras } from "../src";

const SHELL = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><p>We use clarity.ms for analytics.</p></body></html>`;
const WHOLE = { maxScriptChars: 32 * 1024 * 1024 };
const ids = (content: string, options = WHOLE): string[] =>
  detectTechnologies({ url: "https://example.com/", headers: {}, html: SHELL, scripts: [{ url: "https://example.com/assets/app.js", content }] }, undefined, options).map((t) => t.id);
const filler = (n: number): string => "var q=(a<<3)+b;if(q>9){q-=9}\n".repeat(n);

// The standard snippet as a bundler leaves it.
const SNIPPET =
  '(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y)})(window,document,"clarity","script","abc123");';

describe("the loader in a bundle", () => {
  test("the standard snippet inside a bundled module", () => {
    expect(ids(`${filler(200)}function track(){${SNIPPET}}${filler(200)}`)).toContain("clarity");
  });
  test("setAttribute and template-literal forms, with or without www", () => {
    for (const code of [
      'var s=document.createElement("script");s.setAttribute("src","https://www.clarity.ms/tag/abc123");',
      "var s=document.createElement('script');s.setAttribute( 'src' , 'https://clarity.ms/tag/abc123' );",
      "s.src=`https://www.clarity.ms/tag/${projectId}`;",
      'script.src = "https://www.clarity.ms/tag/" + id;',
      "e.src='http://clarity.ms/tag/'+n;",
      's.src="//www.clarity.ms/tag/"+id;', // protocol-relative: the anchor is the same host and path
      "s.setAttribute ('src', 'https://www.clarity.ms/tag/abc');",
    ]) {
      expect(ids(`${filler(10)}${code}${filler(10)}`), code).toContain("clarity");
    }
  });
  test("deep in a big bundle: found where the window around the literal is sent, at the cloud caps", () => {
    const body = `${filler(15_000)}\n${SNIPPET}\n${filler(15_000)}`;
    expect(ids(body, { maxScriptChars: 32 * 1024 * 1024 })).toContain("clarity");
  });
});

describe("prose, comments and look-alikes are not the loader", () => {
  test("the URL in a docs string, a comment, a template of prose or a non-assignment", () => {
    for (const code of [
      'var docs="Install Clarity with t.src=\\"https://www.clarity.ms/tag/\\"+i in your head";',
      '/* t.src="https://www.clarity.ms/tag/"+i */',
      "// s.setAttribute('src','https://www.clarity.ms/tag/x')",
      'var help="see https://www.clarity.ms/tag/ for the tag format";',
      'var link={href:"https://www.clarity.ms/tag/abc"};',
      'x.src="https://example.com/tag/"+i;',
      'x.src="https://clarity.ms.evil.invalid/tag/"+i;',
      'var u="https://www.clarity.ms/s/0.7/clarity.js";',
      'x.src="www.clarity.ms/tag/"+i;', // scheme-less: neither a scheme nor `//`, a relative path
      'x.src="https://clarityXms/tag/"+i;', // the dot of `clarity.ms` is a dot
      'x.src="https://www.clarity-ms/tag/"+i;',
      // the whole loader assignment inside a string literal: its `.src =` is text, not code
      'var d=\'t.src="https://www.clarity.ms/tag/"+i\';',
      "var d2=\"t.src='https://www.clarity.ms/tag/'+i\";",
    ]) {
      expect(ids(`${filler(10)}${code}${filler(10)}`), code).not.toContain("clarity");
    }
  });
});

describe("hostile bodies stay bounded", () => {
  test("8 MB of near-miss assignments (the right shape with another path) and the real one at the very end", () => {
    const near = 'a.src="https://www.clarity.ms/tags/x"+i;b.src="https://www.clarity.ms/tag"+i;\n'.repeat(Math.ceil((8 * 1024 * 1024) / 80));
    const started = performance.now();
    expect(ids(near)).not.toContain("clarity");
    expect(ids(`${near}${SNIPPET}`)).toContain("clarity");
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 60_000);
});

describe("in a bundle too big to send whole (the sampler)", () => {
  test("the hint is declared and the window around the loader mid-file is sent, and detects", () => {
    expect(bundleHints()).toContain("clarity.ms/tag/");
    const body = `${filler(8_000)}\n${SNIPPET}\n${filler(8_000)}`;
    expect(body.length).toBeGreaterThan(400 * 1024);
    const head = body.slice(0, 16 * 1024);
    const extras = sampleBundleExtras(body, head.length, 24 * 1024);
    expect(extras).toContain('.src="https://www.clarity.ms/tag/"');
    // what a capped scan hands detection: the head, then the windows
    expect(ids(`${head}${SEGMENT_SEPARATOR}${extras}`, { maxScriptChars: 256 * 1024 })).toContain("clarity");
    // the head alone is not enough
    expect(ids(head, { maxScriptChars: 256 * 1024 })).not.toContain("clarity");
  });
});

describe("known limits: loaders written another way are not found", () => {
  test("the URL split by concatenation, held in a variable, as an object or JSX prop, assigned by index, or built in a template expression", () => {
    for (const code of [
      't.src="https://www.clarity.ms/"+"tag/"+i;',
      'var u="https://www.clarity.ms/tag/";t.src=u+i;',
      'h("script",{src:"https://www.clarity.ms/tag/"+i});',
      '<script src="https://www.clarity.ms/tag/abc"/>',
      't["src"]="https://www.clarity.ms/tag/"+i;',
      "var s=`${(function(){t.src='https://www.clarity.ms/tag/'+i})()}`;",
    ]) {
      expect(ids(`${filler(5)}${code}${filler(5)}`), code).not.toContain("clarity");
    }
  });
});
