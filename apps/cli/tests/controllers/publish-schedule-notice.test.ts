// #2184: what `publishReport` forwards out of the API's publish response.
//
// The CLI's renderer validates the notice again before printing, so this file
// pins the OTHER half of the contract: `PublishResult.schedule` is typed
// `ScheduleNotice`, and the only way that type can be honest is if the
// controller refuses a partial object rather than passing the cast through.
// Without this, the field's type is a claim nothing checks.
//
// `getSettingsPath` is spied rather than redirected through $HOME: a successful
// publish stamps `first_publish_at` (#2182) and Bun fixes homedir() at process
// start, so $HOME cannot keep this off the developer's real settings file.
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

import type { AuditReport } from "../../src/types";

import { publishReport } from "../../src/controllers/report/publish";
import { API_TOKEN_ENV_VAR } from "../../src/self/credentials";
import * as pathsModule from "../../src/self/paths";

const SETTINGS_URL =
  "https://app.squirrelscan.com/acme/website/web_1/settings/schedule";

const COMPLETE = {
  enabled: true,
  frequency: "weekly",
  frequencyLabel: "every week",
  settingsUrl: SETTINGS_URL,
};

function report(): AuditReport {
  return {
    baseUrl: "https://example.com",
    status: "completed",
    pages: [],
    siteChecks: [],
    summary: {
      missingTitles: [],
      missingDescriptions: [],
      missingOgTags: [],
      missingTwitterCards: [],
      missingSchemas: [],
      missingAltText: [],
      multipleH1s: [],
      thinContentPages: [],
      urlIssues: [],
      redirectChains: [],
      securityIssues: [],
    },
    ruleResults: {},
  } as unknown as AuditReport;
}

const settingsHome = mkdtempSync(join(tmpdir(), "squirrel-pub-sched-"));
const originalToken = process.env[API_TOKEN_ENV_VAR];
const originalFetch = globalThis.fetch;
let restoreSettingsPath: () => void = () => {};
let responseSchedule: unknown;

beforeAll(() => {
  const spy = spyOn(pathsModule, "getSettingsPath").mockImplementation(() =>
    join(settingsHome, "settings.json")
  );
  restoreSettingsPath = () => spy.mockRestore();
  process.env[API_TOKEN_ENV_VAR] = "sq_live_test_token_for_schedule_notice";
});

afterAll(() => {
  restoreSettingsPath();
  rmSync(settingsHome, { recursive: true, force: true });
  if (originalToken === undefined) delete process.env[API_TOKEN_ENV_VAR];
  else process.env[API_TOKEN_ENV_VAR] = originalToken;
});

beforeEach(() => {
  responseSchedule = undefined;
  globalThis.fetch = (async () =>
    Response.json(
      {
        id: "rep_1",
        url: "https://reports.squirrelscan.com/rep_1",
        visibility: "unlisted",
        createdAt: new Date().toISOString(),
        healthScore: 80,
        issuesFound: 0,
        totalPages: 1,
        ...(responseSchedule === undefined
          ? {}
          : { schedule: responseSchedule }),
      },
      { status: 201 }
    )) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function publishedSchedule() {
  const result = await publishReport(report(), { visibility: "unlisted" });
  if (!result.ok) throw new Error(`publish failed: ${result.error.message}`);
  return result.data.schedule;
}

describe("publishReport forwards the schedule notice (#2184)", () => {
  test("a complete notice reaches the caller unchanged", async () => {
    responseSchedule = COMPLETE;

    expect(await publishedSchedule()).toEqual(COMPLETE);
  });

  test("a server that sent none leaves the field absent", async () => {
    expect(await publishedSchedule()).toBeUndefined();
  });

  // Each of these would satisfy the declared type only because the response is
  // a cast. Dropping the whole object is what keeps `PublishResult.schedule`
  // from being a claim nothing checks.
  test("a partial notice is dropped, not forwarded", async () => {
    for (const key of Object.keys(COMPLETE)) {
      const partial = { ...COMPLETE } as Record<string, unknown>;
      delete partial[key];
      responseSchedule = partial;
      expect(
        await publishedSchedule(),
        `missing ${key} was forwarded`
      ).toBeUndefined();
    }
  });

  test("a wrongly-typed notice is dropped", async () => {
    responseSchedule = { ...COMPLETE, enabled: "yes" };
    expect(await publishedSchedule()).toBeUndefined();

    responseSchedule = "weekly";
    expect(await publishedSchedule()).toBeUndefined();
  });
});
