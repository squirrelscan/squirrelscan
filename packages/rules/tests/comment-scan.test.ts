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
    // Even a label named after a scheme: a URL has a host right after the
    // slashes, so anything else there means this is a comment.
    const src = Array.from({ length: 4 }, (_, i) => `http:// real comment ${i}`).join("\n");
    const r = scanJsComments(src);
    expect(r.lineComments).toBe(4);
    expect(r.commentBytes).toBe((src.match(/\/\/[^\n]*/g) ?? []).join("").length);
    // The host check must not depend on an ASCII-only whitespace test.
    expect(count("http:// real comment\n0;")).toBe(1);
    // A real URL still suppresses the guard.
    expect(count("var u=x;https://example.com/a\n")).toBe(0);
  });

  test("a sourceMappingURL comment is a comment", () => {
    expect(count("var a=1;\n//# sourceMappingURL=index.js.map")).toBe(1);
  });

  test("an unterminated block comment is not counted, matching the previous regex", () => {
    expect(count("var a=1;/* never closed")).toBe(0);
  });
});

// Review round 2 found the regex/division classifier swallowing comments: a `/`
// read as a regex opener scans forward for a closing `/` and can consume the
// `//` of a real comment. Each case below is checked against the byte total the
// old `/\/\/[^\n]*/g` produced, which was correct for these inputs.
describe("scanJsComments — division is not a regex opener", () => {
  const x4 = (line: string) => Array.from({ length: 4 }, (_, i) => `${line} ${i}`).join("\n");

  test.each([
    ["postfix increment", "i++ / n // real"],
    ["postfix decrement", "i-- / n // real"],
    ["object literal", "const q = {} / n // real"],
    ["regex literal with no flags", "var r=/a/ / n // real"],
  ])("`/` after %s divides, so the comment behind it is still counted", (_label, line) => {
    const src = x4(line);
    const r = scanJsComments(src);
    expect(r.lineComments).toBe(4);
    expect(r.commentBytes).toBe((src.match(/\/\/[^\n]*/g) ?? []).join("").length);
  });

  test("a regex is never closed on a comment opener", () => {
    // `/ n //` is division then a comment, not a regex body ending at the `//`.
    // A regex being divided or multiplied is not real code, so `//` and `/*`
    // immediately after a candidate closing slash reject the whole probe.
    expect(count("x = y / n /* real */ z")).toBe(1);
  });

  test("`/` after the `)` of a control flow head opens a regex", () => {
    // The `//` here sits inside a character class, so it is not a comment.
    for (const head of ["if(ok)", "while(ok)", "for(;;)"]) {
      expect(count(x4(`${head}/[//]/.test(s);`))).toBe(0);
    }
  });

  test("`/` after any other `)` divides", () => {
    expect(count(x4("var v = f(a) / n // real"))).toBe(4);
  });

  test("parens inside strings and comments never enter the paren matching", () => {
    // The `(` lives in a string, so the `)` below belongs to `if(`, not to it.
    expect(count('if(t("(")) /[//]/.test(s);')).toBe(0);
  });

  test("a comment between the keyword and its `(` does not hide the head", () => {
    // The head is decided from the scanner's own token state, so the comment is
    // already stepped over. Reading the raw source backwards could not cross it,
    // and counted the `//` inside the character class as a second comment.
    expect(count("if/*c*/(ok)/[//]/.test(s);")).toBe(1);
    expect(count("while /*c*/ (x) /[//]/.test(s);")).toBe(1);
    expect(count("for/*c*/(;;)/[//]/.test(s);")).toBe(1);
  });

  test.each([
    ["NBSP", "\u00a0"],
    ["LINE SEPARATOR", "\u2028"],
    ["PARAGRAPH SEPARATOR", "\u2029"],
    ["IDEOGRAPHIC SPACE", "\u3000"],
    ["BOM", "\ufeff"],
    ["NARROW NO-BREAK SPACE", "\u202f"],
  ])("%s between the keyword and its `(` is whitespace, not a token", (_label, space) => {
    const src = Array.from({ length: 4 }, (_, i) => `if${space}(ok)/[//]/.test(s${i});`).join("\n");
    // Four of these crossed COMMENT_COUNT_THRESHOLD and flagged comment-free code.
    expect(count(src)).toBe(0);
  });

  test("the open-paren stack is capped, so unmatched `(` cannot grow memory", () => {
    const before = process.memoryUsage().heapUsed;
    expect(count("(".repeat(2_000_000))).toBe(0);
    // Unbounded, this held one array slot per `(`: ~45MB of heap for 5M parens.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(8_000_000);
  });
});

// Known, deliberate residuals of treating `/` heuristically instead of parsing.
// Pinned so a future change makes a considered decision rather than an accident.
describe("scanJsComments — accepted misreadings", () => {
  test("a regex used as the left operand of `*` or `/` is read as division", () => {
    // `/a/*2` is valid JavaScript, and multiplying by a regex is not real code,
    // so the scanner prefers to keep `/*` and `//` countable as comments.
    expect(count("const x=/a/*2;// real")).toBe(0);
    expect(count("const x=/[//]//2;")).toBe(1);
  });

  test("a regex directly after a non control flow `)` is read as division", () => {
    expect(count("f(a)/[//]/.test(s);")).toBe(1);
  });

  test("a regex as the right operand of `/` after `}` is read as division", () => {
    // `{}` is treated as a closed block, so the `/` after it opens a regex, and
    // that regex probe stops at the second `/`. More regex arithmetic, and the
    // same trade as above: `}` at statement position is the common case.
    expect(count("const x = {} / /[//]/;")).toBe(1);
  });
});

describe("scanJsComments — deliberately not counted", () => {
  test("a `#!` shebang is not a comment, matching the old regex", () => {
    expect(count("#!/usr/bin/env node\nvar a=1;")).toBe(0);
  });

  test("an Annex B `<!--` HTML-style comment is not counted, matching the old regex", () => {
    expect(count("<!-- not counted\nvar a=1;")).toBe(0);
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
