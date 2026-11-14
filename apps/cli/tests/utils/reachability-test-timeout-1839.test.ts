// #1839: SQUIRREL_TEST_REACHABILITY_TIMEOUT_MS replaces the start-URL probe limits
// (the reachability check and the redirect probe's per hop timeout) under `bun test`
// only. With NODE_ENV anything else the production limits apply.

import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { resolveAuditStart } from "@/cli/start-redirect";
import { checkReachability } from "@/utils/reachability";

const KNOB = "SQUIRREL_TEST_REACHABILITY_TIMEOUT_MS";
const saved = { nodeEnv: process.env.NODE_ENV, knob: process.env[KNOB] };

function restore(): void {
  process.env.NODE_ENV = saved.nodeEnv;
  if (saved.knob === undefined) delete process.env[KNOB];
  else process.env[KNOB] = saved.knob;
}
afterEach(restore);

// Accepts the connection and never answers.
const blackhole = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {}, open() {}, close() {} },
});
afterAll(() => blackhole.stop(true));

describe("checkReachability with the test timeout knob", () => {
  test("honoured under NODE_ENV test: a silent host fails at the configured limit", async () => {
    process.env[KNOB] = "600";
    const started = Date.now();
    const result = await checkReachability(
      `http://127.0.0.1:${blackhole.port}/`
    );
    const elapsed = Date.now() - started;
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(elapsed).toBeGreaterThanOrEqual(550);
    // The production limits are 10 s per attempt and 20 s in all.
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);

  test("ignored when NODE_ENV is not test: the probe is still waiting well past it", async () => {
    process.env.NODE_ENV = "production";
    process.env[KNOB] = "600";
    // Its own listener, so closing it ends this probe without touching the other test's.
    const own = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, close() {} },
    });
    const probe = checkReachability(`http://127.0.0.1:${own.port}/`);
    const winner = await Promise.race([
      probe.then(() => "probe"),
      Bun.sleep(2_500).then(() => "timer"),
    ]);
    // Close the listener and its sockets so the pending probe ends (refused on any retry).
    own.stop(true);
    await probe;
    expect(winner).toBe("timer");
  }, 30_000);
});

describe("resolveAuditStart with the test timeout knob", () => {
  const optionsSeen = async (): Promise<{ timeoutMs?: number }> => {
    let seen: { timeoutMs?: number } = {};
    await resolveAuditStart({
      url: "https://example.com/",
      follow: false,
      interactive: false,
      resolve: async (url, options) => {
        seen = options ?? {};
        return { kind: "none", originalUrl: url, finalUrl: url, chain: [] };
      },
    });
    return seen;
  };

  test("honoured under NODE_ENV test: the redirect probe's per hop timeout", async () => {
    process.env[KNOB] = "700";
    expect((await optionsSeen()).timeoutMs).toBe(700);
  });

  test.each(["production", "development"])(
    "ignored when NODE_ENV is %p: the probe keeps its own timeout",
    async (nodeEnv) => {
      process.env.NODE_ENV = nodeEnv;
      process.env[KNOB] = "700";
      expect((await optionsSeen()).timeoutMs).toBeUndefined();
    }
  );

  test("an invalid value is ignored", async () => {
    process.env[KNOB] = "0.5";
    expect((await optionsSeen()).timeoutMs).toBeUndefined();
  });
});
