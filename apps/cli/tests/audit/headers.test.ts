import { describe, expect, test } from "bun:test";

import {
  normalizeHeaderArgs,
  parseHeaders,
  redactHeaders,
} from "../../src/audit/headers";

describe("normalizeHeaderArgs", () => {
  test("undefined → empty list", () => {
    expect(normalizeHeaderArgs(undefined)).toEqual([]);
  });

  test("single string → one spec", () => {
    expect(normalizeHeaderArgs("Authorization: Bearer x")).toEqual([
      "Authorization: Bearer x",
    ]);
  });

  test("array → trimmed, blanks dropped", () => {
    expect(normalizeHeaderArgs(["  A: 1 ", "", "  ", "B: 2"])).toEqual([
      "A: 1",
      "B: 2",
    ]);
  });

  test("does NOT split on commas (structured-field values keep commas)", () => {
    expect(normalizeHeaderArgs('Signature-Input: sig=("a" "b"), x=1')).toEqual([
      'Signature-Input: sig=("a" "b"), x=1',
    ]);
  });
});

describe("parseHeaders", () => {
  test("parses Name: Value, splitting on the first colon only", () => {
    const r = parseHeaders(["X-Foo: a:b:c"]);
    expect(r.errors).toEqual([]);
    expect(r.headers).toEqual({ "X-Foo": "a:b:c" });
  });

  test("preserves quoting verbatim (Web Bot Auth Signature-Agent)", () => {
    const r = parseHeaders(['Signature-Agent: "https://shopify.com"']);
    expect(r.errors).toEqual([]);
    expect(r.headers).toEqual({ "Signature-Agent": '"https://shopify.com"' });
  });

  test("trims surrounding whitespace on name and value", () => {
    const r = parseHeaders(["  Authorization :  Bearer token  "]);
    expect(r.headers).toEqual({ Authorization: "Bearer token" });
  });

  test("later duplicate of a name wins", () => {
    const r = parseHeaders(["X-Foo: first", "X-Foo: second"]);
    expect(r.headers).toEqual({ "X-Foo": "second" });
  });

  test("allows an empty value", () => {
    const r = parseHeaders(["X-Empty:"]);
    expect(r.errors).toEqual([]);
    expect(r.headers).toEqual({ "X-Empty": "" });
  });

  test("rejects a spec with no colon", () => {
    const r = parseHeaders(["NoColonHere"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("NoColonHere");
    expect(r.headers).toEqual({});
  });

  test("rejects an invalid header name but keeps the valid ones", () => {
    const r = parseHeaders(["Bad Name: x", "X-Good: y"]);
    expect(r.errors).toHaveLength(1);
    expect(r.headers).toEqual({ "X-Good": "y" });
  });

  test("rejects an empty header name", () => {
    const r = parseHeaders([": orphan"]);
    expect(r.errors).toHaveLength(1);
    expect(r.headers).toEqual({});
  });

  test("rejects a value with CR/LF/NUL (header injection), keeps valid ones", () => {
    const r = parseHeaders([
      "X-Evil: a\r\nInjected: 1",
      "X-Nul: a\x00b",
      "X-Good: ok",
    ]);
    expect(r.errors).toHaveLength(2);
    expect(r.headers).toEqual({ "X-Good": "ok" });
  });

  test("accepts extended (obs-text) bytes in a value", () => {
    const r = parseHeaders(["X-Name: café"]);
    expect(r.errors).toEqual([]);
    expect(r.headers).toEqual({ "X-Name": "café" });
  });
});

describe("redactHeaders", () => {
  test("empty/undefined → empty string", () => {
    expect(redactHeaders(undefined)).toBe("");
    expect(redactHeaders({})).toBe("");
  });

  test("shows names only, never values", () => {
    const out = redactHeaders({
      Authorization: "Bearer secret",
      "X-Foo": "topsecret",
    });
    expect(out).toContain("Authorization");
    expect(out).toContain("X-Foo");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("topsecret");
  });
});
