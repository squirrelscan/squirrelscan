// A login the server rejects is remembered (#1666), end to end with the real CLI in a subprocess
// (HOME and SQUIRREL_API_SERVER are in the child's env, never changed in this process).
//
// The local API answers 401 to everything. Because it is NOT the production API, asking it must never
// stamp the stored login rejected: a local or dev server's 401 says nothing about the production
// login. The stamp itself is read here from settings written ahead of time, and written by the unit
// tests (credential-state-1666.test.ts) against the production host.

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
const scratch = mkdtempSync(join(tmpdir(), "squirrel-1666-"));
const home = join(scratch, "home");
const settingsPath = join(home, ".squirrel", "settings.json");

let hits = 0;
const api = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    hits++;
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  },
});
afterAll(() => {
  void api.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

const HOUR = 3_600_000;

function writeLogin(
  opts: { expiresInMs?: number; rejectedAgoMs?: number } = {}
): void {
  mkdirSync(join(home, ".squirrel"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      auth: {
        token: "sqcli_test_token",
        userId: "u1",
        email: "you@example.com",
        name: null,
        expiresAt: new Date(
          Date.now() + (opts.expiresInMs ?? 24 * HOUR)
        ).toISOString(),
        ...(opts.rejectedAgoMs !== undefined
          ? {
              rejectedAt: new Date(
                Date.now() - opts.rejectedAgoMs
              ).toISOString(),
            }
          : {}),
      },
    }),
    { mode: 0o600 }
  );
}

async function squirrel(...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|FORCE_COLOR|NO_COLOR|COLORTERM)/.test(k))
      continue;
    env[k] = v;
  }
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
    env: {
      ...env,
      HOME: home,
      SQUIRREL_NO_UPDATE: "1",
      SQUIRREL_API_SERVER: api.url.origin.replace(/\/$/, ""),
      NO_TELEMETRY: "1",
      NO_COLOR: "1",
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

describe("a 401 from an overridden API host", () => {
  test("is asked every time and never stamps the production login", async () => {
    writeLogin();
    const before = hits;
    const first = await squirrel("auth", "status");
    expect(first.code).toBe(1);
    expect(hits).toBe(before + 1);
    expect(
      JSON.parse(readFileSync(settingsPath, "utf8")).auth.rejectedAt
    ).toBeUndefined();

    const second = await squirrel("auth", "status");
    expect(second.code).toBe(1);
    expect(hits).toBe(before + 2);
  }, 60_000);
});

describe("a login remembered as rejected", () => {
  test("auth status reports it, with no request", async () => {
    writeLogin({ rejectedAgoMs: HOUR });
    const before = hits;
    const status = await squirrel("auth", "status", "--json");
    expect(JSON.parse(status.out)).toEqual({
      authenticated: false,
      credentialState: "rejected",
    });
    expect(hits).toBe(before);
  }, 60_000);

  test("another command says it once on stderr and sends no request", async () => {
    writeLogin({ rejectedAgoMs: HOUR });
    const before = hits;
    const r = await squirrel("config", "path");
    const notes = r.err
      .split("\n")
      .filter((l) => l.includes("rejected your squirrelscan login"));
    expect(notes).toHaveLength(1);
    expect(r.err).toContain("squirrel auth login");
    expect(hits).toBe(before);
  }, 60_000);

  test("after a day it is tried once more", async () => {
    writeLogin({ rejectedAgoMs: 25 * HOUR });
    const before = hits;
    const r = await squirrel("auth", "status");
    expect(r.err).not.toContain("rejected your squirrelscan login");
    expect(hits).toBe(before + 1);
  }, 60_000);

  test("a new login has no stamp, so it is used", async () => {
    writeLogin();
    const before = hits;
    await squirrel("auth", "status");
    expect(hits).toBe(before + 1);
  }, 60_000);
});

describe("an expired login", () => {
  test("is reported as expired by auth status, with no request, and once on stderr elsewhere", async () => {
    writeLogin({ expiresInMs: -24 * HOUR });
    const before = hits;
    const status = await squirrel("auth", "status", "--json");
    expect(JSON.parse(status.out)).toEqual({
      authenticated: false,
      credentialState: "expired",
    });
    const other = await squirrel("config", "path");
    expect(
      other.err.split("\n").filter((l) => l.includes("login has expired"))
    ).toHaveLength(1);
    expect(hits).toBe(before);
  }, 60_000);

  test("a login with an unreadable expiry is read as expired too", async () => {
    mkdirSync(join(home, ".squirrel"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        auth: {
          token: "sqcli_test_token",
          userId: "u1",
          email: "you@example.com",
          name: null,
          expiresAt: "not a date",
        },
      }),
      { mode: 0o600 }
    );
    const status = await squirrel("auth", "status", "--json");
    expect(JSON.parse(status.out)).toEqual({
      authenticated: false,
      credentialState: "expired",
    });
  }, 60_000);
});
