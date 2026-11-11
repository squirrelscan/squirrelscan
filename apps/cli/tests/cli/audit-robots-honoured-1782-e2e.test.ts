// #1782 end to end: the report says whether robots.txt was honoured and how many pages it kept out of the audit.

import { afterAll, describe, expect, test } from "bun:test";
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
const scratch = mkdtempSync(join(tmpdir(), "squirrel-robots-1782-"));

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /private/\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (
      pathname === "/" ||
      pathname.startsWith("/ok") ||
      pathname.startsWith("/private/")
    ) {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Page ${pathname}</title></head><body><h1>Hi</h1><a href="/ok">ok</a> <a href="/private/a">a</a> <a href="/private/b">b</a></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

async function audit(
  respectRobots: boolean,
  format: "json" | "text" | "markdown" | "llm" | "html" = "json"
) {
  const dir = mkdtempSync(join(scratch, "run-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(
    join(dir, "squirrel.toml"),
    `[crawler]\nrespect_robots = ${respectRobots}\n`
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      `http://127.0.0.1:${site.port}/`,
      "--offline",
      "--http",
      "-m",
      "10",
      "-f",
      format,
      ...(format === "html" ? ["-o", join(dir, "report.html")] : []),
    ],
    {
      cwd: dir,
      env: {
        ...env,
        HOME: join(dir, "home"),
        SQUIRREL_NO_UPDATE: "1",
        NO_TELEMETRY: "1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  return format === "html"
    ? readFileSync(join(dir, "report.html"), "utf8")
    : out;
}

interface Json {
  meta: {
    schemaVersion: string;
    respectRobots?: boolean;
    robotsBlockedPages?: number;
  };
}

describe("robots.txt in the report (#1782)", () => {
  test("honoured, on a site that disallows /private/: the JSON carries the flag and the skipped count", async () => {
    const json = JSON.parse(await audit(true)) as Json;
    expect(json.meta.schemaVersion).toBe("1.19");
    expect(json.meta.respectRobots).toBe(true);
    expect(json.meta.robotsBlockedPages).toBe(2);
  });

  test("not honoured (respect_robots = false): the report says so and counts none, the disallowed pages were audited", async () => {
    const json = JSON.parse(await audit(false)) as Json;
    expect(json.meta.respectRobots).toBe(false);
    expect(json.meta.robotsBlockedPages).toBe(0);
  });

  test("text and markdown say it in one sentence", async () => {
    for (const format of ["text", "markdown"] as const) {
      const honoured = await audit(true, format);
      expect(honoured, format).toContain(
        "robots.txt was honoured: 2 URLs it disallows were not audited."
      );
      const ignored = await audit(false, format);
      expect(ignored, format).toContain(
        "robots.txt was not honoured: pages it disallows were audited anyway."
      );
    }
  });

  test("the llm and html reports say it too", async () => {
    const llm = await audit(true, "llm");
    expect(llm).toContain('<robots-txt honoured="true" blocked-pages="2">');
    expect(llm).toContain(
      "robots.txt was honoured: 2 URLs it disallows were not audited."
    );
    expect(await audit(true, "html")).toContain(
      "robots.txt was honoured: 2 URLs it disallows were not audited."
    );
    expect(await audit(false, "html")).toContain("robots.txt was not honoured");
  });
});
