// The exit code precedence of `squirrel audit` and the outcome stamped on the report (#1657).

import { describe, expect, test } from "bun:test";

import {
  buildOutcome,
  computeExitCode,
  publishSkipReason,
  type ExitInput,
  type PublishOutcome,
} from "@/audit/exit-code";

const skipped: PublishOutcome = { status: "skipped", reason: "offline" };
const published: PublishOutcome = { status: "published", id: "r1" };
const explicitFail: PublishOutcome = {
  status: "failed",
  reason: "PAYLOAD_TOO_LARGE",
  explicit: true,
};
const autoFail: PublishOutcome = {
  status: "failed",
  reason: "TOKEN_INVALID",
  explicit: false,
};

// [name, input, code, reason]. Rows marked CHANGED are the two cases #1657 changes; every other
// row is the code the command returned before (pinned end to end in tests/cli/audit-exit-codes-1657-e2e.test.ts).
const TABLE: Array<[string, ExitInput, number, string]> = [
  ["ok", { auditStatus: "completed", publish: skipped }, 0, "ok"],
  [
    "ok and published",
    { auditStatus: "completed", publish: published },
    0,
    "ok",
  ],
  [
    "partial (cut short by --max-duration) exits 0",
    { auditStatus: "partial", publish: skipped },
    0,
    "ok",
  ],
  ["failed", { auditStatus: "failed", publish: skipped }, 1, "failed"],
  ["blocked", { auditStatus: "blocked", publish: skipped }, 3, "blocked"],
  ["redirected", { early: "redirected" }, 4, "redirected"],
  ["unreachable", { early: "unreachable" }, 5, "unreachable"],
  ["audit error", { early: "error" }, 1, "error"],
  ["validation error", { early: "validation" }, 1, "validation"],
  [
    "fail-on tripped",
    { auditStatus: "completed", publish: skipped, gateTripped: true },
    2,
    "gate",
  ],
  [
    "fail-on tripped on a partial report",
    { auditStatus: "partial", publish: published, gateTripped: true },
    2,
    "gate",
  ],
  [
    "explicit publish failure on an ok audit",
    { auditStatus: "completed", publish: explicitFail },
    1,
    "publish-failed",
  ],
  [
    "explicit publish failure outranks the gate",
    { auditStatus: "completed", publish: explicitFail, gateTripped: true },
    1,
    "publish-failed",
  ],
  [
    "failed audit with an explicit publish failure",
    { auditStatus: "failed", publish: explicitFail },
    1,
    "failed",
  ],
  // CHANGED: was 1 (the explicit-publish early return skipped the blocked code).
  [
    "blocked audit with an explicit publish failure",
    { auditStatus: "blocked", publish: explicitFail },
    3,
    "blocked",
  ],
  // Unchanged decision, now written down: an auto-publish is a side effect of a successful audit.
  [
    "auto-publish failure exits 0, the failure is in the outcome",
    { auditStatus: "completed", publish: autoFail },
    0,
    "ok",
  ],
  [
    "auto-publish failure does not hide a tripped gate",
    { auditStatus: "completed", publish: autoFail, gateTripped: true },
    2,
    "gate",
  ],
  [
    "auto-publish failure on a blocked audit",
    { auditStatus: "blocked", publish: autoFail },
    3,
    "blocked",
  ],
];

describe("computeExitCode precedence", () => {
  for (const [name, input, code, reason] of TABLE) {
    test(`${name}: ${code}`, () => {
      expect(computeExitCode(input)).toEqual({
        code,
        reason: reason as ReturnType<typeof computeExitCode>["reason"],
      });
    });
  }

  test("a run that never produced a report ignores everything after it", () => {
    expect(
      computeExitCode({
        early: "unreachable",
        auditStatus: "blocked",
        publish: explicitFail,
        gateTripped: true,
      }).code
    ).toBe(5);
    expect(
      computeExitCode({ early: "redirected", gateTripped: true }).code
    ).toBe(4);
  });

  test("the codes are the documented ones", () => {
    const codes = new Set(TABLE.map((row) => row[2]));
    expect([...codes].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("buildOutcome", () => {
  test("carries the code, the status and the publish result", () => {
    expect(buildOutcome(0, "completed", published)).toEqual({
      exit_code: 0,
      status: "completed",
      publish: { status: "published" },
    });
    expect(buildOutcome(0, undefined, skipped)).toEqual({
      exit_code: 0,
      status: "completed",
      publish: { status: "skipped", reason: "offline" },
    });
  });

  test("a failed publish carries its code and never a message", () => {
    expect(buildOutcome(1, "completed", explicitFail)).toEqual({
      exit_code: 1,
      status: "completed",
      publish: { status: "failed", reason: "PAYLOAD_TOO_LARGE" },
    });
    expect(buildOutcome(0, "completed", autoFail).publish).toEqual({
      status: "failed",
      reason: "TOKEN_INVALID",
    });
  });
});

describe("publishSkipReason follows the publish decision's order", () => {
  const base = {
    nonPublicHost: false,
    serverIgnoredEphemeral: false,
    offline: false,
    ephemeral: false,
    explicitPublish: false,
    ruleFilterActive: false,
    noPublish: false,
    configPublish: true,
  };
  const cases: Array<[string, Partial<typeof base>, string]> = [
    [
      "a non-public host wins over everything",
      { nonPublicHost: true, offline: true, noPublish: true },
      "non-public-host",
    ],
    [
      "the server ignored ephemeral",
      { serverIgnoredEphemeral: true },
      "server-ignored-ephemeral",
    ],
    ["offline", { offline: true, noPublish: true }, "offline"],
    ["ephemeral without --publish", { ephemeral: true }, "ephemeral"],
    [
      "a rule filter",
      { ruleFilterActive: true, noPublish: true },
      "rule-filter",
    ],
    ["--no-publish", { noPublish: true }, "no-publish"],
    ["[cloud] publish = false", { configPublish: false }, "config-off"],
    ["nothing else: signed out", {}, "signed-out"],
  ];
  for (const [name, over, reason] of cases) {
    test(`${name} -> ${reason}`, () => {
      expect(publishSkipReason({ ...base, ...over })).toBe(
        reason as ReturnType<typeof publishSkipReason>
      );
    });
  }
});
