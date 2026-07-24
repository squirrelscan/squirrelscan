import { describe, it, expect } from "bun:test";

import { isUUID, isShortId } from "@/utils/validation";

describe("isUUID", () => {
  it("returns true for valid UUID v4", () => {
    expect(isUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("returns false for non-UUID strings", () => {
    expect(isUUID("not-a-uuid")).toBe(false);
    expect(isUUID("nikcub.me")).toBe(false);
    expect(isUUID("https://example.com")).toBe(false);
  });

  it("returns false for UUID-like but invalid", () => {
    expect(isUUID("550e8400-e29b-41d4-a716")).toBe(false); // Too short
    expect(isUUID("550e8400-e29b-41d4-a716-446655440000-extra")).toBe(false);
  });

  it("handles uppercase UUIDs", () => {
    expect(isUUID("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isUUID("")).toBe(false);
  });

  it("returns false for malformed separators", () => {
    expect(isUUID("550e8400_e29b_41d4_a716_446655440000")).toBe(false);
  });
});

describe("isShortId", () => {
  it("returns true for valid 8-char hex string", () => {
    expect(isShortId("0a25483c")).toBe(true);
    expect(isShortId("deadbeef")).toBe(true);
    expect(isShortId("12345678")).toBe(true);
  });

  it("handles uppercase hex", () => {
    expect(isShortId("DEADBEEF")).toBe(true);
    expect(isShortId("AbCdEf12")).toBe(true);
  });

  it("returns false for wrong length", () => {
    expect(isShortId("0a2548")).toBe(false); // Too short
    expect(isShortId("0a25483c0")).toBe(false); // Too long
  });

  it("returns false for non-hex characters", () => {
    expect(isShortId("0a25483g")).toBe(false);
    expect(isShortId("zzzzzzzz")).toBe(false);
  });

  it("returns false for domain names and other strings", () => {
    expect(isShortId("example.")).toBe(false);
    expect(isShortId("nikcub.m")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isShortId("")).toBe(false);
  });
});
