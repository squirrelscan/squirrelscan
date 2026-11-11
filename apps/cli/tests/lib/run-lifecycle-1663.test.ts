// One RunLifecycle for the CLI audit and the MCP server (#1663): at-most-once close, markRunning that
// never follows the terminal state, and an interrupt handler whose second signal still lets the
// terminal status land (bounded).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createInterruptHandler,
  createRunLifecycle,
  type FinalizeRunInput,
  type RegisteredRun,
} from "@/lib/run-tracker";

const run: RegisteredRun = {
  runId: "run_1",
  websiteId: "web_1",
  auditId: "aud_1",
  lifecycleBase: "/v1/agent-runs",
  baseCharged: 50,
  balanceAfterBase: 450,
  websiteSkippedReason: null,
};

/** Injected PATCHes that record what was sent, in order. */
function recorder(opts: { finalizeGate?: Promise<void> } = {}) {
  const sent: Array<{
    kind: "running" | "terminal";
    runId: string;
    body: unknown;
  }> = [];
  return {
    sent,
    deps: {
      markRunning: async (runId: string, startedAt: string) => {
        sent.push({ kind: "running", runId, body: startedAt });
      },
      finalizeRun: async (runId: string, input: FinalizeRunInput) => {
        await opts.finalizeGate;
        sent.push({ kind: "terminal", runId, body: input });
      },
    },
  };
}
const completed: FinalizeRunInput = { status: "completed", completedAt: "t" };
const failed: FinalizeRunInput = { status: "failed", completedAt: "t" };
const kinds = (r: ReturnType<typeof recorder>) => r.sent.map((s) => s.kind);

describe("close (#1663)", () => {
  test("called twice sends one terminal update, the first one's", async () => {
    const r = recorder();
    const life = createRunLifecycle(Promise.resolve(run), {
      stopHeartbeat: false,
      deps: r.deps as never,
    });
    await life.close(completed);
    await life.close(failed);
    expect(r.sent.filter((s) => s.kind === "terminal")).toEqual([
      { kind: "terminal", runId: "run_1", body: completed },
    ]);
  });

  test("concurrent calls share the one PATCH, and every caller waits for it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = recorder({ finalizeGate: gate });
    const life = createRunLifecycle(Promise.resolve(run), {
      stopHeartbeat: false,
      deps: r.deps as never,
    });
    let secondDone = false;
    const first = life.close(completed);
    const second = life.close(failed).then(() => (secondDone = true));
    await Bun.sleep(10);
    expect(secondDone).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(r.sent.filter((s) => s.kind === "terminal")).toHaveLength(1);
  });

  test("a close while the register is in flight lands once it resolves", async () => {
    const r = recorder();
    let resolveRegister!: (v: RegisteredRun | null) => void;
    const registered = new Promise<RegisteredRun | null>(
      (resolve) => (resolveRegister = resolve)
    );
    const life = createRunLifecycle(registered, {
      stopHeartbeat: false,
      deps: r.deps as never,
    });
    const closing = life.close(completed);
    await Bun.sleep(5);
    expect(r.sent).toEqual([]);
    resolveRegister(run);
    await closing;
    expect(kinds(r)).toEqual(["terminal"]);
  });

  test("no registered run: nothing is sent, and nothing throws", async () => {
    const r = recorder();
    const none = createRunLifecycle(Promise.resolve(null), {
      stopHeartbeat: false,
      deps: r.deps as never,
    });
    await none.markRunning("t");
    await none.close(completed);
    const rejected = createRunLifecycle(
      Promise.reject(new Error("register died")),
      {
        stopHeartbeat: false,
        deps: r.deps as never,
      }
    );
    await rejected.close(completed);
    expect(r.sent).toEqual([]);
  });

  test("isClosed turns true at the first close, before its PATCH lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = recorder({ finalizeGate: gate });
    const life = createRunLifecycle(Promise.resolve(run), {
      stopHeartbeat: false,
      deps: r.deps as never,
    });
    expect(life.isClosed()).toBe(false);
    const closing = life.close(completed);
    expect(life.isClosed()).toBe(true);
    release();
    await closing;
  });
});

describe("markRunning (#1663)", () => {
  test("is sent once, however many times it is asked", async () => {
    const r = recorder();
    const life = createRunLifecycle(Promise.resolve(run), {
      stopHeartbeat: false,
      deps: r.deps as never,
    });
    await life.markRunning("t1");
    await life.markRunning("t2");
    expect(r.sent).toEqual([{ kind: "running", runId: "run_1", body: "t1" }]);
  });

  test("after close it is a no-op", async () => {
    const r = recorder();
    const life = createRunLifecycle(Promise.resolve(run), {
      stopHeartbeat: false,
      deps: r.deps as never,
    });
    await life.close(completed);
    await life.markRunning("t");
    expect(kinds(r)).toEqual(["terminal"]);
  });

  test("a close called before the register answered stops a markRunning that was waiting on it", async () => {
    const r = recorder();
    let resolveRegister!: (v: RegisteredRun | null) => void;
    const registered = new Promise<RegisteredRun | null>(
      (resolve) => (resolveRegister = resolve)
    );
    const life = createRunLifecycle(registered, {
      stopHeartbeat: false,
      deps: r.deps as never,
    });
    const marking = life.markRunning("t");
    const closing = life.close(failed);
    resolveRegister(run);
    await Promise.all([marking, closing]);
    // The API applies whichever status lands last: running must never follow the terminal state.
    expect(kinds(r)).toEqual(["terminal"]);
  });

  test("the terminal PATCH waits for a markRunning that is in flight, and goes after it", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const life = createRunLifecycle(Promise.resolve(run), {
      stopHeartbeat: false,
      deps: {
        markRunning: async () => {
          await gate;
          order.push("running");
        },
        finalizeRun: async () => {
          order.push("terminal");
        },
      } as never,
    });
    const marking = life.markRunning("t");
    await Bun.sleep(5);
    const closing = life.close(completed);
    await Bun.sleep(5);
    expect(order).toEqual([]);
    release();
    await Promise.all([marking, closing]);
    expect(order).toEqual(["running", "terminal"]);
  });

  test("a markRunning that throws is swallowed and the terminal PATCH still goes", async () => {
    const sent: string[] = [];
    const life = createRunLifecycle(Promise.resolve(run), {
      stopHeartbeat: false,
      deps: {
        markRunning: async () => {
          throw new Error("network");
        },
        finalizeRun: async () => {
          sent.push("terminal");
        },
      } as never,
    });
    await life.markRunning("t");
    await life.close(completed);
    expect(sent).toEqual(["terminal"]);
  });

  test("onRegistered is told the run once it exists", async () => {
    const seen: string[] = [];
    createRunLifecycle(Promise.resolve(run), {
      stopHeartbeat: false,
      onRegistered: (r) => seen.push(r.runId),
      deps: recorder().deps as never,
    });
    await Bun.sleep(5);
    expect(seen).toEqual(["run_1"]);
  });
});

describe("createInterruptHandler: a second signal still lets the terminal status land (#1663)", () => {
  function setup(finalize: () => Promise<void>, waitMs = 40) {
    const exits: string[] = [];
    let finalizeCalls = 0;
    const handle = createInterruptHandler({
      finalize: () => {
        finalizeCalls++;
        return finalize();
      },
      exit: (signal) => exits.push(signal),
      waitMs,
    });
    return { handle, exits, calls: () => finalizeCalls };
  }

  test("the first signal finalizes, then exits", async () => {
    const s = setup(async () => {});
    s.handle("SIGINT");
    await Bun.sleep(10);
    expect(s.calls()).toBe(1);
    expect(s.exits).toEqual(["SIGINT"]);
  });

  test("a second signal during the PATCH waits for it: no early exit, no second finalize", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = setup(() => gate, 500);
    s.handle("SIGINT");
    s.handle("SIGINT");
    await Bun.sleep(30);
    // The status has not landed and the cap has not passed: the process must not have exited.
    expect(s.exits).toEqual([]);
    release();
    await Bun.sleep(10);
    expect(s.calls()).toBe(1);
    expect(s.exits.length).toBeGreaterThanOrEqual(1);
  });

  test("a PATCH that never lands is cut by the cap, and the process still exits", async () => {
    const s = setup(() => new Promise<void>(() => {}), 30);
    s.handle("SIGINT");
    s.handle("SIGINT");
    await Bun.sleep(10);
    expect(s.exits).toEqual([]);
    await Bun.sleep(60);
    expect(s.exits).toEqual(["SIGINT"]);
    expect(s.calls()).toBe(1);
  });

  test("a finalize that throws still exits", async () => {
    const s = setup(async () => {
      throw new Error("boom");
    });
    s.handle("SIGTERM");
    await Bun.sleep(10);
    expect(s.exits).toEqual(["SIGTERM"]);
  });
});

describe("both surfaces use the one lifecycle (#1663)", () => {
  const read = (rel: string) =>
    readFileSync(join(import.meta.dir, "../../src", rel), "utf8");

  test("the CLI audit builds a RunLifecycle and installs its signals with `on`, not `once`", () => {
    const src = read("cli/commands/audit.ts");
    expect(src).toContain("createRunLifecycle(registerPromise");
    expect(src).toContain("createInterruptHandler(");
    expect(src).not.toContain("createRunFinalizer(");
    expect(src).not.toMatch(/process\.once\("SIG(INT|TERM|HUP)"/);
  });

  test("the MCP server builds a RunLifecycle and keeps no terminal-state logic of its own", () => {
    const src = read("mcp/billed-audit.ts");
    expect(src).toContain("createRunLifecycle(");
    expect(src).not.toContain("closed ??=");
    expect(src).not.toMatch(/finalizeRun\(run\.runId/);
  });
});
