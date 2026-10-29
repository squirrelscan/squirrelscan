import { describe, expect, test } from "bun:test";

import { StorageConfigSchema } from "../src/schema";

describe("[storage] store_scripts (#1255)", () => {
  test("off and uncapped by default", () => {
    const storage = StorageConfigSchema.parse({});
    expect(storage.store_scripts).toBeUndefined();
    expect(storage.store_scripts_max_bytes).toBeUndefined();
    expect(storage.store_scripts_total_bytes).toBeUndefined();
  });

  test("the caps take numbers and size strings", () => {
    const storage = StorageConfigSchema.parse({
      store_scripts: true,
      store_scripts_max_bytes: "2MB",
      store_scripts_total_bytes: 1_000_000,
    });
    expect(storage.store_scripts).toBe(true);
    expect(storage.store_scripts_max_bytes).toBe(2 * 1024 * 1024);
    expect(storage.store_scripts_total_bytes).toBe(1_000_000);
  });

  test("a bad size is an error that names the key", () => {
    const result = StorageConfigSchema.safeParse({ store_scripts_max_bytes: "lots" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("store_scripts_max_bytes");
  });

  test("store_scripts_max_scripts is a whole number from 1 to 500", () => {
    expect(StorageConfigSchema.parse({ store_scripts_max_scripts: 200 }).store_scripts_max_scripts).toBe(200);
    expect(StorageConfigSchema.safeParse({ store_scripts_max_scripts: 0 }).success).toBe(false);
    expect(StorageConfigSchema.safeParse({ store_scripts_max_scripts: 501 }).success).toBe(false);
    expect(StorageConfigSchema.safeParse({ store_scripts_max_scripts: 1.5 }).success).toBe(false);
  });
});
