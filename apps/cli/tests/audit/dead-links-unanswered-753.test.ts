// pub#753, through the CLI's own dead-links checker: the urls the service
// leaves out of its answer are checked locally with their local status, and a
// chunk answered with none of its urls stops the CLI sending further chunks.
// An empty answer is never "all links fine".
//
// The link targets are on loopback, named by a public-looking name that
// resolves there: the engine never sends the service a link whose URL names a
// non-public host (pub#775). An audit of a local site checks those locally.

import { checkExternalLinks } from "@squirrelscan/audit-engine";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { resolveDeadLinksBulkChecker } from "@/audit/cloud";
import { getDefaultConfig } from "@/config";

// The engine sends the service at most this many urls per call.
const CHUNK = 200;

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Paths the local link target was asked for, since the last serve. */
let requested: string[] = [];

/** A link target: `/gone*` is a 404, everything else a 200. */
function serveTargets(): string {
  requested = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requested.push(path);
      return new Response("target", {
        status: path.startsWith("/gone") ? 404 : 200,
      });
    },
  });
  servers.push(server);
  return `http://targets.example:${server.port}`;
}

/** A dead-links client that answers whichever urls `pick` names, as live. */
function deadLinksClient(pick: (urls: string[]) => string[]) {
  const calls: string[][] = [];
  const client = {
    deadLinks: async (req: { urls: string[] }) => {
      calls.push(req.urls);
      return {
        results: pick(req.urls).map((url) => ({
          url,
          status: 200,
          error: null,
          redirectUrl: null,
          fromCache: true,
        })),
      };
    },
  } as never;
  return { calls, client };
}

async function checkLinks(urls: string[], pick: (urls: string[]) => string[]) {
  const { calls, client } = deadLinksClient(pick);
  const config = getDefaultConfig();
  config.cloud.enabled = true;
  const checker = await resolveDeadLinksBulkChecker({
    client,
    config,
    auditId: "audit-1",
    externalLinkCount: urls.length,
  });
  expect(checker).not.toBeNull();

  // An audit of a local site: private addresses allowed, and the targets'
  // name resolves to the fixture.
  const results = await Effect.runPromise(
    checkExternalLinks(urls, null, {
      concurrency: 25,
      timeoutMs: config.external_links.timeout_ms,
      userAgent: "squirrel-test",
      bulkChecker: checker!,
      egress: { allowPrivateNetwork: true, resolve: async () => ["127.0.0.1"] },
    })
  );
  return { calls, checked: new Map(results.map((r) => [r.href, r])) };
}

describe("dead-links answers that leave urls out (pub#753)", () => {
  test("the unanswered urls of a chunk are checked locally, with their local status", async () => {
    const origin = serveTargets();
    const [answered, gone, unanswered] = [
      `${origin}/ok-1`,
      `${origin}/gone-1`,
      `${origin}/ok-2`,
    ];

    const { calls, checked } = await checkLinks(
      [answered, gone, unanswered],
      () => [answered]
    );

    expect(calls).toHaveLength(1);
    expect(checked.get(answered)?.status).toBe(200);
    expect(checked.get(gone)?.status).toBe(404);
    expect(checked.get(unanswered)?.status).toBe(200);
    expect(new Set(requested)).toEqual(new Set(["/gone-1", "/ok-2"]));
  });

  test("no url of the first chunk answered: no further chunks are sent, every url is checked locally", async () => {
    const origin = serveTargets();
    const urls = Array.from({ length: CHUNK * 2 + 50 }, (_, i) =>
      i % 10 === 0 ? `${origin}/gone-${i}` : `${origin}/ok-${i}`
    );

    const { calls, checked } = await checkLinks(urls, () => []);

    expect(calls).toHaveLength(1);
    expect(checked.size).toBe(urls.length);
    for (const url of urls) {
      expect(checked.get(url)?.status).toBe(url.includes("/gone-") ? 404 : 200);
    }
    expect(new Set(requested).size).toBe(urls.length);
  });

  test("a chunk that answers at least one url does not stop the pass", async () => {
    const origin = serveTargets();
    const urls = Array.from(
      { length: CHUNK * 2 + 50 },
      (_, i) => `${origin}/ok-${i}`
    );

    const { calls } = await checkLinks(urls, (chunk) => [chunk[0]!]);

    expect(calls.map((c) => c.length)).toEqual([CHUNK, CHUNK, 50]);
    expect(new Set(requested).size).toBe(urls.length - 3);
  });
});
