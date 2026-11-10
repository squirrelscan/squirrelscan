// isAuditFailed and isScoreless, the one definition of "failed or blocked" (#1662).

import { describe, expect, test } from "bun:test";

import { auditStatusToLifecycle, isAuditFailed, isScoreless, type AuditStatus } from "../src/index";

const table: Array<[AuditStatus | null | undefined, boolean, "completed" | "failed"]> = [
  ["completed", false, "completed"],
  ["partial", false, "completed"],
  ["failed", true, "failed"],
  ["blocked", true, "failed"],
  [undefined, false, "completed"],
  [null, false, "completed"],
];

describe("audit status predicates", () => {
  for (const [status, failed, lifecycle] of table) {
    test(`${String(status)}: failed ${failed}, lifecycle ${lifecycle}`, () => {
      expect(isAuditFailed(status)).toBe(failed);
      expect(isScoreless(status)).toBe(failed);
      expect(auditStatusToLifecycle(status)).toBe(lifecycle);
    });
  }

  test("a partial audit keeps its score and is not failed", () => {
    expect(isScoreless("partial")).toBe(false);
    expect(isAuditFailed("partial")).toBe(false);
  });
});
