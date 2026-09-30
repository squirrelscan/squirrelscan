import { WELL_KNOWN_PATHS } from "@squirrelscan/core-contracts/storage";
// #409: `squirrel audit` sends no discovery probe when told not to, driven
// through citty's real parser (`runCommand` with raw argv). citty delivers
// `--no-discovery-probes` as `discovery-probes: false` and never sets the
// declared `no-discovery-probes` arg, so a hand-built args object would prove
// nothing (#404 is that exact bug for --no-publish).
//
// The site is a stubbed fetch, and the assertions are on what reached it: on a
// host whose firewall bans a client for asking for /swagger.json, a request
// that goes out is the failure, whatever the report says afterwards.
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import * as pathsModule from "@/self/paths";

// homedir() is fixed at process start in Bun, so $HOME set here cannot keep a
// full audit out of the real ~/.squirrel. Point every store it writes at a
// scratch dir through the paths module instead.
const scratch = mkdtempSync(join(tmpdir(), "squirrel-discovery-probes-"));
const configPath = join(scratch, "squirrel.toml");
const restores: (() => void)[] = [];

beforeAll(() => {
  const previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
  restores.push(() => setGlobalConfigPath(previousConfig));
  const redirect = {
    getSettingsPath: join(scratch, "settings.json"),
    getProjectsPath: join(scratch, "projects"),
    getLinkCachePath: join(scratch, "link-cache.db"),
    getContentStorePath: join(scratch, "content-store.db"),
    getCachePath: join(scratch, "cache"),
    getLogsPath: join(scratch, "logs"),
  } as const;
  for (const [name, path] of Object.entries(redirect)) {
    const spy = spyOn(
      pathsModule,
      name as keyof typeof redirect
    ).mockImplementation(() => path);
    restores.push(() => spy.mockRestore());
  }
});

afterAll(() => {
  for (const restore of restores) restore();
  rmSync(scratch, { recursive: true, force: true });
});

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface SeenRequest {
  path: string;
  userAgent: string;
  accept: string;
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalEnv = { ...process.env };
let requested: SeenRequest[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  requested = [];
  process.exitCode = 0;
  // Anonymous and offline: nothing here may reach a real API.
  delete process.env.SQUIRREL_API_TOKEN;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
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
    const url = new URL(input.toString());
    const headers = new Headers(init?.headers);
    if (url.hostname === "example.com") {
      requested.push({
        path: url.pathname,
        userAgent: headers.get("user-agent") ?? "",
        accept: headers.get("accept") ?? "",
      });
    }
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "<html><head><title>t</title></head><body><h1>h</h1></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
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

/** `squirrel audit https://example.com/ <flags>`, one page, offline, no prompts. */
async function runAudit(flags: string[], config = ""): Promise<void> {
  writeFileSync(configPath, config);
  const rawArgs = [
    "https://example.com/",
    "-m",
    "1",
    "-C",
    "quick",
    "--offline",
    "-y",
    ...flags,
  ];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const PROBE_PATHS = [
  "/llms.txt",
  "/llms-full.txt",
  "/index.md",
  ...WELL_KNOWN_PATHS,
];
const API_PATHS = [
  "/.well-known/api-catalog",
  "/openapi.json",
  "/swagger.json",
  "/api/openapi.json",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
];
const probesSent = () => {
  const paths = requested.map((r) => r.path);
  const byPath = PROBE_PATHS.filter((p) => paths.includes(p));
  // The homepage probes: markdown negotiation and the AI-crawler user agents.
  const homepage = requested.filter(
    (r) =>
      r.path === "/" &&
      (r.accept.startsWith("text/markdown") ||
        /GPTBot|Claude-User/.test(r.userAgent))
  );
  return [...byPath, ...homepage.map((r) => `/ as ${r.userAgent || r.accept}`)];
};
const count = (path: string) => requested.filter((r) => r.path === path).length;

describe("squirrel audit discovery probes (#409)", () => {
  // THE CONTROL: without a setting every probe goes out, so the tests below
  // cannot pass because the stub or the audit never sends anything.
  test("a default audit sends every probe", async () => {
    await runAudit([]);
    expect(probesSent()).toHaveLength(PROBE_PATHS.length + 3);
    expect(count("/swagger.json")).toBe(1);
  });

  test("--no-discovery-probes sends none; robots.txt and sitemaps still run", async () => {
    await runAudit(["--no-discovery-probes"]);
    expect(probesSent()).toEqual([]);
    expect(count("/robots.txt")).toBe(1);
    expect(count("/sitemap.xml")).toBeGreaterThan(0);
    expect(count("/")).toBeGreaterThan(0);
  });

  test("[crawler] discovery_probes = false sends none", async () => {
    await runAudit([], "[crawler]\ndiscovery_probes = false\n");
    expect(probesSent()).toEqual([]);
    expect(count("/robots.txt")).toBe(1);
  });

  test("--no-discovery-probes overrides discovery_probes = true", async () => {
    await runAudit(
      ["--no-discovery-probes"],
      "[crawler]\ndiscovery_probes = true\n"
    );
    expect(probesSent()).toEqual([]);
  });

  test("--rule-exclude ax sends none, with no other setting", async () => {
    await runAudit(["--rule-exclude", "ax"]);
    expect(probesSent()).toEqual([]);
  });

  test("--rule-exclude ax/api-discovery drops only the API paths", async () => {
    await runAudit(["--rule-exclude", "ax/api-discovery"]);
    for (const path of API_PATHS) expect(count(path)).toBe(0);
    expect(count("/AGENTS.md")).toBe(1);
    expect(count("/llms.txt")).toBe(1);
  });
});
