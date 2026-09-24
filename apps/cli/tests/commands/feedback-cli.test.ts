// #370: `squirrel feedback` through the real entry point, the way an agent
// runs it: no TTY, the text on a flag or piped, the result read from --json.
// A local stub stands in for the API, so nothing reaches squirrelscan, and
// every run gets a scratch HOME with no update or telemetry.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-feedback-cli-"));

interface Received {
  body: Record<string, unknown>;
  userAgent: string | null;
}
let received: Received[] = [];
let status = 200;

const api = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname !== "/v1/feedback" || req.method !== "POST") {
      return Response.json({}, { status: 404 });
    }
    received.push({
      body: (await req.json()) as Record<string, unknown>,
      userAgent: req.headers.get("user-agent"),
    });
    return Response.json({ success: true }, { status });
  },
});

afterAll(() => {
  void api.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  status = 200;
});

let homes = 0;

/** Nothing inherited that points at the real machine or the real API. */
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    SQUIRREL_API_SERVER: api.url.origin,
    SQUIRREL_NO_UPDATE: "1",
    NO_TELEMETRY: "1",
    NO_COLOR: "1",
  };
}

/**
 * Run `squirrel feedback` in a fresh HOME. `stdin` is piped and closed when a
 * string, left open with `openStdin` written to it (never closed) when that is
 * given, else /dev/null.
 */
async function feedback(
  args: string[],
  stdin?: string,
  { openStdin }: { openStdin?: string } = {}
) {
  const home = join(scratch, `home-${homes++}`);
  const proc = Bun.spawn(
    [process.execPath, "run", entry, "feedback", ...args],
    {
      env: cleanEnv(home),
      stdin:
        openStdin !== undefined
          ? "pipe"
          : stdin === undefined
            ? "ignore"
            : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (openStdin !== undefined && typeof proc.stdin === "object") {
    if (openStdin) proc.stdin.write(openStdin);
    await proc.stdin.flush();
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

describe("squirrel feedback, headless (#370)", () => {
  test("--message with --json: no prompt, one JSON line, exit 0", async () => {
    const r = await feedback([
      "--category",
      "bug_report",
      "-m",
      "The sitemap rule misfires on gzip sitemaps",
      "--email",
      "agent@example.com",
      "--json",
    ]);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      ok: true,
      category: "bug_report",
      truncated: false,
    });
    expect(r.out).not.toContain("Email:");
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({
      email: "agent@example.com",
      feedback: "The sitemap rule misfires on gzip sitemaps",
      category: "bug_report",
      source: "cli",
    });
    expect(received[0]!.userAgent).toStartWith("squirrel/");
  });

  test("piped stdin is the feedback text", async () => {
    const r = await feedback(
      ["--category", "what_worked", "--email", "agent@example.com"],
      "Batch mode was painless\nacross 198 sites\n"
    );

    expect(r.code).toBe(0);
    expect(r.out).toContain("Thank you for your feedback!");
    expect(received[0]!.body.feedback).toBe(
      "Batch mode was painless\nacross 198 sites"
    );
  });

  test("--run-id and --website-id reach the API", async () => {
    const r = await feedback([
      "-m",
      "About this run",
      "--email",
      "agent@example.com",
      "--run-id",
      "run_abc",
      "--website-id",
      "web_xyz",
      "--json",
    ]);

    expect(r.code).toBe(0);
    expect(received[0]!.body.metadata).toMatchObject({
      run_id: "run_abc",
      website_id: "web_xyz",
    });
  });

  test("an API failure exits 1 with ok:false and the fallback URL", async () => {
    status = 500;
    const r = await feedback([
      "-m",
      "This one fails",
      "--email",
      "agent@example.com",
      "--json",
    ]);

    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      code: "submit_failed",
      error: "Failed to submit feedback: the API answered HTTP 500.",
      status: 500,
      fallback_url: "https://squirrelscan.com/feedback",
    });
  });

  test("no text at all: exits 1 without waiting for input", async () => {
    const r = await feedback(["--email", "agent@example.com", "--json"]);

    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      code: "message_required",
    });
    expect(received).toHaveLength(0);
  });

  test("bare words are the text", async () => {
    const r = await feedback([
      "the",
      "sitemap",
      "was",
      "missed",
      "--email",
      "agent@example.com",
      "--json",
    ]);

    expect(r.code).toBe(0);
    expect(received[0]!.body.feedback).toBe("the sitemap was missed");
  });

  test("a pipe far past the cap is cut to 5000 characters and flagged", async () => {
    const r = await feedback(
      ["--email", "agent@example.com", "--json"],
      "x".repeat(200_000)
    );

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, truncated: true });
    expect((received[0]!.body.feedback as string).length).toBe(5000);
  });

  test("an open pipe that never sends anything: gives up after 5s, never hangs", async () => {
    const r = await feedback(
      ["--email", "agent@example.com", "--json"],
      undefined,
      {
        openStdin: "",
      }
    );

    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      code: "message_required",
    });
    expect(received).toHaveLength(0);
  }, 20_000);

  test("an open pipe with text on it: sends the text and exits 0 with the pipe still open", async () => {
    const r = await feedback(
      ["--email", "agent@example.com", "--json"],
      undefined,
      {
        openStdin: "Written by a harness that never closes stdin\n",
      }
    );

    expect(r.code).toBe(0);
    expect(received[0]!.body.feedback).toBe(
      "Written by a harness that never closes stdin"
    );
  }, 20_000);

  test("no email in a fresh HOME: exits 1 naming --email, sends nothing", async () => {
    const r = await feedback(["-m", "Who do I reply to?"]);

    expect(r.code).toBe(1);
    expect(r.err).toContain("Pass --email <address>");
    expect(r.err).toContain("https://squirrelscan.com/feedback");
    expect(received).toHaveLength(0);
  });
});
