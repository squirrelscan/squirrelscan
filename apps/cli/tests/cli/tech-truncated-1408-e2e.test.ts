// #1408 end to end: a local audit whose scripts the crawl dropped (over the 5 MB fetch cap) or never fetched
// (the audit's script limit) says so in `technologies.truncated`, even when nothing was detected.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-tech-1408-"));
const REF = "abcdefghijklmnopqrst";
const MB = 1024 * 1024;

const pad = (bytes: number): string =>
  "var a=1;\n".repeat(Math.ceil(bytes / 9));

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    const js = (body: string) =>
      new Response(body, {
        headers: { "content-type": "application/javascript" },
      });
    const html = (body: string) =>
      new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (pathname === "/many") {
      // Twelve small scripts: the audit reads ten, the firebase config is in the eleventh.
      const tags = Array.from(
        { length: 12 },
        (_, i) => `<script src="/m${i}.js"></script>`
      ).join("");
      return html(
        `<!doctype html><html lang="en"><head><title>Many scripts here</title></head><body><h1>x</h1>${tags}</body></html>`
      );
    }
    if (pathname === "/big") {
      return html(
        `<!doctype html><html lang="en"><head><title>One big script here</title></head><body><h1>x</h1><script src="/big.js"></script><script src="/small.js"></script></body></html>`
      );
    }
    const m = /^\/m(\d+)\.js$/.exec(pathname);
    if (m) {
      return js(
        m[1] === "10"
          ? `initializeApp({authDomain:"demo-app.firebaseapp.com"});`
          : `var m${m[1]}=1;`
      );
    }
    // Over the 5 MB fetch cap, with a Supabase call in the middle that no one will ever read.
    if (pathname === "/big.js") {
      return js(
        `${pad(3 * MB)}\ncreateClient("https://${REF}.supabase.co","k");\n${pad(3 * MB)}`
      );
    }
    if (pathname === "/small.js") return js("var s=1;");
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void site.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

async function audit(path: string) {
  const home = join(scratch, `home-${path.replace(/\W/g, "")}`);
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
      `http://127.0.0.1:${site.port}${path}`,
      "--offline",
      "--http",
      "-m",
      "3",
      "-f",
      "json",
    ],
    {
      env: {
        ...env,
        HOME: home,
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
  expect([0, 1]).toContain(code);
  return {
    json: JSON.parse(out) as {
      technologies?: {
        source?: string;
        items: Array<{ id: string }>;
        truncated?: { reasons: string[]; scripts: number };
      };
    },
    err,
  };
}

describe("technologies.truncated for scripts the audit never read (#1408)", () => {
  test("twelve scripts, a limit of ten: the unread two are counted and the eleventh script's tech is not found", async () => {
    const { json } = await audit("/many");
    expect(json.technologies?.truncated?.reasons).toContain("script-limit");
    expect(json.technologies?.truncated?.scripts).toBe(2);
    expect(json.technologies?.items.map((t) => t.id) ?? []).not.toContain(
      "firebase"
    );
  }, 180_000);

  test("a script over the 5 MB fetch cap is counted, and its Supabase call is not found", async () => {
    const { json } = await audit("/big");
    expect(json.technologies?.truncated?.reasons).toContain("script-too-large");
    expect(json.technologies?.truncated?.scripts).toBeGreaterThanOrEqual(1);
    expect(json.technologies?.items.map((t) => t.id) ?? []).not.toContain(
      "supabase"
    );
    expect(json.technologies?.source).toBe("local");
  }, 180_000);
});
