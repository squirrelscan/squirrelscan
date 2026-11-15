// repo#1415: the CLI adapter must not carry its own copy of what the engine owns.

import { describe, expect, test } from "bun:test";
import * as engine from "@squirrelscan/audit-engine";

import * as adapter from "@/audit/adapter";

describe("CLI adapter delegates to the engine (repo#1415)", () => {
  test.each([
    "buildSiteContext",
    "parsePageRecord",
    "getParsedPages",
    "hasAuditableHtmlBody",
    "isAuditableEmptyBodyStatus",
  ] as const)("%s is the engine's function", (name) => {
    expect(adapter[name]).toBe(engine[name]);
  });
});
