// The console table of `squirrel pages` prints values from audited pages, so none of them may carry a
// terminal escape, a C1 control or a bidi override (#701).

import type { PageMapRow } from "@squirrelscan/report";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { printTable } from "../../src/cli/commands/pages";

const ESC = String.fromCharCode(27);

function row(url: string): PageMapRow {
  return {
    url,
    finalUrl: url,
    status: 200,
    depth: 0,
    canonical: null,
    noindex: false,
    title: `T${ESC}[2J`,
    titleLength: 4,
    description: null,
    descriptionLength: 0,
    h1Count: 1,
    h1: "Heading",
    headingCount: 1,
    wordCount: 1,
    schemaTypes: [],
    schemaIds: [],
    inlinks: 0,
    internalOutlinks: 0,
    externalOutlinks: 0,
    externalDomains: [],
    loadTimeMs: 1,
    lastModified: null,
    flags: ["orphan"],
  };
}

let lines: string[] = [];
const original = console.log;
beforeEach(() => {
  lines = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  console.log = original;
});

describe("printTable", () => {
  test("a URL that does not parse is printed without its escape sequences and bidi overrides", () => {
    printTable(
      [
        row(
          `not a url${ESC}[2J${ESC}]8;;https://evil.example\u0007\u009b31m‮gnp.exe`
        ),
      ],
      1,
      `https://e.test/${ESC}[1;1H‮`
    );
    const out = lines.join("\n");
    expect(out).toContain("not a url");
    expect(out).not.toContain(ESC);
    expect(out).not.toContain("\u0007");
    expect(out).not.toContain("\u009b");
    expect(out).not.toContain("‮");
  });

  test("a URL with escapes in its path or query is percent-encoded by the parser and prints as text", () => {
    printTable(
      [row(`https://example.com/a${ESC}[2J?q=${ESC}[1;1H`)],
      1,
      "https://example.com"
    );
    const out = lines.join("\n");
    expect(out).not.toContain(ESC);
    expect(out).toContain("/a");
  });

  test("an ordinary page prints its path, status, lengths and flags", () => {
    printTable(
      [row("https://example.com/blog/a?x=1")],
      1,
      "https://example.com"
    );
    const out = lines.join("\n");
    expect(out).toContain("/blog/a?x=1");
    expect(out).toContain("orphan");
    expect(out).toContain("1 pages.");
  });
});
