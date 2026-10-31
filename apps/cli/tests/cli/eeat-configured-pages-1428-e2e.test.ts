// #1428: `squirrel crawl` and `squirrel audit` pass the pages the E-E-A-T rules are configured with to the
// crawler, so a configured page nothing links to is requested once and the finding says it was probed; with
// the discovery probes off, or with no configured path, nothing is requested.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-configured-pages-"));
const hits: string[] = [];
const words = Array.from({ length: 260 }, (_, i) => `word${i % 40}`).join(" ");

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    hits.push(pathname);
    const html = (title: string, body: string, status = 200) =>
      new Response(
        `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`,
        {
          status,
          headers: { "content-type": "text/html" },
        }
      );
    if (pathname === "/robots.txt")
      return new Response("User-agent: *\nAllow: /\n");
    if (pathname === "/")
      return html("Home", "<p>Welcome to the fixture site.</p>");
    if (pathname === "/agentur") return html("Agentur", `<p>${words}</p>`);
    return html("Not found", "<p>nothing</p>", 404);
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
async function squirrel(
  args: string[],
  toml?: string
): Promise<{ code: number; dir: string }> {
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
  await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, dir };
}

const url = () => `http://127.0.0.1:${server.port}/`;
const CONFIG = '[rule_options."eeat/about-page"]\npaths = ["/agentur"]\n';
const requested = (path: string) => hits.filter((p) => p === path).length;

describe("squirrel crawl", () => {
  test("requests a configured page the crawl did not reach, once", async () => {
    expect((await squirrel(["crawl", url(), "-m", "2"], CONFIG)).code).toBe(0);
    expect(requested("/agentur")).toBe(1);
  }, 120_000);

  test("nothing configured, nothing requested; probes off, nothing requested", async () => {
    expect((await squirrel(["crawl", url(), "-m", "2"])).code).toBe(0);
    expect(requested("/agentur")).toBe(0);
    expect(
      (
        await squirrel(
          ["crawl", url(), "-m", "2", "--disable-discovery-probes"],
          CONFIG
        )
      ).code
    ).toBe(0);
    expect(requested("/agentur")).toBe(0);
  }, 120_000);
});

describe("squirrel audit", () => {
  const audit = async (extra: string[], toml?: string): Promise<string> => {
    const out = join(scratch, `report-${runs + 1}.json`);
    const r = await squirrel(
      [
        "audit",
        url(),
        "--offline",
        "-m",
        "2",
        "-f",
        "json",
        "-o",
        out,
        "--rule-include",
        "eeat/about-page",
        ...extra,
      ],
      toml
    );
    expect(r.code).toBe(0);
    return readFileSync(out, "utf8");
  };

  test("finds the configured page and requests it once", async () => {
    const report = await audit([], CONFIG);
    expect(requested("/agentur")).toBe(1);
    // A passing check is not listed in the report: the About rule passed, so nothing is warned.
    const summary = (
      JSON.parse(report) as { summary: { passed: number; warnings: number } }
    ).summary;
    expect(summary).toMatchObject({ passed: 1, warnings: 0 });
  }, 180_000);

  test("without the option the page is reported missing and never requested", async () => {
    const report = await audit([]);
    expect(requested("/agentur")).toBe(0);
    expect(
      (JSON.parse(report) as { summary: { warnings: number } }).summary.warnings
    ).toBe(1);
    expect(report).toContain("No About page found");
  }, 180_000);

  test("with the discovery probes off it is not requested", async () => {
    await audit(["--disable-discovery-probes"], CONFIG);
    expect(requested("/agentur")).toBe(0);
  }, 180_000);
});
