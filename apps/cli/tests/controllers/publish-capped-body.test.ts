// repo#2667: the CLI publishes the engine's capped report, the same
// `capReportForPublish` the cloud container publishes with. Every body leaves
// `publishReport` at or under PUBLISHED_REPORT_MAX_BYTES, whatever the crawl
// size and whatever fires, and the full detail stays in the local report.
//
// The bodies are read off a stubbed fetch, so these measure exactly what the
// real publish path sends.

import { computeLockedRules } from "@squirrelscan/audit-engine";
import {
  capReportForPublish,
  type CappedReport,
} from "@squirrelscan/audit-engine/publish-cap";
import { PUBLISHED_REPORT_MAX_BYTES } from "@squirrelscan/core-contracts/limits";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import { byteLength } from "@squirrelscan/utils/bytes";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import type { AuditReport } from "../../src/types";

import { version } from "../../package.json";
import {
  pickHomepageSummary,
  publishReport,
} from "../../src/controllers/report/publish";
import { API_TOKEN_ENV_VAR } from "../../src/self/credentials";
import { publishReportShape } from "../helpers/publish-report-shape";
import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// #626: a publish reads and stamps the user settings; keep ~/.squirrel out of it.
isolateSquirrelHome("squirrel-pub-capped");

const originalToken = process.env[API_TOKEN_ENV_VAR];
const originalFetch = globalThis.fetch;
let posted: string[];

beforeAll(() => {
  process.env[API_TOKEN_ENV_VAR] = "sq_live_test_token_for_capped_publish";
});
afterAll(() => {
  if (originalToken === undefined) delete process.env[API_TOKEN_ENV_VAR];
  else process.env[API_TOKEN_ENV_VAR] = originalToken;
});
beforeEach(() => {
  posted = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      new URL(String(input)).pathname === "/v1/reports" &&
      init?.method === "POST"
    ) {
      posted.push(String(init.body));
      return Response.json(
        {
          id: "rep_1",
          url: "https://reports.squirrelscan.com/rep_1",
          visibility: "public",
          createdAt: "2026-10-12T00:00:00.000Z",
        },
        { status: 201 }
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Body = {
  report: CappedReport<AuditReport> & Record<string, unknown>;
  visibility: string;
};

/** Publish `report` and return the one body the CLI sent, raw and parsed. */
async function publishedBody(
  report: AuditReport
): Promise<{ raw: string; body: Body }> {
  const result = await publishReport(report);
  expect(result.ok).toBe(true);
  expect(posted).toHaveLength(1);
  return { raw: posted[0]!, body: JSON.parse(posted[0]!) as Body };
}

/** Large reports take seconds to build and cap on a loaded machine. */
const SLOW = 120_000;

describe("the CLI publishes the capped report (repo#2667)", () => {
  test(
    "the body is at most PUBLISHED_REPORT_MAX_BYTES at 50, 100, 500, 2,000 and 10,000 pages",
    async () => {
      for (const pages of [50, 100, 500, 2_000, 10_000]) {
        posted = [];
        const { raw, body } = await publishedBody(publishReportShape(pages));
        expect(byteLength(raw)).toBeLessThanOrEqual(PUBLISHED_REPORT_MAX_BYTES);
        expect(body.report.detail).toMatchObject({
          capped: true,
          fullDetail: "local",
        });
        expect(body.report.pages).toEqual([]);
        expect(body.report.resolutionSignalCompact).toBeDefined();
      }
    },
    SLOW
  );

  test(
    "every check class failing on every page, the worst case, fits",
    async () => {
      const { raw, body } = await publishedBody(
        publishReportShape(100, { everyClassFails: 10 })
      );
      expect(byteLength(raw)).toBeLessThanOrEqual(PUBLISHED_REPORT_MAX_BYTES);
      expect(body.report.detail.capped).toBe(true);
    },
    SLOW
  );

  test("multi-byte text is measured in UTF-8 bytes, and fits", async () => {
    // Every site string in a three-byte character: a size counted in UTF-16
    // code units would read a third of the real body.
    const { raw } = await publishedBody(
      publishReportShape(500, { char: "中" })
    );
    expect(byteLength(raw)).toBeLessThanOrEqual(PUBLISHED_REPORT_MAX_BYTES);
  });

  test("the body is capReportForPublish of the report and the CLI's own fields, byte for byte", async () => {
    const report = publishReportShape(200);
    const { raw } = await publishedBody(report);
    const homepage = pickHomepageSummary(report);
    const expected = capReportForPublish(
      {
        ...report,
        generatorVersion: version,
        lockedRules: computeLockedRules(report),
        ...(homepage ? { homepage } : {}),
      },
      { fullDetail: "local" }
    );
    expect(raw).toBe(
      JSON.stringify({ report: expected, visibility: "public" })
    );
    expect(homepage).toBeDefined();
  });

  test("the raw resolution signal is never sent, only the compact one", async () => {
    const report = publishReportShape(50);
    // A report rebuilt by an older release may still hold the original shape.
    (report as { resolutionSignal?: unknown }).resolutionSignal =
      buildResolutionSignal(
        report.ruleResults,
        report.pages.map((p) => p.url)
      );
    const { raw, body } = await publishedBody(report);
    expect("resolutionSignal" in body.report).toBe(false);
    expect(raw).not.toContain('"resolutionSignal"');
    expect(body.report.resolutionSignalCompact).toBeDefined();
    // Nor the local replay cache.
    expect("rulesCache" in body.report).toBe(false);
  });

  test("publishing leaves the report untouched, so a --format json export keeps every row", async () => {
    const report = publishReportShape(300);
    const before = structuredClone(report);
    await publishedBody(report);
    expect(report).toEqual(before);
  });

  test("a report whose skeleton cannot fit is refused before any request", async () => {
    // 20,000 rules' meta and tallies alone are past the budget: nothing to sample away.
    const ruleResults: Record<string, unknown> = {};
    for (let r = 0; r < 20_000; r++) {
      ruleResults[`rule-${r}`] = {
        meta: {
          id: `rule-${r}`,
          name: `A rule with a long descriptive name, number ${r}`,
          description: "",
          category: "seo",
          scope: "site",
          severity: "error",
          weight: 1,
        },
        checks: [{ name: "c", status: "fail", message: "m" }],
      };
    }
    const result = await publishReport({
      ...publishReportShape(1),
      ruleResults,
    } as unknown as AuditReport);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(result.error.message).toContain("squirrel report");
    expect(posted).toHaveLength(0);
  });
});
