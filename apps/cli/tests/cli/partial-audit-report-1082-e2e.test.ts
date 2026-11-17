// repo#1082: the partial-audit marker of a --rule-include run is saved with the crawl, so
// `squirrel report` rebuilt from the store later carries it in JSON and prints it in text,
// exactly as the audit did. One scratch HOME for the audit and the report that reads it back.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-partial-1082-"));

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/about") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Page ${pathname}</title><meta name="description" content="A page"></head><body><h1>Hello</h1><a href="/about">About</a></body></html>`,
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

function env(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    out[k] = v;
  }
  return {
    ...out,
    HOME: home,
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

async function squirrel(home: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
    env: env(home),
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

const url = () => `http://127.0.0.1:${site.port}/`;

interface Json {
  meta: {
    partialAudit?: { include: string[]; includedCategories: string[] };
  };
  summary?: { score?: number };
}

describe("partial-audit marker on a rebuilt report (repo#1082)", () => {
  test("report -f json and text carry the marker of a rule-filtered audit", async () => {
    const home = join(scratch, "home-filtered");
    const audit = await squirrel(
      home,
      "audit",
      url(),
      "--offline",
      "--http",
      "-m",
      "5",
      "--rule-include",
      "core/*",
      "-f",
      "json"
    );
    expect(audit.code).toBe(0);
    const live = JSON.parse(audit.out) as Json;
    expect(live.meta.partialAudit?.includedCategories).toEqual(["core"]);

    const rebuilt = await squirrel(home, "report", "-f", "json");
    expect(rebuilt.code).toBe(0);
    const json = JSON.parse(rebuilt.out) as Json;
    expect(json.meta.partialAudit).toEqual(live.meta.partialAudit);

    const text = await squirrel(home, "report", "-f", "text");
    expect(text.code).toBe(0);
    expect(text.out).toContain("Partial audit: included core");
  }, 120_000);

  test("an unfiltered audit's rebuilt report carries no marker", async () => {
    const home = join(scratch, "home-full");
    const audit = await squirrel(
      home,
      "audit",
      url(),
      "--offline",
      "--http",
      "-m",
      "5",
      "-f",
      "json"
    );
    expect(audit.code).toBe(0);
    const rebuilt = await squirrel(home, "report", "-f", "json");
    expect(rebuilt.code).toBe(0);
    expect("partialAudit" in (JSON.parse(rebuilt.out) as Json).meta).toBe(
      false
    );
    const text = await squirrel(home, "report", "-f", "text");
    expect(text.out).not.toContain("Partial audit");
  }, 120_000);
});
