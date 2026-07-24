// Unit tests for the sub-resource Vary-gating predicate (#107).

import { describe, expect, test } from "bun:test";

import { varyForbidsReuse } from "../src/resource-checker";

describe("varyForbidsReuse", () => {
  test("allows reuse when Vary is absent / empty", () => {
    expect(varyForbidsReuse(null)).toBe(false);
    expect(varyForbidsReuse(undefined)).toBe(false);
    expect(varyForbidsReuse("")).toBe(false);
  });

  test("allows reuse for Accept-Encoding only (transport, not request-content)", () => {
    expect(varyForbidsReuse("Accept-Encoding")).toBe(false);
    expect(varyForbidsReuse("accept-encoding")).toBe(false);
    expect(varyForbidsReuse(" Accept-Encoding ")).toBe(false);
  });

  test("blocks reuse for content-negotiating Vary fields", () => {
    expect(varyForbidsReuse("User-Agent")).toBe(true);
    expect(varyForbidsReuse("Accept")).toBe(true);
    expect(varyForbidsReuse("Cookie")).toBe(true);
    expect(varyForbidsReuse("*")).toBe(true);
  });

  test("blocks reuse when any non-encoding field is present alongside Accept-Encoding", () => {
    expect(varyForbidsReuse("Accept-Encoding, User-Agent")).toBe(true);
    expect(varyForbidsReuse("Accept-Encoding, *")).toBe(true);
  });
});
