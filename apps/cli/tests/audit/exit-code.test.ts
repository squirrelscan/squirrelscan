// The exit code precedence of `squirrel audit` and the outcome stamped on the report (#1657).

import { describe, expect, test } from "bun:test";

import {
  buildOutcome,
  computeExitCode,
  createSettler,
  publishSkipReason,
  type AuditOutcome,
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
    targeted: false,
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
    // #1777: a --target-url run is skipped like a rule-filtered one.
    ["a targeted run", { targeted: true, noPublish: true }, "targeted"],
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

describe("createSettler: the report is written and the code set however the publish phase ends", () => {
  function setup(
    opts: {
      status?: "completed" | "blocked" | "failed" | "partial";
      publish?: PublishOutcome;
      trips?: number;
      emitThrows?: boolean;
    } = {}
  ) {
    const log: string[] = [];
    let outcome: AuditOutcome | undefined;
    let code: number | undefined;
    let gateCalls = 0;
    let publish: PublishOutcome = opts.publish ?? skipped;
    const settler = createSettler({
      auditStatus: opts.status ?? "completed",
      getPublish: () => publish,
      evaluateGate: () => {
        gateCalls++;
        return { trips: Array.from({ length: opts.trips ?? 0 }, () => 0) };
      },
      stamp: (o) => {
        outcome = o;
        log.push("stamp");
      },
      emit: () => {
        log.push("emit");
        if (opts.emitThrows) throw new Error("disk full");
      },
      apply: (c) => {
        code = c;
        log.push("apply");
      },
    });
    return {
      settler,
      log,
      get outcome() {
        return outcome;
      },
      get code() {
        return code;
      },
      get gateCalls() {
        return gateCalls;
      },
      setPublish: (p: PublishOutcome) => {
        publish = p;
      },
    };
  }

  test("the normal path stamps, sets the code, then writes the report, once", () => {
    const t = setup({ trips: 1 });
    t.settler.settle();
    t.settler.settle();
    expect(t.log).toEqual(["stamp", "apply", "emit"]);
    expect(t.code).toBe(2);
    expect(t.outcome).toEqual({
      exit_code: 2,
      status: "completed",
      publish: { status: "skipped", reason: "offline" },
    });
    expect(t.settler.gate()?.trips.length).toBe(1);
  });

  test("a publish-phase step that throws: finish() still writes the report with a failed publish and sets the code", () => {
    const t = setup();
    // The publish phase threw after the audit finished, before settle() was reached.
    const phase = () => {
      throw new Error("could not record the published report");
    };
    expect(phase).toThrow();
    t.settler.finish("exception");
    expect(t.log).toEqual(["stamp", "apply", "emit"]);
    expect(t.code).toBe(1);
    expect(t.outcome?.publish).toEqual({
      status: "failed",
      reason: "exception",
    });
    expect(t.settler.settled()).toBe(true);
  });

  test("an interrupt settles the same way", () => {
    const t = setup();
    t.settler.finish("interrupted");
    expect(t.outcome?.publish).toEqual({
      status: "failed",
      reason: "interrupted",
    });
    expect(t.code).toBe(1);
  });

  test("finish() after settle() does nothing (the report is not written twice)", () => {
    const t = setup();
    t.settler.settle();
    t.settler.finish("exception");
    expect(t.log).toEqual(["stamp", "apply", "emit"]);
    expect(t.code).toBe(0);
  });

  test("a blocked audit keeps its code when the publish phase threw", () => {
    const t = setup({ status: "blocked" });
    t.settler.finish("exception");
    expect(t.code).toBe(3);
  });

  test("a failed explicit publish does not evaluate the gate; an auto-publish failure does", () => {
    const explicit = setup({ publish: explicitFail, trips: 1 });
    explicit.settler.settle();
    expect(explicit.gateCalls).toBe(0);
    expect(explicit.code).toBe(1);
    const auto = setup({ publish: autoFail, trips: 1 });
    auto.settler.settle();
    expect(auto.gateCalls).toBe(1);
    expect(auto.code).toBe(2);
  });

  test("the code is set even when writing the report throws", () => {
    const t = setup({ emitThrows: true });
    expect(() => t.settler.settle()).toThrow("disk full");
    expect(t.code).toBe(0);
  });

  test("the publish outcome is read when settle() runs, not when the settler is built", () => {
    const t = setup();
    t.setPublish({ status: "published", id: "r1" });
    t.settler.settle();
    expect(t.outcome?.publish).toEqual({ status: "published" });
  });
});
