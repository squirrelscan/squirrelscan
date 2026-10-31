// #1419 controller regression: when --max-duration cuts the rules Effect after
// an [[ignore]] timeout, the partial report keeps the timeout notice.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("ignore-timeout-cut-controller-1419");

const realAdapter = await import("@/audit/adapter");
const realMaxDuration = await import("@/audit/max-duration");
const createRealDurationBudget = realMaxDuration.createDurationBudget;

let durationBudget: ReturnType<typeof realMaxDuration.createDurationBudget>;

mock.module("@/audit/max-duration", () => ({
  ...realMaxDuration,
  createDurationBudget: (seconds: number | undefined, startedAt?: number) => {
    const real = createRealDurationBudget(seconds, startedAt);
    if (!real) return undefined;
    const afterTest = Date.now() + 60_000;
    durationBudget = {
      ...real,
      discoveryDoneAt: afterTest,
      crawlStopAt: afterTest,
      checksDoneAt: afterTest,
      probesDoneAt: afterTest,
      pageRulesStopAt: afterTest,
      hardStopAt: afterTest,
    };
    return durationBudget;
  },
}));

mock.module("@/audit/adapter", () => ({
  ...realAdapter,
  runStreamingRules: (
    ...args: Parameters<typeof realAdapter.runStreamingRules>
  ) => {
    const options = args[5];
    if (!durationBudget) throw new Error("duration budget was not created");
    (durationBudget as { hardStopAt: number }).hardStopAt = Date.now() + 100;
    return Effect.gen(function* () {
      options?.onIgnoreTimeout?.(0);
      return yield* Effect.never;
    });
  },
}));

const { runAudit } = await import("@/controllers/audit");

const scratch = mkdtempSync(join(tmpdir(), "squirrel-ignore-cut-controller-"));
const configPath = join(scratch, "squirrel.toml");

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  writeFileSync(
    configPath,
    `[[ignore]]
rule = "security/cookie-flags"
items = ["glob:*never*"]
`
  );
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response(
        '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><h1>Fixture</h1></body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
  mock.restore();
});

describe("a cut rules phase after an ignore timeout (#1419)", () => {
  test("the partial report retains the timed-out entry index", async () => {
    const result = await runAudit({
      url: server.url.origin,
      projectName: "ignore-timeout-cut-controller-1419",
      configPath,
      maxPages: 1,
      coverageMode: "surface",
      offline: true,
      refresh: true,
      disableDiscoveryProbes: true,
      ruleInclude: ["security/cookie-flags"],
      maxDurationSeconds: 1,
    });

    if (!result.ok) throw new Error(`audit failed: ${result.error.message}`);
    expect(result.data.status).toBe("partial");
    expect(result.data.maxDuration?.siteChecksCut).toBe(true);
    expect(result.data.ignored?.timedOutEntries).toEqual([0]);
  }, 15_000);
});
