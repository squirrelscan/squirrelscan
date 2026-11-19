// pub#2140: a site that resets any client claiming to be Chrome (a bot filter
// at the TLS layer) used to fail the audit at the reachability probe: the probe
// ignored `[crawler] user_agent` and retried the same browser headers. A local
// TCP server resets connections whose request carries a Chrome UA and answers
// every other client with a page.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHROME_USER_AGENT, SQUIRRELSCAN_USER_AGENT } from "@/constants";
import { isChromeUserAgent } from "@/tools/request";
import {
  CLIENT_BLOCK_MESSAGE,
  REACHABILITY_MAX_ATTEMPTS,
  checkReachability,
} from "@/utils/reachability";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-probe-ua-"));

const page = (title: string, links = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="The ${title} page of the example site"></head><body><main><h1>${title}</h1><p>Copy for ${title} that is long enough to be a page.</p>${links}</main></body></html>`;

interface Seen {
  path: string;
  userAgent: string;
  reset: boolean;
}
const seen: Seen[] = [];

/**
 * "chrome" resets a request that claims Chrome; "all" resets every connection, whatever it sends;
 * "first" resets only its very first connection (a transient blip) and answers the rest.
 */
function startServer(
  mode: "chrome" | "all" | "first"
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      const connection = connections;
      socket.on("error", () => {});
      let head = "";
      socket.on("data", (chunk) => {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        const path = head.split(" ")[1] ?? "/";
        const userAgent =
          /^user-agent:\s*(.*)$/im.exec(head)?.[1]?.trim() ?? "";
        const reset =
          mode === "all" ||
          (mode === "chrome" && /Chrome\/\d/.test(userAgent)) ||
          (mode === "first" && connection === 1);
        seen.push({ path, userAgent, reset });
        head = "";
        if (reset) {
          // A TCP reset, as a bot filter that drops the connection sends it.
          socket.resetAndDestroy();
          return;
        }
        const body =
          path === "/robots.txt"
            ? "User-agent: *\nAllow: /\n"
            : path === "/" || path === "/about"
              ? page(
                  path === "/" ? "Home" : "About",
                  `<a href="/about">about</a>`
                )
              : "";
        const status = body ? "200 OK" : "404 Not Found";
        const type =
          path === "/robots.txt" ? "text/plain" : "text/html; charset=utf-8";
        socket.end(
          `HTTP/1.1 ${status}\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

/** The AI-crawler access checks send the named crawler's own agent, whatever the crawl's. */
const isAgentCheck = (s: Seen) => /GPTBot|Claude-User/.test(s.userAgent);

const browserFiltering = await startServer("chrome");
const alwaysResetting = await startServer("all");
const blipOnce = await startServer("first");

afterAll(() => {
  browserFiltering.server.close();
  alwaysResetting.server.close();
  blipOnce.server.close();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
});

describe("client hints", () => {
  test("only a Chrome User-Agent claims Chrome's client hints", () => {
    expect(isChromeUserAgent(CHROME_USER_AGENT)).toBe(true);
    expect(isChromeUserAgent(SQUIRRELSCAN_USER_AGENT)).toBe(false);
    expect(
      isChromeUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
      )
    ).toBe(false);
    expect(isChromeUserAgent("ExampleBot/1.0")).toBe(false);
  });
});

describe("the probe", () => {
  test("falls back to the honest UA only after every browser attempt is reset, and reports it", async () => {
    const result = await checkReachability(
      `http://127.0.0.1:${browserFiltering.port}/`,
      {
        fallbackOnReset: true,
      }
    );
    expect(result.reachable).toBe(true);
    expect(result.userAgentFallback).toBe(SQUIRRELSCAN_USER_AGENT);
    // The browser UA keeps its transient retries (a reset can be a blip), and only when all of
    // them were reset does the honest UA get its one attempt.
    expect(
      seen.map((s) => [s.reset, s.userAgent === SQUIRRELSCAN_USER_AGENT])
    ).toEqual([
      ...Array.from({ length: REACHABILITY_MAX_ATTEMPTS }, () => [true, false]),
      [false, true],
    ]);
  }, 30_000);

  // pub#2140 review: one transient reset that a retry clears never changes the crawl's agent.
  test("a single transient reset that a retry clears does not fall back", async () => {
    const result = await checkReachability(
      `http://127.0.0.1:${blipOnce.port}/`,
      {
        fallbackOnReset: true,
      }
    );
    expect(result.reachable).toBe(true);
    expect(result.userAgentFallback).toBeUndefined();
    expect(
      seen.map((s) => [s.reset, s.userAgent === SQUIRRELSCAN_USER_AGENT])
    ).toEqual([
      [true, false],
      [false, false],
    ]);
  }, 30_000);

  test("sends the configured UA and does not fall back", async () => {
    const result = await checkReachability(
      `http://127.0.0.1:${browserFiltering.port}/`,
      {
        userAgent: "ExampleBot/1.0",
        fallbackOnReset: false,
      }
    );
    expect(result.reachable).toBe(true);
    expect(result.userAgentFallback).toBeUndefined();
    expect(seen.map((s) => s.userAgent)).toEqual(["ExampleBot/1.0"]);
  }, 30_000);

  test("names the cause and the fix when the site is still unreachable", async () => {
    const started = Date.now();
    const result = await checkReachability(
      `http://127.0.0.1:${alwaysResetting.port}/`,
      {
        fallbackOnReset: true,
      }
    );
    expect(result.reachable).toBe(false);
    expect(result.error).toBe(CLIENT_BLOCK_MESSAGE);
    expect(result.error).toContain("[crawler] user_agent");
    expect(result.error).not.toContain("—");
    expect(result.error?.toLowerCase()).not.toContain("econnreset");
    // every browser attempt, then the one honest attempt, then it stops.
    expect(seen).toHaveLength(REACHABILITY_MAX_ATTEMPTS + 1);
    // The retries' backoff plus the honest attempt stays well inside the 20 s probe budget.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});

let runs = 0;
async function audit(port: number, toml?: string) {
  const dir = join(scratch, `run-${++runs}`);
  mkdirSync(dir, { recursive: true });
  if (toml) writeFileSync(join(dir, "squirrel.toml"), toml);
  const out = join(dir, "report.json");
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      entry,
      "audit",
      `http://127.0.0.1:${port}/`,
      "--offline",
      "--passive",
      "-m",
      "5",
      "-f",
      "json",
      "-o",
      out,
    ],
    {
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
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let report: { userAgentFallback?: { userAgent: string } } | undefined;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    report = undefined;
  }
  return { code, stdout, stderr, report };
}

describe("the audit", () => {
  test("crawls the whole site as the honest UA, says so once, and the report carries it", async () => {
    const run = await audit(browserFiltering.port);
    expect(run.code).toBe(0);
    expect(
      run.stderr
        .split("\n")
        .filter((l) => l.includes("resets browser-like clients"))
    ).toHaveLength(1);
    expect(run.report?.userAgentFallback).toEqual({
      userAgent: SQUIRRELSCAN_USER_AGENT,
    });
    const answered = seen.filter((s) => !s.reset);
    expect(answered.map((s) => s.path)).toContain("/about");
    // Every reset came before the first answer: once the honest UA answered, the
    // crawl never went back to a browser UA. (The AI-crawler access checks send
    // their own agents on purpose.)
    const firstAnswer = seen.findIndex((s) => !s.reset);
    expect(seen.slice(firstAnswer).some((s) => s.reset)).toBe(false);
    expect(
      answered
        .filter((s) => !isAgentCheck(s))
        .every((s) => s.userAgent === SQUIRRELSCAN_USER_AGENT)
    ).toBe(true);
  }, 120_000);

  test("with [crawler] user_agent set, the probe and the crawl use it and need no fallback", async () => {
    const run = await audit(
      browserFiltering.port,
      '[crawler]\nuser_agent = "ExampleBot/1.0"\n'
    );
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain("resets browser-like clients");
    expect(run.report?.userAgentFallback).toBeUndefined();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.some((s) => s.reset)).toBe(false);
    expect(
      seen
        .filter((s) => !isAgentCheck(s))
        .every((s) => s.userAgent === "ExampleBot/1.0")
    ).toBe(true);
    // The very first request carried the configured UA.
    expect(seen[0]?.userAgent).toBe("ExampleBot/1.0");
  }, 120_000);

  test("a site that resets every client fails with the new wording", async () => {
    const run = await audit(alwaysResetting.port);
    expect(run.code).not.toBe(0);
    expect(run.stdout + run.stderr).toContain(CLIENT_BLOCK_MESSAGE);
  }, 120_000);
});
