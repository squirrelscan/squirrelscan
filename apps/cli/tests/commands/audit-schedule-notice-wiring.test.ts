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

/** A live weekly schedule, as the API builds it. */
const active = () => ({
  kind: "recurring" as const,
  frequency: "weekly" as const,
  requested: true,
  state: "active",
  stateReason: null,
  nextRunAt: "2026-09-23T04:41:00.000Z",
  cadenceLabel: "every week",
  settingsUrl: SETTINGS_URL,
  pauseUrl: "https://api.squirrelscan.com/v1/schedules/pause?s=a&t=b",
  cap: { limit: 1, used: 1 },
  upgradeUrl: null,
});

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
  test("an active schedule is disclosed, with the link that turns it off", async () => {
    publishSchedule = active();

    await runAudit();

    expect(output()).toContain("Scheduled audits: every week");
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

  // Every state but `active` is silent until #2225 adds its branch to the same
  // renderer. The report URL assertion is what keeps these from passing because
  // the run stopped publishing.
  test.each([["off"], ["capped"], ["unschedulable"], ["paused"]])(
    "state %p says nothing",
    async (state) => {
      publishSchedule = { ...active(), state };

      await runAudit();

      expect(output()).toContain("https://reports.squirrelscan.com/rep_1");
      expect(output()).not.toContain("Scheduled audits:");
    }
  );

  test("a server that sends no summary says nothing", async () => {
    await runAudit();

    expect(output()).not.toContain("Scheduled audits:");
  });

  // A summary missing a field the line renders must be dropped whole rather
  // than printed half-formed: naming a recurring charge with no way to stop it
  // is worse than silence.
  test("a summary missing its link says nothing", async () => {
    const { settingsUrl: _dropped, ...withoutLink } = active();
    publishSchedule = withoutLink;

    await runAudit();

    expect(output()).not.toContain("Scheduled audits:");
  });
});
