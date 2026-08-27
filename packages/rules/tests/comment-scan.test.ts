// shared/comment-scan — the scanner behind perf/unminified-js and
// perf/unminified-css (#142). These are unit tests for the state machine
// itself; the rule-level behaviour lives in unminified-{js,css}.test.ts.

import { describe, expect, test } from "bun:test";

import { scanCssComments, scanJsComments } from "../src/shared/comment-scan";

function count(src: string) {
  const r = scanJsComments(src);
  return r.lineComments + r.blockComments;
}

describe("scanJsComments — literals are not comments", () => {
  test("`//` inside single, double and template quotes is ignored", () => {
    expect(count(`var a="https://a.example/x";`)).toBe(0);
    expect(count(`var a='https://a.example/x';`)).toBe(0);
    expect(count("var a=`https://a.example/x`;")).toBe(0);
  });

  test("`/*` inside a string is not a block comment opener", () => {
    expect(count(`var a="/* not a comment */",b="also /* not */";`)).toBe(0);
  });

  test("an escaped quote does not end the string early", () => {
    expect(count(`var a="he said \\"https://a.example\\" loudly";`)).toBe(0);
  });

  test("a backslash before CRLF continues the string instead of ending it", () => {
    // `i += 2` over `\` + CR would land on the LF and end the string early,
    // turning the next line into code and its `//` into a comment.
    expect(count('var a="x\\\r\n// still string";')).toBe(0);
  });

  test("an unterminated string stops at the line terminator, not at end of file", () => {
    expect(count("var a='oops\n// a real comment\n")).toBe(1);
    expect(count("var a='oops\r// a real comment\n")).toBe(1);
  });

  test("template interpolation returns to code, and nests", () => {
    // The `${...}` below are fixture text, not interpolations of this file.
    // oxlint-disable no-template-curly-in-string
    expect(count("var a=`x${b}y`;")).toBe(0);
    expect(count("var a=`x${ {p:1} }y//z`;")).toBe(0);
    expect(count("var a=`x${`inner//u`}y`;")).toBe(0);
    // A genuine comment inside an interpolation is still code, so still counted.
    expect(count("var a=`x${ b // note\n }y`;")).toBe(1);
    // oxlint-enable no-template-curly-in-string
  });
});

describe("scanJsComments — regex literals", () => {
  test("slashes inside a regex are not comments", () => {
    expect(count("var a=/https?:\\/\\//;")).toBe(0);
    expect(count("var a=/[/]/;")).toBe(0);
    expect(count('var a="x".replace(/\\/\\//g,"");')).toBe(0);
  });

  test("a regex at statement position after `}` is not read as division", () => {
    expect(count("function f(){}\n/a\\/\\/b/.test(q);")).toBe(0);
  });

  test("division is not mistaken for a regex", () => {
    expect(count("var a=1/2/3;\n// real\n")).toBe(1);
  });

  test("a pathological run of escaped slashes stays linear", () => {
    // Each `/` used to re-probe to end of line: O(n^2) on a multi-MB bundle.
    const src = `x=/${"\\/".repeat(500_000)}`;
    const started = performance.now();
    expect(count(src)).toBe(0);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("scanJsComments — genuine comments are still counted", () => {
  test("line and block comments, with byte totals matching the delimiters", () => {
    const r = scanJsComments("// one\nvar a=1;/* two */\n");
    expect(r.lineComments).toBe(1);
    expect(r.blockComments).toBe(1);
    expect(r.commentBytes).toBe("// one".length + "/* two */".length);
  });

  test("a comment after a string on the same line is counted, and only the comment", () => {
    const r = scanJsComments('var u="https://a.example/x"; // note\n');
    expect(r.lineComments).toBe(1);
    expect(r.commentBytes).toBe("// note".length);
  });

  test("the URL-scheme guard does not swallow a comment after a label", () => {
    expect(count("outer:// genuine comment\nfor(;;)break outer;")).toBe(1);
  });

  test("a sourceMappingURL comment is a comment", () => {
    expect(count("var a=1;\n//# sourceMappingURL=index.js.map")).toBe(1);
  });

  test("an unterminated block comment is not counted, matching the previous regex", () => {
    expect(count("var a=1;/* never closed")).toBe(0);
  });
});

describe("scanCssComments", () => {
  test("`/* */` inside a CSS string is not a comment", () => {
    expect(scanCssComments('a::before{content:"/* x */"}').blockComments).toBe(0);
    expect(scanCssComments("a::before{content:'/* x */'}").blockComments).toBe(0);
  });

  test("real comments are counted with their delimiters", () => {
    const r = scanCssComments('/* one */a{color:red}b::after{content:"/* no */"}/* two */');
    expect(r.blockComments).toBe(2);
    expect(r.commentBytes).toBe("/* one */".length + "/* two */".length);
  });

  test("a backslash before CRLF continues a CSS string", () => {
    expect(scanCssComments('a{content:"x\\\r\n/* still string */"}').blockComments).toBe(0);
  });
});
