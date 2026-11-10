// A login the server rejects is remembered (#1666), end to end with the real CLI in a subprocess
// against a local API that answers 401: the first `auth status` asks the server and is told no, the
// next command reports the login as rejected WITHOUT another request, and says it once on stderr.

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

function writeLogin(expiresAt: string): void {
  mkdirSync(join(home, ".squirrel"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      auth: {
        token: "sqcli_test_token",
        userId: "u1",
        email: "you@example.com",
        name: null,
        expiresAt,
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

describe("a login the server rejects", () => {
  test("the first command asks and is rejected; the next one says so without another request", async () => {
    writeLogin(new Date(Date.now() + 86_400_000).toISOString());

    const first = await squirrel("auth", "status");
    expect(first.code).toBe(1);
    expect(hits).toBe(1);
    expect(
      JSON.parse(readFileSync(settingsPath, "utf8")).auth.rejectedAt
    ).toBeTruthy();

    const before = hits;
    const second = await squirrel("auth", "status", "--json");
    expect(JSON.parse(second.out)).toEqual({
      authenticated: false,
      credentialState: "rejected",
    });
    expect(hits).toBe(before);
  }, 60_000);

  test("another command says it once on stderr and sends no request", async () => {
    const before = hits;
    const r = await squirrel("config", "path");
    const notes = r.err
      .split("\n")
      .filter((l) => l.includes("rejected your squirrelscan login"));
    expect(notes).toHaveLength(1);
    expect(r.err).toContain("squirrel auth login");
    expect(hits).toBe(before);
  }, 60_000);

  test("signing in again clears it: a fresh login has no rejection", async () => {
    writeLogin(new Date(Date.now() + 86_400_000).toISOString());
    const r = await squirrel("auth", "status", "--json");
    // The server still says 401, so it is asked once more and rejected again, which proves the
    // rejection was not carried over by the new login.
    expect(r.code).toBe(1);
  }, 60_000);
});

describe("an expired login", () => {
  test("is reported as expired by auth status, with no request, and once on stderr elsewhere", async () => {
    writeLogin(new Date(Date.now() - 86_400_000).toISOString());
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
});
