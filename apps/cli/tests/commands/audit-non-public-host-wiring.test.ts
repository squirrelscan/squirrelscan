// #1841 at the `squirrel audit` command boundary.
//
// The pieces each have their own test: `resolveRegisterDecision`,
// `resolvePublishDecision`, the render-mode override, both prefetch seams. What
// none of them can prove is that the command still CONSULTS them — delete the
// call site and every one of those suites stays green. So this drives the real
// command and asserts on the two things that actually leave the process: the
// register call and the publish call.
//
// The account probe (`GET /v1/credits`) is deliberately NOT asserted against.
// It asks about the user, not about the site, and the audited address is never
// part of it; the contract is that nothing hands the ADDRESS to a hosted
// runner. The public-host control below is what proves the gate is a gate and
// not an outage.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const realUpdater = await import("@/self/updater");
mock.module("@/self/updater", () => ({
  ...realUpdater,
  safeExit: (code: number) => {
    throw new ExitSignal(code);
  },
}));

const realTracker = await import("@/lib/run-tracker");
let registerCalls: string[] = [];
mock.module("@/lib/run-tracker", () => ({
  ...realTracker,
  registerRun: async (input: { url: string }) => {
    registerCalls.push(input.url);
    return null; // as if the API were unreachable: the audit runs untracked
  },
}));

const realPublish = await import("@/controllers/report/publish");
let publishCalls: number = 0;
mock.module("@/controllers/report/publish", () => ({
  ...realPublish,
  publishReport: async () => {
    publishCalls++;
    return { ok: false as const, error: { code: "TEST", message: "stubbed" } };
  },
}));

const { audit } = await import("@/cli/commands/audit");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let requested: string[] = [];
let home: string;

beforeEach(() => {
  registerCalls = [];
  publishCalls = 0;
  requested = [];
  home = mkdtempSync(join(tmpdir(), "squirrel-audit-test-"));
  // Never touch the real ~/.squirrel.
  process.env.HOME = home;
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    requested.push(url);
    // Answer the balance probe so the run resolves to SIGNED IN. Without this
    // every run reads as logged out and the gate under test never matters.
    if (url.includes("/v1/credits")) {
      return Response.json({
        balance: { total: 5000, monthly: 5000, pack: 0, periodEnd: null },
        plan: { id: "pro", monthlyCredits: 5000 },
        branding: null,
      });
    }
    // EVERY audited host answers, private ones included. The command bails
    // early on an unreachable target, so a stub that refused them would make
    // the private cases below pass for the wrong reason.
    if (!url.includes("/v1/")) {
      return new Response(
        "<html><head><title>t</title></head><body><h1>h</h1></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    return Response.json({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

/** Run the real command to completion, swallowing its exit. */
async function runAudit(url: string, extra: Record<string, unknown> = {}) {
  try {
    await audit.run!({
      args: {
        url,
        // A single page, no interactive prompts, no rule filtering.
        "max-pages": "1",
        coverage: "quick",
        yes: true,
        format: "console",
        ...extra,
      },
    } as never);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const apiCalls = () =>
  requested.filter(
    (u) => u.includes("/v1/agent-runs") || u.includes("/v1/reports")
  );

describe("squirrel audit — a host no hosted runner can reach (#1841)", () => {
  test.each([
    ["http://127.0.0.1:9/"],
    ["http://192.168.1.10:9/"],
    ["http://box.local:9/"],
  ])("%s registers nothing and publishes nothing", async (url) => {
    await runAudit(url);
    expect(registerCalls).toEqual([]);
    expect(publishCalls).toBe(0);
    expect(apiCalls()).toEqual([]);
  });

  // Explicit flags must not reopen the handoff: `--publish` is the one opt-out
  // the host clause deliberately outranks, and `--render` is the one that
  // debits on submit.
  test("an explicit --publish --render still hands over nothing", async () => {
    await runAudit("http://127.0.0.1:9/", { publish: true, render: true });
    expect(registerCalls).toEqual([]);
    expect(publishCalls).toBe(0);
    expect(apiCalls()).toEqual([]);
  });

  // THE CONTROL. Without this the tests above would pass just as happily if the
  // command had stopped registering anything at all.
  test("a public host still registers", async () => {
    await runAudit("https://example.com/");
    expect(registerCalls).toEqual(["https://example.com/"]);
  });

  // ... and the same run is signed in, which is what makes the assertions above
  // mean something. A logged-out run registers nothing either, so without this
  // the private cases would pass on an unrelated reason.
  test("the control run really was signed in", async () => {
    await runAudit("https://example.com/");
    expect(requested.some((u) => u.includes("/v1/credits"))).toBe(true);
    expect(registerCalls).toHaveLength(1);
  });
});
