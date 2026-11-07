// #1570 end to end, class-cut path: a local audit of a page with a 640,000-token class attribute (it used to fail with
// `Maximum call stack size exceeded` and no report) and a normal page exits 0, writes the report and warns `html-parse` on the big
// page only. It does NOT reach the empty-document path (no input known today does); that is covered by unit tests.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-huge-class-1570-"));

const page = (title: string, body: string): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><title>${title}</title><meta name="viewport" content="width=device-width"></head><body><main><h1>${title}</h1>${body}</main></body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    }
  );

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/")
      return page(
        "Home page of the fixture",
        '<p><a href="/huge">huge</a> <a href="/normal">normal</a></p>'
      );
    if (pathname === "/huge")
      return page(
        "A page with a huge class",
        `<div class="${"a ".repeat(640_000)}">inside</div>`
      );
    if (pathname === "/normal")
      return page("A normal page of the fixture", "<p>Ordinary content.</p>");
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

interface Json {
  issues?: Array<{
    ruleId: string;
    checks?: Array<{ name: string; status: string; affectedPages?: string[] }>;
  }>;
}

describe("a 640,000-token class attribute does not fail the audit (#1570)", () => {
  test("the audit exits 0, writes a report and warns html-parse on the big page only", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (
        v === undefined ||
        /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k)
      )
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
        "--passive",
        "--http",
        "--no-publish",
        "-m",
        "5",
        "-f",
        "json",
      ],
      {
        env: {
          ...env,
          HOME: join(scratch, "home"),
          SQUIRREL_NO_UPDATE: "1",
          NO_TELEMETRY: "1",
          NO_COLOR: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect([code, err.includes("Maximum call stack")]).toEqual([0, false]);

    // a report was written: parseable JSON that names the rule and the big page
    const json = JSON.parse(out) as Json;
    const parse = (json.issues ?? [])
      .filter((r) => r.ruleId === "crawl/html-size")
      .flatMap((r) => r.checks ?? [])
      .filter((c) => c.name === "html-parse");
    expect(parse.length).toBeGreaterThan(0);
    expect(parse.every((c) => c.status === "warn")).toBe(true);
    expect(parse.flatMap((c) => c.affectedPages ?? [])).toEqual([
      `http://127.0.0.1:${site.port}/huge`,
    ]);
  }, 180_000);
});
