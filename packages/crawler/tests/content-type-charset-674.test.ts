// pub#674: the charset parameter of a Content-Type value, kept beside the
// media type so core/charset can read a header-only declaration.

import { describe, expect, test } from "bun:test";

import { contentTypeCharset } from "../src/fetcher";

describe("contentTypeCharset", () => {
  test.each([
    ["text/html; charset=utf-8", "utf-8"],
    ["text/html;charset=UTF-8", "UTF-8"],
    ['text/html; charset="UTF-8"', "UTF-8"],
    ["text/html; CHARSET = iso-8859-1 ", "iso-8859-1"],
    ["text/html; boundary=x; charset=windows-1252", "windows-1252"],
    // A `;` inside a quoted value does not start a parameter.
    ['text/html; note="a;charset=iso-8859-1;b"; charset=utf-8', "utf-8"],
    // A quoted value drops its escapes.
    ['text/html; charset="utf\\-8"', "utf-8"],
  ])("%s -> %s", (value, expected) => {
    expect(contentTypeCharset(value)).toBe(expected);
  });

  test.each([
    [null],
    [""],
    ["text/html"],
    ["text/html; charset="],
    ["text/html; charset"],
    ["text/html; xcharset=utf-8"],
    // Not a token: a duplicated header comma-joined by fetch, or junk.
    ["text/html; charset=utf-8, text/html"],
    [`text/html; charset=${"a".repeat(41)}`],
  ])("%s -> null", (value) => {
    expect(contentTypeCharset(value)).toBeNull();
  });
});
