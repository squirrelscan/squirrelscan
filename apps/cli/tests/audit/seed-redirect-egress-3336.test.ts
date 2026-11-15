// squirrelscan/repo#3336: a CLI audit whose start URL redirects (HTTP 3xx,
// meta refresh or a script) to a link-local or cloud metadata address sends
// nothing there, pinned or not: the reachability probe, the seed redirect
// probe and the crawl all refuse the hop, and the audit goes on with the start
// URL itself.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { runAudit } from "../../src/controllers/audit";
import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("seed-redirect-egress-3336");

const MARKER = "metadata-response-marker";
const TARGETS: Record<string, string> = {
  http: "http://169.254.169.254/latest/meta-data/",
  meta: "http://metadata.google.internal/computeMetadata/v1/",
  js: "http://[fe80::1]/x",
};

function isRefusedHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host.startsWith("169.254.") ||
    host.startsWith("fe80:") ||
    host === "metadata.google.internal"
  );
}

const page = (head: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><title>Start page</title>${head}</head><body><h1>Start</h1></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );

let server: ReturnType<typeof Bun.serve>;
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let requested: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const kind = new URL(req.url).pathname.slice(1);
      const target = TARGETS[kind];
      if (kind === "http" && target) {
        return new Response(null, {
          status: 302,
          headers: { location: target },
        });
      }
      if (kind === "meta" && target) {
        return page(`<meta http-equiv="refresh" content="0; url=${target}">`);
      }
      if (kind === "js" && target) {
        return page(`<script>window.location.href = "${target}";</script>`);
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  requested = [];
  // Anonymous, offline from the API, no update check or telemetry.
  delete process.env.SQUIRREL_API_TOKEN;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    if (isRefusedHost(url)) return page(`<meta name="x" content="${MARKER}">`);
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") {
      throw new TypeError(`fixture: no network for ${url}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe.each([
  ["own hosts pinned (the default)", ""],
  ["own hosts not pinned (SQUIRREL_NO_HOST_PINNING)", "1"],
] as const)(
  "a CLI audit whose start URL redirects to a refused address, %s (repo#3336)",
  (_name, noPinning) => {
    test.each(Object.keys(TARGETS))(
      "%s redirect: nothing is sent there and the start URL is audited",
      async (kind) => {
        process.env.SQUIRREL_NO_HOST_PINNING = noPinning;
        const start = `http://localhost:${server.port}/${kind}`;
        const result = await runAudit({
          url: start,
          projectName: `seed-redirect-egress-3336-${kind}-${noPinning || "pinned"}`,
          maxPages: 1,
          coverageMode: "surface",
          refresh: true,
          disableDiscoveryProbes: true,
          ruleInclude: ["core/meta-title"],
        });

        expect(requested.filter(isRefusedHost)).toEqual([]);
        expect(requested.some((u) => u.endsWith(`/${kind}`))).toBe(true);
        if (!result.ok)
          throw new Error(`audit failed: ${result.error.message}`);
        expect(JSON.stringify(result.data)).not.toContain(MARKER);
        expect(result.data.pages.map((p) => p.url)).toContain(start);
      },
      20_000
    );
  }
);
