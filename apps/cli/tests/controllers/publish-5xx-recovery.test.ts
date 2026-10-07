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
// Called once per run read: n=0 is the pre-POST snapshot, n=1 the recovery read.
let runResponse: (n: number) => Response;
let runReads: number;

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
  runReads = 0;
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
    return runResponse(runReads++);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const posts = () =>
  calls.filter((c) => c.method === "POST" && c.path === "/v1/reports");

describe("publishReport after a 5xx (#1340)", () => {
  test("a run with a linked reportId recovers as a published report", async () => {
    runResponse = (n) =>
      Response.json({ id: "run_1", reportId: n === 0 ? null : "rep_9" });

    const result = await publishReport(report(), {
      visibility: "unlisted",
      runId: "run_1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.id).toBe("rep_9");
    expect(result.data.url).toBe("https://reports.squirrelscan.com/rep_9");
    expect(result.data.visibility).toBe("unlisted");
    // sq_ API keys must use the org-scoped route (userId routes reject them).
    expect(calls.some((c) => c.path === "/v1/agent-runs/org/run_1")).toBe(true);
    expect(calls.some((c) => c.path === "/v1/agent-runs/run_1")).toBe(false);
  });

  test("a non-production API keeps PUBLISH_SERVER_ERROR (reports base unknown)", async () => {
    runResponse = (n) =>
      Response.json({ id: "run_1", reportId: n === 0 ? null : "rep_9" });
    const prev = process.env.SQUIRREL_API_SERVER;
    process.env.SQUIRREL_API_SERVER = "https://api.staging.example.com";
    try {
      const result = await publishReport(report(), { runId: "run_1" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("PUBLISH_SERVER_ERROR");
    } finally {
      if (prev === undefined) delete process.env.SQUIRREL_API_SERVER;
      else process.env.SQUIRREL_API_SERVER = prev;
    }
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
    runReads = 0;
    runResponse = (n) =>
      Response.json({ id: "run_1", reportId: n === 0 ? null : "rep_9" });
    await publishReport(report(), { runId: "run_1" });
    expect(posts()).toHaveLength(1);
  });

  test("a stale reportId from an earlier publish is not recovered", async () => {
    runResponse = () => Response.json({ id: "run_1", reportId: "rep_old" });

    const result = await publishReport(report(), { runId: "run_1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PUBLISH_SERVER_ERROR");
  });

  test("an unreadable pre-publish run keeps PUBLISH_SERVER_ERROR", async () => {
    runResponse = (n) =>
      n === 0
        ? new Response("nope", { status: 500 })
        : Response.json({ id: "run_1", reportId: "rep_9" });

    const result = await publishReport(report(), { runId: "run_1" });

    expect(result.ok).toBe(false);
  });

  test("a recovery read that throws keeps PUBLISH_SERVER_ERROR", async () => {
    const base = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/v1/agent-runs") && reads++ > 0) {
        throw new Error("socket hang up");
      }
      return base(input, init);
    }) as unknown as typeof fetch;

    const result = await publishReport(report(), { runId: "run_1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PUBLISH_SERVER_ERROR");
  });

  test("a hung pre-publish snapshot is bounded and still POSTs", async () => {
    const base = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/v1/agent-runs")) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        });
      }
      return base(input, init);
    }) as unknown as typeof fetch;

    const started = Date.now();
    const result = await publishReport(report(), { runId: "run_1" });

    expect(Date.now() - started).toBeLessThan(8_000);
    expect(posts()).toHaveLength(1);
    expect(result.ok).toBe(false);
  });
});
