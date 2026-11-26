// #2316: with a custom `User-Agent` header and a `[crawler] user_agent` both
// set, page requests send the header, so the seed redirect probe must too. A
// WAF that allows only that agent otherwise answers the probe 403 and the
// audit shrinks to one page. The real CLI runs in a subprocess against a local
// site that 403s every other agent and redirects its apex (`example.com`) to
// `www.example.com`. The site is also the subprocess's HTTP proxy, so both
// names reach it with no DNS and nothing leaves the machine. Every run gets a
// scratch HOME, --offline, no update or telemetry, and no stdin.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-seed-probe-ua-"));

const ALLOWED_AGENT = "custom-agent/2316";
const CONFIGURED_AGENT = "configured-agent/2316";
const SECRET_NAME = "x-audit-secret";

interface Hit {
  host: string;
  path: string;
  agent: string;
  secret: string | null;
}
const hits: Hit[] = [];

const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const host = (req.headers.get("host") ?? "").split(":")[0]!;
    const agent = req.headers.get("user-agent") ?? "";
    hits.push({
      host,
      path: url.pathname,
      agent,
      secret: req.headers.get(SECRET_NAME),
    });
    if (agent !== ALLOWED_AGENT) return new Response("denied", { status: 403 });
    if (host === "example.com") {
      return new Response(null, {
        status: 301,
        headers: {
          location: `http://www.example.com${url.pathname}`,
        },
      });
    }
    if (url.pathname === "/sitemap.xml") {
      const origin = "http://www.example.com";
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/about</loc></url></urlset>`,
        { headers: { "content-type": "application/xml" } }
      );
    }
    if (url.pathname === "/" || url.pathname === "/about") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Page ${url.pathname}</title></head><body><h1>Hello</h1><a href="/about">About</a></body></html>`,
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

beforeEach(() => {
  hits.length = 0;
});

let homes = 0;

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v === undefined ||
      /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k) ||
      /^(https?_proxy|no_proxy|all_proxy)$/i.test(k)
    )
      continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: join(scratch, `home-${++homes}`),
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
    HTTP_PROXY: site.url.origin,
    HTTPS_PROXY: site.url.origin,
  };
}

async function audit(headerName: string) {
  const config = join(scratch, `ua-${homes}.toml`);
  await Bun.write(
    config,
    `[crawler]\nuser_agent = "${CONFIGURED_AGENT}"\n[crawler.headers]\n"${SECRET_NAME}" = "s3cret"\n`
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      "http://example.com/",
      "--offline",
      "-m",
      "3",
      "-f",
      "json",
      "--config-file",
      config,
      "-H",
      `${headerName}: ${ALLOWED_AGENT}`,
    ],
    { env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

describe("the seed redirect probe sends the custom User-Agent header (#2316)", () => {
  for (const headerName of ["User-Agent", "user-agent", "USER-AGENT"]) {
    test(`-H "${headerName}: ..." wins over [crawler] user_agent, and the audit crawls past the seed`, async () => {
      const r = await audit(headerName);
      expect(r.code).toBe(0);

      // The first request is the probe, and the apex is only ever asked by it:
      // the crawl starts from the www destination.
      expect(hits[0]).toMatchObject({ host: "example.com", path: "/" });
      const apex = hits.filter((h) => h.host === "example.com");
      expect(apex.length).toBeGreaterThan(0);
      for (const probe of apex) {
        expect(probe.agent).toBe(ALLOWED_AGENT);
        // No other custom header goes on the probe.
        expect(probe.secret).toBeNull();
      }

      const report = JSON.parse(r.out) as { meta: { baseUrl: string } };
      expect(report.meta.baseUrl).toBe("http://www.example.com");
      expect(
        hits.some((h) => h.host === "www.example.com" && h.path === "/about")
      ).toBe(true);
      // The crawl's own requests do carry the custom headers.
      expect(
        hits.some((h) => h.host === "www.example.com" && h.secret === "s3cret")
      ).toBe(true);
    }, 90_000);
  }
});
