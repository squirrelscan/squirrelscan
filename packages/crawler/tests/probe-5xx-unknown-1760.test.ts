// A 5xx on /llms.txt or the Markdown probe is no answer about the file, so the probe
// stores nothing (null: the rules report "not checked"), unlike a 404 (#1760).

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fetchLlmsTxt } from "../src/llms";
import { probeMarkdownResponse } from "../src/markdown";

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serveAll(status: number): string {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("x", { status }),
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

describe("5xx is unknown, 404 is absent (#1760)", () => {
  for (const status of [500, 502, 503]) {
    test(`llms.txt ${status} is no answer`, async () => {
      expect(
        await Effect.runPromise(fetchLlmsTxt(serveAll(status), "squirrel-test"))
      ).toBeNull();
    });
    test(`markdown ${status} is no answer`, async () => {
      expect(
        await Effect.runPromise(
          probeMarkdownResponse(serveAll(status), "squirrel-test")
        )
      ).toBeNull();
    });
  }
  test("llms.txt 404 is a stored absent file (control)", async () => {
    const r = await Effect.runPromise(
      fetchLlmsTxt(serveAll(404), "squirrel-test")
    );
    expect(r?.llmsTxt.exists).toBe(false);
  });
  test("markdown 404 is stored as no Markdown (control)", async () => {
    const r = await Effect.runPromise(
      probeMarkdownResponse(serveAll(404), "squirrel-test")
    );
    expect(r).not.toBeNull();
    expect(r?.mdVariantExists).toBe(false);
  });
});
