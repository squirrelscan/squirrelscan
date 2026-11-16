// perf/unused-javascript and perf/long-tasks: cloud runtime-perf envelope readers (repo#4681).

import { describe, expect, test } from "bun:test";

import type { RuntimePerfResult } from "@squirrelscan/core-contracts";

import { CLOUD_SITE_KEY, type CloudResultEnvelope, type CloudResultStore } from "../src/cloud";
import { longTasksRule } from "../src/performance/long-tasks";
import { unusedJavascriptRule } from "../src/performance/unused-javascript";
import type { CheckResult, Rule, RuleContext } from "../src/types";

function ctxWith(envelope?: CloudResultEnvelope<RuntimePerfResult>): RuleContext {
  const cloudResults: CloudResultStore | undefined = envelope
    ? new Map([["runtime-perf", new Map([[CLOUD_SITE_KEY, envelope as CloudResultEnvelope]])]])
    : undefined;
  return { cloudResults, options: {} } as RuleContext;
}

const ok = (data: RuntimePerfResult): CloudResultEnvelope<RuntimePerfResult> => ({ status: "ok", data });

async function run(rule: Rule, ctx: RuleContext): Promise<CheckResult[]> {
  return ((await rule.run(ctx)) as { checks: CheckResult[] }).checks;
}

const KB = 1024;

describe("perf/unused-javascript", () => {
  test("skips, not fails, with no envelope (CLI run)", async () => {
    const [c] = await run(unusedJavascriptRule, ctxWith());
    expect(c.status).toBe("skipped");
    expect(c.skipReason).toContain("cloud audit");
  });

  test("skips on a skipped envelope and records the reason", async () => {
    const [c] = await run(unusedJavascriptRule, ctxWith({ status: "skipped", skipReason: "render-failed" }));
    expect(c.status).toBe("skipped");
    expect(c.details?.cloudSkipReason).toBe("render-failed");
  });

  test("lists top first-party scripts by unused bytes and keeps third-party out of the verdict", async () => {
    const [c] = await run(
      unusedJavascriptRule,
      ctxWith(
        ok({
          capturedAt: "2026-11-16T00:00:00Z",
          totalPages: 40,
          pages: [
            {
              url: "https://a.test/",
              longTasks: null,
              scripts: [
                { url: "https://a.test/app.js", totalBytes: 400 * KB, unusedBytes: 150 * KB, thirdParty: false },
                { url: "https://a.test/small.js", totalBytes: 10 * KB, unusedBytes: 2 * KB, thirdParty: false },
                { url: "https://tags.example/t.js", totalBytes: 900 * KB, unusedBytes: 800 * KB, thirdParty: true },
              ],
            },
            {
              url: "https://a.test/b",
              longTasks: null,
              scripts: [{ url: "https://a.test/app.js", totalBytes: 400 * KB, unusedBytes: 120 * KB, thirdParty: false }],
            },
          ],
        }),
      ),
    );
    expect(c.status).toBe("warn");
    expect(c.items?.map((i) => i.id)).toEqual(["https://a.test/app.js", "https://a.test/small.js"]);
    expect(c.details?.firstPartyUnusedBytes).toBe(152 * KB);
    expect(c.details?.thirdPartyUnusedBytes).toBe(800 * KB);
    expect(c.message).toContain("cloud runner");
    expect(c.message).toContain("2 of 40 sampled pages");
  });

  test("passes when third-party bytes alone are large", async () => {
    const [c] = await run(
      unusedJavascriptRule,
      ctxWith(
        ok({
          capturedAt: "x",
          pages: [
            {
              url: "https://a.test/",
              longTasks: null,
              scripts: [{ url: "https://t.example/t.js", totalBytes: 900 * KB, unusedBytes: 800 * KB, thirdParty: true }],
            },
          ],
        }),
      ),
    );
    expect(c.status).toBe("pass");
    expect(c.items).toBeUndefined();
  });
});

describe("perf/long-tasks", () => {
  test("skips with no envelope", async () => {
    const [c] = await run(longTasksRule, ctxWith());
    expect(c.status).toBe("skipped");
  });

  test("reports longest task and TBT, naming the runner", async () => {
    const [c] = await run(
      longTasksRule,
      ctxWith(
        ok({
          capturedAt: "x",
          totalPages: 10,
          pages: [
            { url: "https://a.test/", scripts: [], longTasks: { count: 3, longestMs: 310, tbtMs: 450 } },
            { url: "https://a.test/b", scripts: [], longTasks: { count: 1, longestMs: 80, tbtMs: 30 } },
          ],
        }),
      ),
    );
    expect(c.status).toBe("warn");
    expect(c.details?.longestTaskMs).toBe(310);
    expect(c.details?.worstTbtMs).toBe(450);
    expect(c.message).toContain("squirrelscan's cloud runner");
    expect(c.items?.map((i) => i.id)).toEqual(["https://a.test/"]);
  });

  test("fails past 600 ms and passes under 200 ms", async () => {
    const mk = (tbtMs: number) =>
      ctxWith(ok({ capturedAt: "x", pages: [{ url: "u", scripts: [], longTasks: { count: 1, longestMs: 100, tbtMs } }] }));
    expect((await run(longTasksRule, mk(700)))[0].status).toBe("fail");
    expect((await run(longTasksRule, mk(100)))[0].status).toBe("pass");
  });

  test("skips when no sampled page has long-task data", async () => {
    const [c] = await run(longTasksRule, ctxWith(ok({ capturedAt: "x", pages: [{ url: "u", scripts: [], longTasks: null }] })));
    expect(c.status).toBe("skipped");
  });
});
