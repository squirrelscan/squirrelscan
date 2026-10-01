// repo#2342: `[storage] content_store_max_bytes` and the env var that overrides it
// accept a byte count or a size string.

import { describe, expect, test } from "bun:test";

import { parseByteSize } from "../src/byte-size";
import { StorageConfigSchema } from "../src/schema";

const GiB = 1024 ** 3;

describe("parseByteSize", () => {
  test("reads whole bytes, as a number or a string", () => {
    expect(parseByteSize(1)).toBe(1);
    expect(parseByteSize(4_294_967_296)).toBe(4 * GiB);
    expect(parseByteSize("4294967296")).toBe(4 * GiB);
    expect(parseByteSize(" 512 ")).toBe(512);
  });

  test("reads binary units, any case, with or without a space", () => {
    expect(parseByteSize("4GB")).toBe(4 * GiB);
    expect(parseByteSize("4 gib")).toBe(4 * GiB);
    expect(parseByteSize("4g")).toBe(4 * GiB);
    expect(parseByteSize("512MB")).toBe(512 * 1024 ** 2);
    expect(parseByteSize("64KiB")).toBe(64 * 1024);
    expect(parseByteSize("1.5GB")).toBe(1.5 * GiB);
    expect(parseByteSize("2TB")).toBe(2 * 1024 ** 4);
    expect(parseByteSize("10B")).toBe(10);
  });

  test("a long run of whitespace is refused without backtracking", () => {
    // CodeQL flagged the first pattern as polynomial on "0" + many spaces.
    const started = performance.now();
    expect(parseByteSize(`0${" ".repeat(100_000)}x`)).toBeNull();
    expect(parseByteSize(`1${"\t".repeat(100_000)}GB`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("refuses anything that is not a positive size", () => {
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "",
      "0",
      "0GB",
      "-1GB",
      "1.5",
      "GB",
      "4 PB",
      "4GBs",
      "four",
      "0.0000001KB",
      null,
      undefined,
      {},
    ]) {
      expect(parseByteSize(bad)).toBeNull();
    }
  });
});

describe("[storage] content_store_max_bytes", () => {
  test("is optional, so an unset cap leaves the CLI default in force", () => {
    expect(StorageConfigSchema.parse({}).content_store_max_bytes).toBeUndefined();
  });

  test("normalizes a size string to bytes", () => {
    expect(StorageConfigSchema.parse({ content_store_max_bytes: "4GB" }).content_store_max_bytes).toBe(
      4 * GiB,
    );
    expect(
      StorageConfigSchema.parse({ content_store_max_bytes: 2_000_000_000 }).content_store_max_bytes,
    ).toBe(2_000_000_000);
  });

  test("rejects a bad value with a message that names the setting", () => {
    const result = StorageConfigSchema.safeParse({ content_store_max_bytes: "lots" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain("content_store_max_bytes");
    }
  });
});
