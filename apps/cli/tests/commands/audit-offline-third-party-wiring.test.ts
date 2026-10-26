// pub#807: `squirrel audit --offline` sends no request to a host outside the
// audited site. Driven through citty's real parser, like the other wiring
// tests, with a stubbed fetch: the assertion is on what reached the network.
// The page loads a third-party stylesheet and script, which reliability/
// broken-resources would otherwise status-check (#703). They are on hosts that
// resolve (www.example.org, www.example.net), so without the fix the probe's
// pinned request reaches the stub here instead of failing at DNS.
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
import { runCommand } from "citty";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// See audit-discovery-probes-wiring.test.ts for why the stores are closed and
// every squirrel path is pointed at a scratch dir.
function closeGlobalStores(): void {
  closeGlobalContentStore();
  closeGlobalLinkCache();
}
const scratch = isolateSquirrelHome("squirrel-offline-third-party").root;
const configPath = join(scratch, "squirrel.toml");
const restores: (() => void)[] = [];

beforeAll(() => {
  closeGlobalStores();
  const previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
  restores.push(() => setGlobalConfigPath(previousConfig));
});

afterAll(() => {
  closeGlobalStores();
  for (const restore of restores) restore();
});

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const HOME = `<html><head><title>t</title>
<link rel="stylesheet" href="https://www.example.org/site.css">
<script src="https://www.example.net/w.js"></script>
</head><body><h1>h</h1></body></html>`;

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalEnv = { ...process.env };
/** The host of every request, by URL and by Host header (a pinned request). */
let hosts: string[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  hosts = [];
  process.exitCode = 0;
  delete process.env.SQUIRREL_API_TOKEN;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  // The site is a stubbed fetch keyed by name: send its hosts by name
  // rather than resolving and pinning them (repo#3430).
  process.env.SQUIRREL_NO_HOST_PINNING = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  restoreConsole = () => {
    log.mockRestore();
    error.mockRestore();
  };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString()
    );
    const host = new Headers(init?.headers).get("host");
    hosts.push(url.hostname, ...(host ? [host.split(":")[0]!] : []));
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(HOME, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  restoreConsole();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.exitCode = originalExitCode ?? 0;
  process.env = { ...originalEnv };
});

describe("squirrel audit --offline and third-party assets (pub#807)", () => {
  test("no request goes to the third-party hosts the page loads", async () => {
    writeFileSync(configPath, "");
    try {
      await runCommand(audit, {
        rawArgs: ["https://example.com/", "-m", "1", "--offline", "-y"],
      });
    } catch (err) {
      if (!(err instanceof ExitSignal)) throw err;
    }
    // The audit ran against the site itself.
    expect(hosts).toContain("example.com");
    expect(
      hosts.filter(
        (h) =>
          h === "example.org" ||
          h.endsWith(".example.org") ||
          h === "example.net" ||
          h.endsWith(".example.net")
      )
    ).toEqual([]);
  });
});
