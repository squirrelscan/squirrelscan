// #1660: settings.json is written by the foreground command and by the detached auto-updater at the same time. Each write was
// atomic but the read-modify-write was not, so one side could drop the other's keys: a lost `auth` is a silent logout, a lost
// `auto_update_applied` re-prompts. Two real processes write different keys at once; every process's last write must survive.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySettingsPatch, withFileLock } from "../../src/self/settings";

const WRITER = join(import.meta.dir, "helpers", "settings-writer.ts");
const LOGIN = join(import.meta.dir, "helpers", "settings-login.ts");
let home = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "squirrel-race-1660-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

function writer(
  key: string,
  count: number,
  prefix: string
): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(
    [process.execPath, "run", WRITER, key, String(count), prefix],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, "AppData", "Local"),
      },
      stdout: "ignore",
      stderr: "pipe",
    }
  );
  return Promise.all([proc.exited, new Response(proc.stderr).text()]).then(
    ([code, err]) => ({ code, err })
  );
}

describe("concurrent updateSettings from two processes (#1660)", () => {
  test("each process's keys all survive: no lost update", async () => {
    const N = 400;
    const [a, b] = await Promise.all([
      writer("first_publish_at", N, "a"),
      writer("user_feedback_email", N, "b"),
    ]);
    expect([a.code, a.err]).toEqual([0, ""]);
    expect([b.code, b.err]).toEqual([0, ""]);
    const file = join(home, ".squirrel", "settings.json");
    const settings = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    // each side's LAST write is the value on disk: neither was reverted by the other's stale read
    expect(settings.first_publish_at).toBe(`a${N}@example.test`);
    expect(settings.user_feedback_email).toBe(`b${N}@example.test`);
  }, 120_000);
});

describe("a background update cannot remove a login written by the foreground (#1660)", () => {
  test("auth written while the updater is mid-run is on disk when both are done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "squirrel-race-1660-auth-"));
    const env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      LOCALAPPDATA: join(dir, "AppData", "Local"),
    };
    try {
      // The updater: many writes of its own keys.
      const background = Bun.spawn(
        [process.execPath, "run", WRITER, "first_publish_at", "400", "bg"],
        { env, stdout: "ignore", stderr: "pipe" }
      );
      // The foreground login lands in the middle: its own process, with HOME in its environment.
      const login = Bun.spawn([process.execPath, "run", LOGIN, "25"], {
        env,
        stdout: "ignore",
        stderr: "pipe",
      });
      expect([
        await login.exited,
        await new Response(login.stderr).text(),
      ]).toEqual([0, ""]);
      expect(await background.exited).toBe(0);
      const settings = JSON.parse(
        readFileSync(join(dir, ".squirrel", "settings.json"), "utf8")
      ) as { auth?: { token?: string }; first_publish_at?: string };
      expect(settings.auth?.token).toBe("tok");
      expect(settings.first_publish_at).toBe("bg400@example.test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("applySettingsPatch: a writer sets its own keys and leaves the rest (#1660)", () => {
  const table: Array<
    [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ]
  > = [
    [
      "an empty patch changes nothing",
      { a: 1, auth: "x" },
      {},
      { a: 1, auth: "x" },
    ],
    [
      "a patch key is set, every other key is kept",
      { a: 1, auth: "x" },
      { a: 2 },
      { a: 2, auth: "x" },
    ],
    ["a new key is added", { a: 1 }, { b: 2 }, { a: 1, b: 2 }],
    [
      "a null value is a value, not a removal",
      { auth: "x" },
      { auth: null },
      { auth: null },
    ],
    [
      "an undefined value removes the key when written",
      { a: 1, b: 2 },
      { b: undefined },
      { a: 1, b: undefined },
    ],
  ];
  for (const [name, current, patch, expected] of table) {
    test(name, () => {
      expect(applySettingsPatch(current, patch)).toEqual(expected);
    });
  }
  test("the current object is not mutated", () => {
    const current = { a: 1 };
    applySettingsPatch(current, { a: 2 });
    expect(current).toEqual({ a: 1 });
  });
  test("a stale writer's patch cannot revert a key it did not name", () => {
    // the updater read {auth: null}, the login then stored auth; the updater's patch applied to what is there NOW keeps it
    const onDisk = { auth: "token", last_update_check: "old" };
    expect(applySettingsPatch(onDisk, { last_update_check: "new" })).toEqual({
      auth: "token",
      last_update_check: "new",
    });
  });
});

describe("withFileLock (#1660)", () => {
  const lockDir = () => mkdtempSync(join(tmpdir(), "squirrel-lock-1660-"));

  test("runs the function with the lock held and removes it after, also when the function throws", () => {
    const dir = lockDir();
    const lock = join(dir, "settings.json.lock");
    try {
      let heldDuring = false;
      expect(
        withFileLock(lock, () => ((heldDuring = existsSync(lock)), 42))
      ).toBe(42);
      expect([heldDuring, existsSync(lock)]).toEqual([true, false]);
      expect(() =>
        withFileLock(lock, () => {
          throw new Error("boom");
        })
      ).toThrow("boom");
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lock held by a live process makes the second writer wait, and it goes unlocked after the timeout rather than fail", () => {
    const dir = lockDir();
    const lock = join(dir, "settings.json.lock");
    try {
      // held by this very (live) process, fresh
      writeFileSync(
        lock,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
      );
      const started = Date.now();
      const ran = withFileLock(lock, () => "ran", {
        timeoutMs: 120,
        pollMs: 5,
      });
      expect(ran).toBe("ran");
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      // the lock it did not take is not removed by it
      expect(existsSync(lock)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lock left by a dead process is taken over at once", () => {
    const dir = lockDir();
    const lock = join(dir, "settings.json.lock");
    try {
      writeFileSync(
        lock,
        JSON.stringify({ pid: 2_147_483_646, at: new Date().toISOString() })
      );
      const started = Date.now();
      expect(withFileLock(lock, () => "ran", { timeoutMs: 5_000 })).toBe("ran");
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lock older than the stale bound is taken over even if its pid looks alive", () => {
    const dir = lockDir();
    const lock = join(dir, "settings.json.lock");
    try {
      writeFileSync(
        lock,
        JSON.stringify({ pid: process.pid, at: "2020-01-01T00:00:00.000Z" })
      );
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      expect(
        withFileLock(lock, () => "ran", { timeoutMs: 5_000, staleMs: 10_000 })
      ).toBe("ran");
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unremovable stale lock does not hang the writer past its timeout", () => {
    const dir = lockDir();
    const lock = join(dir, "settings.json.lock");
    try {
      // A non-empty directory in the lock's place: it exists (EEXIST), reads as old, and unlink on it fails.
      mkdirSync(lock);
      writeFileSync(join(lock, "keep"), "x");
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const started = Date.now();
      const ran = withFileLock(lock, () => "ran", {
        timeoutMs: 300,
        staleMs: 10_000,
      });
      expect(ran).toBe("ran");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("waiters racing to take over one stale lock never hold it together", async () => {
    const dir = lockDir();
    const worker = join(import.meta.dir, "helpers", "lock-worker.ts");
    try {
      // 15 independent races (each its own lock, guard and violations files in its own
      // subdirectory) run side by side instead of one after another: the same 4 waiters
      // per stale lock, the same assertions per round, without paying the start barrier
      // fifteen times in a row.
      const startAt = Date.now() + 1_500;
      await Promise.all(
        Array.from({ length: 15 }, async (_, round) => {
          const roundDir = join(dir, `round-${round}`);
          mkdirSync(roundDir, { recursive: true });
          const lock = join(roundDir, "settings.json.lock");
          const guard = join(roundDir, "inside");
          const violations = join(roundDir, "violations");
          writeFileSync(
            lock,
            JSON.stringify({ pid: 2_147_483_646, at: new Date().toISOString() })
          );
          const procs = Array.from({ length: 4 }, () =>
            Bun.spawn(
              [
                process.execPath,
                "run",
                worker,
                lock,
                guard,
                violations,
                String(startAt),
              ],
              { stdout: "ignore", stderr: "ignore" }
            )
          );
          const codes = await Promise.all(procs.map((proc) => proc.exited));
          expect(codes).toEqual([0, 0, 0, 0]);
          expect(existsSync(violations)).toBe(false);
        })
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
