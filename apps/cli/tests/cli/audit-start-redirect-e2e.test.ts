// `squirrel audit` against a start URL that redirects (#1281), end to end: the
// real CLI in a subprocess, a local destination site, and a local "shortener"
// that answers 301 to it. `localhost` and `127.0.0.1` are different hosts, so
// the redirect is cross-domain; a path change on one host is same-site. Every
// run gets a scratch HOME, --offline, no update or telemetry, and no stdin
// (not a terminal, so nothing can be asked).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-start-redirect-"));

const destinationHits: string[] = [];
const destination = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    destinationHits.push(pathname);
    if (pathname === "/" || pathname === "/about") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Dest ${pathname}</title></head><body><h1>Hello</h1><a href="/about">About</a></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

const shortener = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/x") {
      return new Response(null, {
        status: 301,
        headers: { location: `${destination.url.origin}/` },
      });
    }
    // Same host, same port: a path change only.
    if (pathname === "/old") {
      return new Response(null, { status: 302, headers: { location: "/" } });
    }
    if (pathname === "/") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Shortener home</title></head><body><h1>Home</h1></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  void destination.stop(true);
  void shortener.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  destinationHits.length = 0;
});

let homes = 0;

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: join(scratch, `home-${++homes}`),
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

async function audit(url: string, ...args: string[]) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      url,
      "--offline",
      "-m",
      "3",
      ...(args.includes("-f") ? [] : ["-f", "json"]),
      ...args,
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

// `localhost` resolves to this machine and is a different host from 127.0.0.1.
const shortUrl = `http://localhost:${shortener.port}/x`;

describe("squirrel audit with a start URL that redirects to another site", () => {
  test("-y alone does not follow it: exit 4, status redirected, nothing crawled", async () => {
    const r = await audit(shortUrl, "-y");
    expect(r.code).toBe(4);
    const outcome = JSON.parse(r.out) as {
      status: string;
      originalUrl: string;
      finalUrl: string;
      redirectChain: { url: string; status: number }[];
      rerunCommand: string;
    };
    expect(outcome.status).toBe("redirected");
    expect(outcome.originalUrl).toBe(shortUrl);
    expect(outcome.finalUrl).toBe(`${destination.url.origin}/`);
    expect(outcome.redirectChain.map((hop) => hop.status)).toEqual([301, 200]);
    expect(outcome.rerunCommand).toBe(
      `squirrel audit ${shortUrl} --follow-redirect`
    );
    // The destination was asked once, to resolve the chain, and never crawled
    // (no robots.txt, sitemap or second page).
    expect(destinationHits).toEqual(["/"]);
  }, 60_000);

  test("without -y the exit code and outcome are the same, in text too", async () => {
    const r = await audit(shortUrl, "-f", "text");
    expect(r.code).toBe(4);
    expect(r.out).toContain(`Final URL: ${destination.url.origin}/`);
    expect(r.out).toContain(
      `Re-run: squirrel audit ${shortUrl} --follow-redirect`
    );
  }, 60_000);

  test("--follow-redirect audits the destination and the report records the chain", async () => {
    const r = await audit(shortUrl, "--follow-redirect");
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as {
      meta: {
        baseUrl: string;
        originalUrl?: string;
        redirectChain?: { url: string; status: number }[];
      };
    };
    expect(report.meta.baseUrl).toBe(destination.url.origin);
    expect(report.meta.originalUrl).toBe(shortUrl);
    expect(report.meta.redirectChain?.[0]).toEqual({
      url: shortUrl,
      status: 301,
    });
    expect(destinationHits).toContain("/about");
  }, 90_000);

  test("[crawler] follow_redirect = true does the same", async () => {
    const config = join(scratch, "follow.toml");
    await Bun.write(config, "[crawler]\nfollow_redirect = true\n");
    const r = await audit(shortUrl, "--config-file", config);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as {
      meta: { baseUrl: string; originalUrl?: string };
    };
    expect(report.meta.baseUrl).toBe(destination.url.origin);
    expect(report.meta.originalUrl).toBe(shortUrl);
  }, 90_000);
});

describe("squirrel audit with a same-site start redirect", () => {
  test("is followed silently: exit 0, the base is the final URL, no redirect record", async () => {
    const r = await audit(`${shortener.url.origin}/old`);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as {
      meta: { baseUrl: string; originalUrl?: string };
    };
    expect(report.meta.baseUrl).toBe(shortener.url.origin);
    expect(report.meta.originalUrl).toBeUndefined();
  }, 90_000);
});
