import { describe, expect, test } from "bun:test";

import { TechDetectConfigSchema } from "../src/schema";

describe("[tech_detect] (#1254)", () => {
  test("bundle_bytes accepts 0 to 262144", () => {
    expect(TechDetectConfigSchema.parse({ bundle_bytes: 0 }).bundle_bytes).toBe(0);
    expect(TechDetectConfigSchema.parse({ bundle_bytes: 262_144 }).bundle_bytes).toBe(262_144);
    expect(TechDetectConfigSchema.safeParse({ bundle_bytes: 262_145 }).success).toBe(false);
    expect(TechDetectConfigSchema.safeParse({ bundle_bytes: -1 }).success).toBe(false);
  });

  test("an unknown key is an error, not silently dropped", () => {
    expect(TechDetectConfigSchema.safeParse({ bundle_byte: 1 }).success).toBe(false);
  });
});
