// repo#2659: when the API refuses a publish body as too large, the CLI prints
// what happened, that the audit is still saved locally, and what to do next,
// never a raw status or JSON. The code stays PAYLOAD_TOO_LARGE, which the run's
// finalize reads as a size-class publish failure.
//
// The API answers with a 413, or with a 422 to a CLI older than the report
// capper: every CLI before this one prints a fixed "20MB" text for any 413 and
// the server's own message for other 4xx statuses, so a 422 is how an old CLI
// gets told to update. The last test pins that older path, which the API
// relies on.
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

import {
  publishReport,
  reportTooLargeMessage,
} from "../../src/controllers/report/publish";
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

const MiB = 1024 * 1024;
const settingsHome = mkdtempSync(join(tmpdir(), "squirrel-pub-size-"));
const originalToken = process.env[API_TOKEN_ENV_VAR];
const originalFetch = globalThis.fetch;
let restoreSettingsPath: () => void = () => {};
let reply: () => Response;
let posts: number;

beforeAll(() => {
  const spy = spyOn(pathsModule, "getSettingsPath").mockImplementation(() =>
    join(settingsHome, "settings.json")
  );
  restoreSettingsPath = () => spy.mockRestore();
  process.env[API_TOKEN_ENV_VAR] = "sq_live_test_token_for_size_refusal";
});

afterAll(() => {
  restoreSettingsPath();
  rmSync(settingsHome, { recursive: true, force: true });
  if (originalToken === undefined) delete process.env[API_TOKEN_ENV_VAR];
  else process.env[API_TOKEN_ENV_VAR] = originalToken;
});

beforeEach(() => {
  posts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST" && path === "/v1/reports") {
      posts++;
      return reply();
    }
    return Response.json({ id: "run_1", reportId: null });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function refusal(
  from: AuditReport = report()
): Promise<{ code: string; message: string }> {
  const result = await publishReport(from, { visibility: "unlisted" });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  // Refused once, never re-POSTed.
  expect(posts).toBe(1);
  return result.error;
}

describe("a publish refused as too large (repo#2659)", () => {
  test("a typed 413 reads as what happened, kept locally, and how to proceed", async () => {
    reply = () =>
      Response.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message:
              "Report body is over the 1 MB publish limit, so it was not published.",
            details: { budgetBytes: MiB },
          },
        },
        { status: 413 }
      );
    const error = await refusal();
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");
    const lines = error.message.split("\n");
    expect(lines[0]).toMatch(
      /^This report is too large to publish \(\d+\.\d MB, over the 1 MB publish limit\), so it was not published\.$/
    );
    expect(lines.slice(1)).toEqual([
      "Your audit is saved locally: view it with `squirrel report`.",
      "To publish a smaller report, audit fewer pages with `--max-pages`.",
    ]);
  });

  test("the container's 413 code, or a 413 with no JSON at all, reads the same way", async () => {
    for (const make of [
      () =>
        Response.json(
          { error: { code: "SINGLE_POST_BUDGET_EXCEEDED", message: "over" } },
          { status: 413 }
        ),
      () => new Response("<html>Payload Too Large</html>", { status: 413 }),
    ]) {
      posts = 0;
      reply = make;
      const error = await refusal();
      expect(error.code).toBe("PAYLOAD_TOO_LARGE");
      expect(error.message).toContain("This report is too large to publish (");
      expect(error.message).not.toContain("publish limit");
      expect(error.message).not.toMatch(/413|\{|<html>/);
      expect(error.message).toContain("`squirrel report`");
    }
  });

  const outdated = () =>
    Response.json(
      {
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message:
            "This report (3.5 MB) is over the 2 MB publish limit for squirrel 0.0.108, so it was not published.",
          details: {
            budgetBytes: 2 * MiB,
            bodyBytes: 3_670_016,
            updateCommand: "squirrel self update",
          },
        },
      },
      { status: 422 }
    );

  test("a refusal that says this CLI is out of date names this audit, at the visibility asked for", async () => {
    reply = outdated;
    const error = await refusal({
      ...report(),
      crawlId: "0b4cbb0e-8f5c-4f43-9f4e-2659a1b2c3d4",
    } as AuditReport);
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(error.message).toContain("over the 2 MB publish limit");
    // Not a bare `squirrel report --publish`: that picks the latest audit and
    // publishes it public by default.
    expect(error.message.split("\n").slice(1)).toEqual([
      "Your audit is saved locally: view it with `squirrel report 0b4cbb0e`.",
      "Run `squirrel self update`, then publish it with `squirrel report 0b4cbb0e --publish --visibility unlisted`.",
    ]);
  });

  test("with no local audit id, the update advice names no command it cannot fill in", async () => {
    reply = outdated;
    const error = await refusal();
    expect(error.message.split("\n").slice(1)).toEqual([
      "Your audit is saved locally: view it with `squirrel report`.",
      "Run `squirrel self update`, then publish it again.",
    ]);
  });

  test("any other 4xx still prints the server's own message (what an older CLI does with the 422)", async () => {
    reply = () =>
      Response.json(
        {
          error: {
            code: "SOMETHING_ELSE",
            message: "Plain words from the API.",
          },
        },
        { status: 422 }
      );
    const error = await refusal();
    expect(error).toEqual({
      code: "SOMETHING_ELSE",
      message: "Plain words from the API.",
    } as typeof error);
  });
});

describe("reportTooLargeMessage", () => {
  test("whole limits print without decimals, sizes with one", () => {
    expect(
      reportTooLargeMessage(1.25 * MiB, { budgetBytes: MiB }).split("\n")[0]
    ).toBe(
      "This report is too large to publish (1.3 MB, over the 1 MB publish limit), so it was not published."
    );
  });

  test("a limit that is not a positive number is left out", () => {
    for (const budgetBytes of [undefined, 0, "1048576", null]) {
      expect(
        reportTooLargeMessage(2 * MiB, { budgetBytes }).split("\n")[0]
      ).toBe(
        "This report is too large to publish (2 MB), so it was not published."
      );
    }
  });
});
