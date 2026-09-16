// #2184 at the `squirrel audit` command boundary.
//
// `scheduleNoticeLine` has its own suite, and it would stay green with the call
// site deleted. This drives the real command against a stubbed API and asserts
// on what actually reaches the user's terminal, which is the only thing that
// proves the disclosure happens at all.
//
// Modelled on audit-non-public-host-wiring.test.ts, including its two rules:
// NO `mock.module` (bun's module mocks are process-wide and outlive the file),
// and `getSettingsPath` is spied rather than redirected through $HOME, because
// a successful publish stamps `first_publish_at` and homedir() is fixed at
// process start.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { audit } from "@/cli/commands/audit";
import * as pathsModule from "@/self/paths";

const SETTINGS_URL =
  "https://app.squirrelscan.com/acme/website/web_1/settings/schedule";

/** What the publish route answers with. Reassigned per test. */
let publishSchedule: unknown;

const settingsHome = mkdtempSync(join(tmpdir(), "squirrel-sched-settings-"));
let restoreSettingsPath: () => void = () => {};

beforeAll(() => {
  const spy = spyOn(pathsModule, "getSettingsPath").mockImplementation(() =>
    join(settingsHome, "settings.json")
  );
  restoreSettingsPath = () => spy.mockRestore();
});

afterAll(() => {
  restoreSettingsPath();
  rmSync(settingsHome, { recursive: true, force: true });
});

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;
const originalEnv = { ...process.env };
let printed: string[] = [];
let home: string;

beforeEach(() => {
  printed = [];
  publishSchedule = undefined;
  home = mkdtempSync(join(tmpdir(), "squirrel-sched-test-"));
  process.env.HOME = home;
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  // The command picks console.log or console.error by output format, so both
  // are captured and the assertions never depend on which one it chose.
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  console.error = (...args: unknown[]) => printed.push(args.join(" "));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    if (url.includes("/v1/credits")) {
      return Response.json({
        balance: { total: 5000, monthly: 5000, pack: 0, periodEnd: null },
        plan: { id: "starter", monthlyCredits: 3000 },
        branding: null,
      });
    }
    if (url.includes("/v1/reports")) {
      return Response.json(
        {
          id: "rep_1",
          url: "https://reports.squirrelscan.com/rep_1",
          visibility: "unlisted",
          createdAt: new Date().toISOString(),
          healthScore: 80,
          issuesFound: 1,
          totalPages: 1,
          ...(publishSchedule === undefined
            ? {}
            : { schedule: publishSchedule }),
        },
        { status: 201 }
      );
    }
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
  rmSync(home, { recursive: true, force: true });
});

async function runAudit(extra: Record<string, unknown> = {}) {
  try {
    await audit.run!({
      args: {
        url: "https://example.com/",
        "max-pages": "1",
        coverage: "quick",
        yes: true,
        format: "console",
        publish: true,
        ...extra,
      },
    } as never);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const output = () => printed.join("\n");

describe("squirrel audit — the recurring-audit disclosure (#2184)", () => {
  test("an enabled schedule is disclosed, with the link that turns it off", async () => {
    publishSchedule = {
      enabled: true,
      frequency: "weekly",
      frequencyLabel: "every week",
      settingsUrl: SETTINGS_URL,
    };

    await runAudit();

    expect(output()).toContain("re-audited every week");
    expect(output()).toContain("costs credits");
    expect(output()).toContain(SETTINGS_URL);
  });

  // THE CONTROL. Without it every assertion above would pass just as happily if
  // the command had stopped publishing, since a run that never publishes also
  // never prints a schedule line.
  test("the report URL is printed either way", async () => {
    await runAudit();

    expect(output()).toContain("https://reports.squirrelscan.com/rep_1");
  });

  test("a disabled schedule says nothing", async () => {
    publishSchedule = {
      enabled: false,
      frequency: "weekly",
      frequencyLabel: "every week",
      settingsUrl: SETTINGS_URL,
    };

    await runAudit();

    expect(output()).toContain("https://reports.squirrelscan.com/rep_1");
    expect(output()).not.toContain("re-audited");
  });

  test("a server that sends no notice says nothing", async () => {
    await runAudit();

    expect(output()).not.toContain("re-audited");
  });

  // A partial notice must be dropped whole rather than printed half-formed:
  // naming a recurring charge with no way to stop it is worse than silence.
  test("a notice missing its link says nothing", async () => {
    publishSchedule = {
      enabled: true,
      frequency: "weekly",
      frequencyLabel: "every week",
    };

    await runAudit();

    expect(output()).not.toContain("re-audited");
  });
});
