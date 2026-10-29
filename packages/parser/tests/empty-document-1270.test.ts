// #1270: a body with no element in it (empty, whitespace, a comment, plain
// text, JSON, a bare doctype) left linkedom with `documentElement === null`,
// and `document.head` / `document.body` then threw. parseHTML now always
// returns a document with a root, head and body.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "../src/dom";
import { parseDocument } from "../src/index";
import { parsePage } from "../src/html";

const DEGENERATE: Array<[string, string]> = [
  ["empty", ""],
  ["whitespace", "   \n\t "],
  ["comment only", "<!-- c -->"],
  ["plain text", "plain text"],
  ["JSON", '{"json":1}'],
  ["bare doctype", "<!doctype html>"],
];

describe("degenerate documents (#1270)", () => {
  for (const [label, html] of DEGENERATE) {
    test(`parseHTML: ${label} has a root, head and body`, () => {
      const { document } = parseHTML(html);
      expect(document.documentElement).not.toBeNull();
      expect(document.head).toBeTruthy();
      expect(document.body).toBeTruthy();
    });

    test(`parseDocument: ${label} has a root, head and body`, () => {
      const document = parseDocument(html);
      expect(document.documentElement).not.toBeNull();
      expect(document.head).toBeTruthy();
      expect(document.body).toBeTruthy();
    });

    test(`parsePage: ${label} does not throw`, () => {
      expect(() => parsePage(html, "https://example.com/")).not.toThrow();
    });
  }

  test("text lands in the body, as in a browser", () => {
    expect(parseHTML("plain text").document.body.textContent).toBe("plain text");
  });

  test("a normal page is untouched", () => {
    const { document } = parseHTML("<html><head><title>t</title></head><body><p>x</p></body></html>");
    expect(document.title).toBe("t");
    expect(document.body.querySelectorAll("p").length).toBe(1);
  });
});
