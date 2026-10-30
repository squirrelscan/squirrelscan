// #422: `squirrel crawl --disable-discovery-probes` sends no discovery probe and
// overrides the config; `--disable-discovery-probes false` (a space) is refused
// instead of turning the probes off; an audit reads robots.txt once.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-probe-flag-"));
const hits: string[] = [];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    hits.push(pathname);
    if (pathname === "/robots.txt")
      return new Response("User-agent: *\nAllow: /\n");
    if (pathname === "/") {
      return new Response(
        '<!doctype html><html lang="en"><head><title>Probe flag fixture</title></head><body><h1>Home</h1></body></html>',
        { headers: { "content-type": "text/html" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  hits.length = 0;
});

let runs = 0;
async function squirrel(args: string[], toml?: string) {
  const dir = join(scratch, `run-${++runs}`);
  mkdirSync(dir, { recursive: true });
  if (toml) writeFileSync(join(dir, "squirrel.toml"), toml);
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: join(dir, "home"),
      SQUIRREL_NO_UPDATE: "1",
      NO_TELEMETRY: "1",
      NO_COLOR: "1",
      SQUIRREL_CONTENT_STORE_PATH: undefined,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

const url = () => `http://127.0.0.1:${server.port}/`;
const PROBE_PATHS = [
  "/llms.txt",
  "/llms-full.txt",
  "/swagger.json",
  "/openapi.json",
  "/.well-known/mcp.json",
  "/AGENTS.md",
];
const probed = () => hits.filter((p) => PROBE_PATHS.includes(p));

describe("squirrel crawl --disable-discovery-probes", () => {
  test("control: a crawl sends the probes", async () => {
    const r = await squirrel(["crawl", url(), "-m", "2"]);
    expect(r.code).toBe(0);
    expect(probed().length).toBeGreaterThan(0);
  }, 120_000);

  test("the flag sends none", async () => {
    const r = await squirrel([
      "crawl",
      url(),
      "-m",
      "2",
      "--disable-discovery-probes",
    ]);
    expect(r.code).toBe(0);
    expect(probed()).toEqual([]);
  }, 120_000);

  test("it overrides the config in both directions", async () => {
    const off = await squirrel(
      ["crawl", url(), "-m", "2", "--disable-discovery-probes"],
      "[crawler]\ndisable_discovery_probes = false\n"
    );
    expect(off.code).toBe(0);
    expect(probed()).toEqual([]);
    hits.length = 0;
    const on = await squirrel(
      ["crawl", url(), "-m", "2", "--disable-discovery-probes=false"],
      "[crawler]\ndisable_discovery_probes = true\n"
    );
    expect(on.code).toBe(0);
    expect(probed().length).toBeGreaterThan(0);
  }, 120_000);
});

describe("--disable-discovery-probes false is refused", () => {
  for (const command of ["crawl", "audit"]) {
    test(`${command}: a space before the value is an error, and nothing is requested`, async () => {
      const extra = command === "audit" ? ["--offline"] : [];
      const r = await squirrel([
        command,
        url(),
        "-m",
        "2",
        ...extra,
        "--disable-discovery-probes",
        "false",
      ]);
      expect(r.code).toBe(1);
      expect(r.err + r.out).toContain("--disable-discovery-probes=false");
      expect(hits).toEqual([]);
    }, 120_000);
  }
});

describe("an audit reads robots.txt once", () => {
  test("one request for /robots.txt", async () => {
    const r = await squirrel([
      "audit",
      url(),
      "--offline",
      "-m",
      "2",
      "-f",
      "json",
      "-o",
      join(scratch, "robots-once.json"),
    ]);
    expect(r.code).toBe(0);
    expect(hits.filter((p) => p === "/robots.txt")).toHaveLength(1);
  }, 120_000);
});

describe("spacedBooleanValueError", () => {
  test("any occurrence of the flag can carry the stray value, and missing raw args is fine", async () => {
    const { spacedBooleanValueError } =
      await import("../../src/cli/commands/audit");
    const flag = "--disable-discovery-probes";
    expect(spacedBooleanValueError(undefined, flag)).toBeNull();
    expect(spacedBooleanValueError([], flag)).toBeNull();
    expect(spacedBooleanValueError([flag, "https://e.test"], flag)).toBeNull();
    expect(spacedBooleanValueError([`${flag}=false`], flag)).toBeNull();
    expect(spacedBooleanValueError([flag, "false"], flag)).toContain(
      `${flag}=false`
    );
    expect(
      spacedBooleanValueError([flag, "--offline", flag, "TRUE"], flag)
    ).toContain(`${flag}=true`);
  });
});
