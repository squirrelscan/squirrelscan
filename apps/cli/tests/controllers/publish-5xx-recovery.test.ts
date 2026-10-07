// #1340: a publish 5xx can land AFTER the report was written and linked to the
// run. publishReport asks the run (GET /v1/agent-runs/:id) before declaring
// failure, and never re-POSTs /v1/reports (a retry would orphan a duplicate).
//
// `getSettingsPath` is spied for the same reason as publish-schedule-notice:
// a successful publish stamps `first_publish_at`.
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

const settingsHome = mkdtempSync(join(tmpdir(), "squirrel-pub-5xx-"));
const originalToken = process.env[API_TOKEN_ENV_VAR];
const originalFetch = globalThis.fetch;
let restoreSettingsPath: () => void = () => {};
let calls: Array<{ method: string; path: string }>;
let runResponse: () => Response;

beforeAll(() => {
  const spy = spyOn(pathsModule, "getSettingsPath").mockImplementation(() =>
    join(settingsHome, "settings.json")
  );
  restoreSettingsPath = () => spy.mockRestore();
  process.env[API_TOKEN_ENV_VAR] = "sq_live_test_token_for_5xx_recovery";
});

afterAll(() => {
  restoreSettingsPath();
  rmSync(settingsHome, { recursive: true, force: true });
  if (originalToken === undefined) delete process.env[API_TOKEN_ENV_VAR];
  else process.env[API_TOKEN_ENV_VAR] = originalToken;
});

beforeEach(() => {
  calls = [];
  runResponse = () => Response.json({ id: "run_1", reportId: null });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ method: init?.method ?? "GET", path });
    if (path === "/v1/reports") {
      return new Response("upstream died", {
        status: 503,
        statusText: "Service Unavailable",
      });
    }
    return runResponse();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const posts = () =>
  calls.filter((c) => c.method === "POST" && c.path === "/v1/reports");

describe("publishReport after a 5xx (#1340)", () => {
  test("a run with a linked reportId recovers as a published report", async () => {
    runResponse = () => Response.json({ id: "run_1", reportId: "rep_9" });

    const result = await publishReport(report(), {
      visibility: "unlisted",
      runId: "run_1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.id).toBe("rep_9");
    expect(result.data.url).toBe("https://reports.squirrelscan.com/rep_9");
    expect(result.data.visibility).toBe("unlisted");
    expect(calls.some((c) => c.path === "/v1/agent-runs/run_1")).toBe(true);
  });

  test("a run with no linked reportId keeps PUBLISH_SERVER_ERROR", async () => {
    const result = await publishReport(report(), { runId: "run_1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PUBLISH_SERVER_ERROR");
  });

  test("an unreadable run keeps PUBLISH_SERVER_ERROR", async () => {
    runResponse = () => new Response("nope", { status: 500 });

    const result = await publishReport(report(), { runId: "run_1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PUBLISH_SERVER_ERROR");
  });

  test("a publish without a runId never asks the server and fails as before", async () => {
    const result = await publishReport(report(), {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PUBLISH_SERVER_ERROR");
    expect(calls.some((c) => c.path.startsWith("/v1/agent-runs"))).toBe(false);
  });

  test("/v1/reports is POSTed exactly once on every branch", async () => {
    await publishReport(report(), { runId: "run_1" });
    expect(posts()).toHaveLength(1);

    calls = [];
    runResponse = () => Response.json({ id: "run_1", reportId: "rep_9" });
    await publishReport(report(), { runId: "run_1" });
    expect(posts()).toHaveLength(1);
  });
});
