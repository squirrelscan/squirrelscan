// A stale `markLoginRejected` must not undo a login that landed meanwhile (#1666 on top of #1660).
//
// Two real processes, each with its own HOME in its env (never this process's HOME): process A holds the
// settings lock and, still inside it, replaces `auth` with a NEW login; process B was started while A held the
// lock, read the OLD login, and so waits for the lock. When B gets it, the file holds the new login, and the
// compare made under the lock must leave it alone. Before the compare moved under the lock, B wrote
// `{ ...old auth, rejectedAt }` over the new login.

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = join(import.meta.dir, "../../src");
const scratch = mkdtempSync(join(tmpdir(), "squirrel-1666-race-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const login = (token: string) => ({
  token,
  userId: "u1",
  email: "you@example.com",
  name: null,
  expiresAt: FUTURE,
});

// A: take the lock, say so, hold it for a while, then write the new login before releasing.
const HOLDER = (ready: string) => `
import { updateSettingsWith } from ${JSON.stringify(join(src, "self/settings.ts"))};
import { writeFileSync } from "node:fs";
updateSettingsWith(() => {
  writeFileSync(${JSON.stringify(ready)}, "locked");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  return { auth: { token: "sqcli_new", userId: "u1", email: "you@example.com", name: null, expiresAt: ${JSON.stringify(FUTURE)} } };
});
`;

// B: the stale 401 handler, for the old token, on the production API.
const MARKER = (token: string) => `
import { markLoginRejected } from ${JSON.stringify(join(src, "self/credentials.ts"))};
markLoginRejected(${JSON.stringify(token)});
`;

function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SQUIRREL|HOME|XDG_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, HOME: home, SQUIRREL_NO_UPDATE: "1", NO_TELEMETRY: "1" };
}

function spawnScript(file: string, source: string, home: string) {
  writeFileSync(file, source);
  return Bun.spawn([process.execPath, "run", file], {
    env: childEnv(home),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function settingsOf(home: string): {
  auth?: { token: string; rejectedAt?: string };
} {
  return JSON.parse(
    readFileSync(join(home, ".squirrel", "settings.json"), "utf8")
  );
}

function freshHome(name: string): string {
  const home = join(scratch, name);
  mkdirSync(join(home, ".squirrel"), { recursive: true });
  writeFileSync(
    join(home, ".squirrel", "settings.json"),
    JSON.stringify({ auth: login("sqcli_old") }),
    { mode: 0o600 }
  );
  return home;
}

describe("a stale markLoginRejected", () => {
  test("does not clobber a login that landed while it waited for the lock", async () => {
    const home = freshHome("race");
    const ready = join(scratch, "race-ready");
    const a = spawnScript(join(scratch, "holder.ts"), HOLDER(ready), home);
    for (let i = 0; i < 400 && !existsSync(ready); i++) await Bun.sleep(25);
    expect(existsSync(ready)).toBe(true);

    // The lock is held and `auth` is still the old login, so B's first read sees it.
    expect(settingsOf(home).auth?.token).toBe("sqcli_old");
    const b = spawnScript(
      join(scratch, "marker.ts"),
      MARKER("sqcli_old"),
      home
    );
    await Promise.all([a.exited, b.exited]);

    const after = settingsOf(home);
    expect(after.auth?.token).toBe("sqcli_new");
    expect(after.auth?.rejectedAt).toBeUndefined();
  }, 60_000);

  test("control: with nothing in between, the rejected login is stamped", async () => {
    const home = freshHome("control");
    const b = spawnScript(
      join(scratch, "marker2.ts"),
      MARKER("sqcli_old"),
      home
    );
    await b.exited;
    const after = settingsOf(home);
    expect(after.auth?.token).toBe("sqcli_old");
    expect(Date.parse(after.auth?.rejectedAt ?? "")).not.toBeNaN();
  }, 60_000);
});
