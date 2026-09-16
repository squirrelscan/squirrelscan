// #2184, #2225: what `publishReport` forwards out of the API's publish response.
//
// The CLI's renderer validates the summary again before printing, so this file
// pins the OTHER half of the contract: `PublishResult.schedule` is typed
// `WebsiteScheduleSummary`, the shared shape in core-contracts, and the only way
// that type can be honest is if the controller refuses an object missing the
// fields it promises rather than passing the cast through. Without this, the
// field's type is a claim nothing checks.
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

// Typed loosely on purpose: this file feeds these objects through a JSON
// response, which is exactly the untyped path the controller's guard exists for.
const COMPLETE: Record<string, unknown> = {
  kind: "recurring",
  frequency: "weekly",
  requested: true,
  state: "active",
  stateReason: null,
  nextRunAt: "2026-09-23T04:41:00.000Z",
  cadenceLabel: "every week",
  settingsUrl: SETTINGS_URL,
  pauseUrl: "https://api.squirrelscan.com/v1/schedules/pause?s=a&t=b",
  cap: { limit: 1, used: 1 },
  upgradeUrl: null,
};

/** The three fields EVERY state's line reads, and therefore validates. */
const RENDERED_FIELDS = ["state", "cadenceLabel", "settingsUrl"] as const;

const UPGRADE_URL = "https://app.squirrelscan.com/acme/settings/billing";

/** A capped summary, whose line reads `upgradeUrl` on top of the three (#2225). */
const CAPPED: Record<string, unknown> = {
  ...COMPLETE,
  frequency: null,
  state: "capped",
  stateReason: "plan_cap",
  nextRunAt: null,
  cadenceLabel: "off",
  pauseUrl: null,
  upgradeUrl: UPGRADE_URL,
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

describe("publishReport forwards the schedule summary (#2184)", () => {
  test("a complete summary reaches the caller unchanged", async () => {
    responseSchedule = COMPLETE;

    expect(await publishedSchedule()).toEqual(COMPLETE as never);
  });

  test("a server that sent none leaves the field absent", async () => {
    expect(await publishedSchedule()).toBeUndefined();
  });

  // Each of these would satisfy the declared type only because the response is
  // a cast. Dropping the whole object is what keeps `PublishResult.schedule`
  // from being a claim nothing checks.
  test("a summary missing a rendered field is dropped, not forwarded", async () => {
    for (const key of RENDERED_FIELDS) {
      const partial = { ...COMPLETE } as Record<string, unknown>;
      delete partial[key];
      responseSchedule = partial;
      expect(
        await publishedSchedule(),
        `missing ${key} was forwarded`
      ).toBeUndefined();
    }
  });

  // The guard checks what the CLI RENDERS, not the whole contract. A server that
  // starts populating the rest later must not be silenced by this validation,
  // and the fields it omits are the server's to define.
  test("a summary whose unrendered fields are absent is still forwarded", async () => {
    const rendered = {
      state: "active",
      cadenceLabel: "every week",
      settingsUrl: SETTINGS_URL,
    };
    responseSchedule = rendered;

    expect(await publishedSchedule()).toEqual(rendered as never);
  });

  test("a wrongly-typed summary is dropped", async () => {
    responseSchedule = { ...COMPLETE, state: 1 };
    expect(await publishedSchedule()).toBeUndefined();

    responseSchedule = "weekly";
    expect(await publishedSchedule()).toBeUndefined();
  });

  // #2225: "what is rendered" became per state, and the controller's guard is
  // the same one. A capped summary's line ends in the upgrade link, so a capped
  // summary without one is as incomplete as an active one with no settings URL.
  test("a complete capped summary reaches the caller unchanged", async () => {
    responseSchedule = CAPPED;

    expect(await publishedSchedule()).toEqual(CAPPED as never);
  });

  test.each([[null], [undefined], [""], [42]])(
    "a capped summary whose upgrade link is %p is dropped",
    async (upgradeUrl) => {
      responseSchedule = { ...CAPPED, upgradeUrl };

      expect(await publishedSchedule()).toBeUndefined();
    }
  );

  // And the widening stops there. An active summary has never carried an
  // upgrade link, and requiring one of everything would have silenced every
  // server that ever sent a correct one.
  test("an active summary with no upgrade link is still forwarded", async () => {
    const { upgradeUrl: _dropped, ...withoutLink } = COMPLETE;
    responseSchedule = withoutLink;

    expect(await publishedSchedule()).toEqual(withoutLink as never);
  });
});
