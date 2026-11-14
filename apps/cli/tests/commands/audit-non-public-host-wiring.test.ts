// #1841 at the `squirrel audit` command boundary.
//
// The pieces each have their own test: `resolveRegisterDecision`,
// `resolvePublishDecision`, the render-mode override, both prefetch seams. What
// none of them can prove is that the command still CONSULTS them — delete the
// call site and every one of those suites stays green. So this drives the real
// command and asserts on what actually leaves the process.
//
// NO `mock.module` HERE, deliberately. Bun's module mocks are process-wide and
// `mock.restore()` does not undo them, so an earlier version of this file
// replaced `safeExit` for every later suite in the run and broke a sibling
// command test in CI while passing locally. Everything below is either
// file-local state restored in `afterEach`, or an assertion on the stubbed
// fetch — which is the stronger assertion anyway, since a spy on a helper
// cannot tell you whether the command still calls it.
//
// The account probe (`GET /v1/credits`) is deliberately NOT asserted against.
// It asks about the user, not about the site, and the audited address is never
// part of it; the contract is that nothing hands the ADDRESS to a hosted
// runner. The public-host control below is what proves the gate is a gate and
// not an outage.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";

import { fastCrawlConfig } from "../helpers/fast-crawl-config";
import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// #2182: a SUCCESSFUL publish now stamps `first_publish_at` in the user
// settings (controllers/report/publish.ts), and this file stubs fetch into
// success responses — so without isolation the public-host control below can
// write to the developer's REAL ~/.squirrel/settings.json.
// homedir() is fixed at process start in Bun, so $HOME cannot redirect it;
// `isolateSquirrelHome` moves every squirrel path instead (#626).
const scratch = isolateSquirrelHome("squirrel-audit-host").root;
// #1839: skip the per-host politeness sleep the discovery probes pay serially.
const configPath = join(scratch, "squirrel.toml");
let previousConfigPath: string | undefined;
beforeAll(() => {
  writeFileSync(configPath, fastCrawlConfig(""));
  previousConfigPath = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
});
afterAll(() => {
  if (previousConfigPath !== undefined) setGlobalConfigPath(previousConfigPath);
});

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalEnv = { ...process.env };
let requested: string[] = [];
/** The credit balance the stubbed `/v1/credits` reports. Reset per test. */
let balance = 5000;
/** Everything the run printed, for the credit-clamp notice. */
let printed: string[] = [];
const originalLog = console.log;
const originalError = console.error;

/** Special-use literals the narrow classifier does not name (#1560, #1572): the policy gate must still hold the handoff. */
const SPECIAL_USE_HOSTS = [
  "http://[64:ff9b::a00:1]:9/",
  "http://[2002:a00:1::]:9/",
  "http://[2001:db8::1]:9/",
  "http://[fec0::1]:9/",
  "http://192.0.2.1:9/",
  "http://198.51.100.1:9/",
  "http://198.18.0.1:9/",
];

beforeEach(() => {
  requested = [];
  balance = 5000;
  printed = [];
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  console.error = (...args: unknown[]) => printed.push(args.join(" "));
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  // The site is a stubbed fetch keyed by name: send its hosts by name
  // rather than resolving and pinning them (repo#3430).
  process.env.SQUIRREL_NO_HOST_PINNING = "1";
  // File-local, restored below. `safeExit` ends in process.exit, and a command
  // that exits mid-test would take the whole runner with it.
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    requested.push(url);
    // Answer the balance probe so the run resolves to SIGNED IN. Without this
    // every run reads as logged out and the gate under test never matters.
    if (url.includes("/v1/credits")) {
      return Response.json({
        balance: { total: balance, monthly: balance, pack: 0, periodEnd: null },
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
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  process.env = { ...originalEnv };
});

/** Run the real command to completion, swallowing only its exit. */
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

/** Everything the run sent to the cloud about the AUDITED SITE. */
const handoffs = () =>
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
    expect(handoffs()).toEqual([]);
  });

  // Explicit flags must not reopen the handoff: `--publish` is the one opt-out
  // the host clause deliberately outranks, and `--render` is the one that
  // debits on submit.
  test("an explicit --publish --render still hands over nothing", async () => {
    await runAudit("http://127.0.0.1:9/", { publish: true, render: true });
    expect(handoffs()).toEqual([]);
    expect(requested.some((u) => u.includes("/v1/services/render"))).toBe(
      false
    );
  });

  // #1572: the policy gate reads the WIDE classifier. A special-use literal (NAT64, 6to4, documentation, site-local, benchmarking)
  // is not reachable by a hosted runner either, and the narrow classifier does not name it, so a call site left on the narrow
  // one registers the run and publishes it.
  test.each(SPECIAL_USE_HOSTS.map((u) => [u]))(
    "%s registers nothing and publishes nothing",
    async (url) => {
      await runAudit(url, { publish: true });
      expect(handoffs()).toEqual([]);
    }
  );

  // The credit-clamp gate sits behind the same decision: a low balance must not clamp the page cap, or print a top-up warning,
  // for a run that never registers. The control below proves the stub does clamp a public host.
  test.each(SPECIAL_USE_HOSTS.map((u) => [u]))(
    "%s is not credit-clamped on a low balance",
    async (url) => {
      balance = 100;
      await runAudit(url, { "max-pages": "50" });
      expect(printed.join("\n")).not.toMatch(
        /covers \d+ of the 50 pages requested/
      );
    }
  );

  test("control: a public host on a low balance IS credit-clamped", async () => {
    balance = 100;
    await runAudit("https://example.com/", { "max-pages": "50" });
    expect(printed.join("\n")).toMatch(/covers \d+ of the 50 pages requested/);
  });

  // THE CONTROL. Without it the tests above would pass just as happily if the
  // command had stopped registering anything at all, and the run has to be
  // genuinely signed in or they pass for that reason instead.
  test("a public host still registers", async () => {
    await runAudit("https://example.com/");
    expect(requested.some((u) => u.includes("/v1/credits"))).toBe(true);
    expect(requested.some((u) => u.includes("/v1/agent-runs/register"))).toBe(
      true
    );
  });
});
