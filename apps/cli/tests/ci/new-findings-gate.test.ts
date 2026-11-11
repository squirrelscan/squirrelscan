// #1776: `squirrel ci` flow and exit codes, over a scripted fake API (no network, no patches).

import { describe, expect, test } from "bun:test";

import {
  type ApiReply,
  type CompareResponse,
  type GateDeps,
  type GateOptions,
  decideExit,
  runNewFindingsGate,
} from "@/ci/new-findings-gate";

const OPTS: GateOptions = {
  url: "https://shop.example.com/",
  websiteId: "web_1",
  failOn: "error",
  timeoutMs: 10 * 60_000,
  pollIntervalMs: 1000,
  json: false,
};

type Handler = (
  method: string,
  path: string,
  body?: unknown
) => ApiReply<unknown> | undefined;

function ok<T>(data: T): ApiReply<T> {
  return { ok: true, status: 200, data };
}

function harness(handlers: Handler[]) {
  const clock = { t: 0 };
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const queue = [...handlers];
  const deps: GateDeps = {
    request: async <T>(
      method: "GET" | "POST",
      path: string,
      body?: unknown
    ) => {
      calls.push({ method, path, body });
      for (const h of queue) {
        const r = h(method, path, body);
        if (r) return r as ApiReply<T>;
      }
      return { ok: false, status: 500, data: null } as ApiReply<T>;
    },
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, calls, out, err };
}

const credits = (totals: number[]): Handler => {
  let i = 0;
  return (m, p) =>
    m === "GET" && p === "/v1/credits"
      ? ok({ balance: { total: totals[Math.min(i++, totals.length - 1)] } })
      : undefined;
};
const start: Handler = (m, p) =>
  m === "POST" && p === "/v1/agent-runs"
    ? { ok: true, status: 201, data: { id: "run_2", status: "pending" } }
    : undefined;
const runDone =
  (extra: Record<string, unknown> = {}): Handler =>
  (m, p) =>
    m === "GET" && p === "/v1/agent-runs/run_2"
      ? ok({ id: "run_2", status: "completed", reportId: "rep_2", ...extra })
      : undefined;
const compare =
  (body: CompareResponse): Handler =>
  (m, p) =>
    m === "GET" && p.startsWith("/v1/websites/web_1/audits/compare")
      ? ok(body)
      : undefined;

const failBody: CompareResponse = {
  comparison: {
    head: {
      runId: "run_2",
      reportId: "rep_2",
      healthScore: 81,
      status: "completed",
    },
    newBySeverity: { error: 1 },
    findings: [
      {
        kind: "new",
        ruleId: "links/broken-internal",
        severity: "error",
        pageUrl: "https://shop.example.com/a",
      },
      {
        kind: "resolved",
        ruleId: "core/meta-title",
        severity: "warning",
        pageUrl: "https://shop.example.com/b",
      },
    ],
  },
  gate: {
    failOn: "error",
    status: "fail",
    newAtOrAbove: 1,
    resolved: 1,
    notCompared: { notCrawled: 2, notChecked: 3 },
    reason: "1 new error since the previous audit",
  },
};

describe("runNewFindingsGate", () => {
  test("a gate that fails exits 2, lists new and resolved, the counts, the report and the credits", async () => {
    const h = harness([
      credits([100, 52]),
      start,
      runDone(),
      compare(failBody),
    ]);
    const res = await runNewFindingsGate(h.deps, OPTS);
    expect(res).toEqual({ code: 2, reason: "new_findings" });
    const text = h.out.join("\n");
    expect(text).toContain("links/broken-internal");
    expect(text).toContain("https://shop.example.com/a");
    expect(text).toContain("New findings (1)");
    expect(text).toContain("Resolved findings (1");
    expect(text).toContain("core/meta-title");
    expect(text).toContain("2 on pages not crawled, 3 from rules not run");
    expect(text).toContain("https://reports.squirrelscan.com/rep_2");
    expect(text).toContain("Credits used: 48");
    const post = h.calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({
      websiteId: "web_1",
      url: OPTS.url,
      trigger: "api",
    });
    const cmp = h.calls.find((c) => c.path.includes("/audits/compare"))!;
    expect(cmp.path).toContain("head=run_2");
    expect(cmp.path).toContain("fail_on=error");
  });

  test("a passing gate exits 0 and resolved findings do not fail it", async () => {
    const body: CompareResponse = {
      ...failBody,
      comparison: {
        ...failBody.comparison,
        findings: [failBody.comparison!.findings![1]!],
      },
      gate: {
        ...failBody.gate,
        status: "pass",
        newAtOrAbove: 0,
        reason: "no new findings",
      },
    };
    const h = harness([credits([10]), start, runDone(), compare(body)]);
    expect(await runNewFindingsGate(h.deps, OPTS)).toEqual({
      code: 0,
      reason: "pass",
    });
    expect(h.out.join("\n")).toContain("Resolved findings (1");
  });

  test("the first audit of a website prints no baseline and exits 0", async () => {
    const body: CompareResponse = {
      comparison: {
        firstRun: true,
        head: { status: "completed", reportId: "rep_2" },
        findings: [],
      },
      gate: {
        status: "no_baseline",
        newAtOrAbove: 0,
        resolved: 0,
        notCompared: {},
        reason: "first audit",
      },
    };
    const h = harness([credits([10]), start, runDone(), compare(body)]);
    expect(await runNewFindingsGate(h.deps, OPTS)).toEqual({
      code: 0,
      reason: "no_baseline",
    });
    expect(h.out.join("\n")).toContain("No baseline");
  });

  test("not_evaluated is not a pass: exit 1 with the reason", async () => {
    const body: CompareResponse = {
      comparison: { head: { status: "completed" } },
      gate: {
        status: "not_evaluated",
        reason: "a report exceeded the comparison cap",
      },
    };
    const h = harness([credits([10]), start, runDone(), compare(body)]);
    expect(await runNewFindingsGate(h.deps, OPTS)).toEqual({
      code: 1,
      reason: "not_evaluated",
    });
    expect(h.out.join("\n")).toContain("a report exceeded the comparison cap");
  });

  test("a blocked audit exits 3, never 2, even if a gate said fail", async () => {
    const body: CompareResponse = {
      comparison: { head: { status: "blocked" } },
      gate: { status: "fail", newAtOrAbove: 4, reason: "x" },
    };
    const h = harness([credits([10]), start, runDone(), compare(body)]);
    expect(await runNewFindingsGate(h.deps, OPTS)).toEqual({
      code: 3,
      reason: "blocked",
    });
  });

  test("an unreachable site exits 5, never 2", async () => {
    const body: CompareResponse = {
      comparison: { head: { status: "failed", statusReasonCode: "dns" } },
      gate: { status: "fail", newAtOrAbove: 1, reason: "x" },
    };
    const h = harness([credits([10]), start, runDone(), compare(body)]);
    expect(await runNewFindingsGate(h.deps, OPTS)).toEqual({
      code: 5,
      reason: "unreachable",
    });
  });

  test("a run that ends failed exits 1 (or 5 when the site was unreachable)", async () => {
    const failed =
      (completionReason: string): Handler =>
      (m, p) =>
        m === "GET" && p === "/v1/agent-runs/run_2"
          ? ok({
              id: "run_2",
              status: "failed",
              error: "No pages were crawled",
              completionReason,
            })
          : undefined;
    expect(
      (
        await runNewFindingsGate(
          harness([credits([1]), start, failed("error")]).deps,
          OPTS
        )
      ).code
    ).toBe(1);
    expect(
      (
        await runNewFindingsGate(
          harness([credits([1]), start, failed("connection")]).deps,
          OPTS
        )
      ).code
    ).toBe(5);
  });

  test("waits through running and a pending report before comparing", async () => {
    let polls = 0;
    const poll: Handler = (m, p) => {
      if (m !== "GET" || p !== "/v1/agent-runs/run_2") return undefined;
      polls++;
      if (polls === 1)
        return ok({
          id: "run_2",
          status: "running",
          progress: { phase: "crawl", current: 1, total: 4 },
        });
      if (polls === 2)
        return ok({
          id: "run_2",
          status: "completed",
          reportAvailability: "pending",
        });
      return ok({
        id: "run_2",
        status: "completed",
        reportAvailability: "ready",
        reportId: "rep_2",
      });
    };
    const h = harness([credits([10]), start, poll, compare(failBody)]);
    expect((await runNewFindingsGate(h.deps, OPTS)).code).toBe(2);
    expect(polls).toBe(3);
  });

  test("a run that does not finish in time exits 1 and names the run", async () => {
    const running: Handler = (m, p) =>
      m === "GET" && p === "/v1/agent-runs/run_2"
        ? ok({ id: "run_2", status: "running" })
        : undefined;
    const h = harness([credits([10]), start, running]);
    const res = await runNewFindingsGate(h.deps, { ...OPTS, timeoutMs: 5000 });
    expect(res).toEqual({ code: 1, reason: "timeout" });
    expect(h.err.join("\n")).toContain("run_2");
  });

  test("a refused start (no credits) exits 1 with the API's reason", async () => {
    const refuse: Handler = (m, p) =>
      m === "POST" && p === "/v1/agent-runs"
        ? {
            ok: false,
            status: 402,
            data: {
              error: {
                code: "INSUFFICIENT_CREDITS",
                message: "Insufficient credits",
              },
            },
          }
        : undefined;
    const h = harness([credits([1]), refuse]);
    expect(await runNewFindingsGate(h.deps, OPTS)).toEqual({
      code: 1,
      reason: "start_failed",
    });
    expect(h.err.join("\n")).toContain("INSUFFICIENT_CREDITS");
  });

  test("a compare that 404s once is retried, a persistent failure exits 1", async () => {
    let n = 0;
    const flaky: Handler = (_m, p) => {
      if (!p.includes("/audits/compare")) return undefined;
      return ++n === 1 ? { ok: false, status: 404, data: null } : ok(failBody);
    };
    expect(
      (
        await runNewFindingsGate(
          harness([credits([1]), start, runDone(), flaky]).deps,
          OPTS
        )
      ).code
    ).toBe(2);
    const down: Handler = (_m, p) =>
      p.includes("/audits/compare")
        ? { ok: false, status: 401, data: null }
        : undefined;
    expect(
      (
        await runNewFindingsGate(
          harness([credits([1]), start, runDone(), down]).deps,
          OPTS
        )
      ).reason
    ).toBe("compare_failed");
  });

  test("unreadable credits are reported as such and do not change the exit", async () => {
    const h = harness([start, runDone(), compare(failBody)]);
    expect((await runNewFindingsGate(h.deps, OPTS)).code).toBe(2);
    expect(h.out.join("\n")).toContain("Credits: could not be read");
  });

  test("terminal control characters in server text never reach the output", async () => {
    const esc = String.fromCharCode(27);
    const body: CompareResponse = {
      ...failBody,
      gate: { ...failBody.gate, reason: `bad${esc}[2Jreason` },
    };
    const h = harness([credits([5, 4]), start, runDone(), compare(body)]);
    await runNewFindingsGate(h.deps, OPTS);
    expect(h.out.join("\n")).not.toContain(esc);
  });

  test("--json prints one object on stdout", async () => {
    const h = harness([
      credits([100, 52]),
      start,
      runDone(),
      compare(failBody),
    ]);
    await runNewFindingsGate(h.deps, { ...OPTS, json: true });
    expect(h.out).toHaveLength(1);
    const parsed = JSON.parse(h.out[0]!);
    expect(parsed).toMatchObject({
      exitCode: 2,
      runId: "run_2",
      credits: { used: 48 },
      reportUrl: "https://reports.squirrelscan.com/rep_2",
    });
    expect(parsed.new).toHaveLength(1);
    expect(parsed.resolved).toHaveLength(1);
  });
});

describe("decideExit", () => {
  test("an unknown gate status is not a pass", () => {
    expect(decideExit({ gate: { status: "something_new" } }, null).code).toBe(
      1
    );
    expect(decideExit({}, null).code).toBe(1);
  });
});
