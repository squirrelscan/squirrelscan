import { describe, expect, test } from "bun:test";

import { TechDetectConfigSchema } from "../src/schema";

describe("[tech_detect] (#1254)", () => {
  test("bundle_bytes accepts 0 to 16 MiB, so 8 MB is allowed (#1387)", () => {
    expect(TechDetectConfigSchema.parse({ bundle_bytes: 0 }).bundle_bytes).toBe(0);
    expect(TechDetectConfigSchema.parse({ bundle_bytes: 262_144 }).bundle_bytes).toBe(262_144);
    expect(TechDetectConfigSchema.parse({ bundle_bytes: 8 * 1024 * 1024 }).bundle_bytes).toBe(8 * 1024 * 1024);
    expect(TechDetectConfigSchema.parse({ bundle_bytes: 16 * 1024 * 1024 }).bundle_bytes).toBe(16 * 1024 * 1024);
    expect(TechDetectConfigSchema.safeParse({ bundle_bytes: 16 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(TechDetectConfigSchema.safeParse({ bundle_bytes: -1 }).success).toBe(false);
  });

  test("an unknown key is an error, not silently dropped", () => {
    expect(TechDetectConfigSchema.safeParse({ bundle_byte: 1 }).success).toBe(false);
  });
});
