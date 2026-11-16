// repo#1415: the CLI adapter must not carry its own copy of what the engine owns.

import * as engine from "@squirrelscan/audit-engine";
import { describe, expect, test } from "bun:test";

import * as adapter from "@/audit/adapter";

describe("CLI adapter delegates to the engine (repo#1415)", () => {
  test("buildSiteContext is the engine's function", () => {
    expect(adapter.buildSiteContext).toBe(engine.buildSiteContext);
  });
  test("parsePageRecord is the engine's function", () => {
    expect(adapter.parsePageRecord).toBe(engine.parsePageRecord);
  });
  test("hasAuditableHtmlBody is the engine's function", () => {
    expect(adapter.hasAuditableHtmlBody).toBe(engine.hasAuditableHtmlBody);
  });
  test("isAuditableEmptyBodyStatus is the engine's function", () => {
    expect(adapter.isAuditableEmptyBodyStatus).toBe(
      engine.isAuditableEmptyBodyStatus
    );
  });
});
