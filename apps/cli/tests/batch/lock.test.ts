// The batch lock (#1231): O_EXCL create, atomic stale takeover by rename, release only while the file is ours.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLock } from "../../src/batch/run";

const DEAD_PID = 2 ** 22 - 3;
const notDead = (pid: number) => pid !== DEAD_PID;

let dir: string;
let lockPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "batch-lock-"));
  lockPath = join(dir, ".batch.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const holder = () => JSON.parse(readFileSync(lockPath, "utf8"));

describe("batch lock", () => {
  test("a fresh acquire creates the lock with our pid and a nonce; release removes it", () => {
    const release = acquireLock(dir);
    expect(typeof release).toBe("function");
    expect(holder().pid).toBe(process.pid);
    expect(holder().host).toBe(hostname());
    expect(typeof holder().nonce).toBe("string");
    (release as () => void)();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a live lock is refused with the existing message and left alone", () => {
    const live = JSON.stringify({ pid: process.pid, host: hostname() });
    writeFileSync(lockPath, live);
    const res = acquireLock(dir);
    expect(res).toBe(
      `another batch is running on ${dir} (pid ${process.pid} on ${hostname()}); lock file ${lockPath}`
    );
    expect(readFileSync(lockPath, "utf8")).toBe(live);
  });

  test("a second acquire in the same process is refused while the first holds", () => {
    const first = acquireLock(dir, notDead);
    expect(typeof first).toBe("function");
    expect(acquireLock(dir, notDead)).toContain("another batch is running");
    (first as () => void)();
  });

  test("a lock from another host is never treated as stale", () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: "elsewhere" })
    );
    expect(acquireLock(dir, notDead)).toContain("another batch is running");
  });

  test("an unreadable lock is refused", () => {
    writeFileSync(lockPath, "not json");
    expect(acquireLock(dir)).toBe(
      `another batch holds ${lockPath} (unreadable lock); delete it if no batch is running`
    );
    expect(readFileSync(lockPath, "utf8")).toBe("not json");
  });

  test("a stale lock is taken over atomically and leaves no temp files", () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: hostname() })
    );
    const release = acquireLock(dir, notDead);
    expect(typeof release).toBe("function");
    expect(holder().pid).toBe(process.pid);
    expect(readdirSync(dir)).toEqual([".batch.lock"]);
    (release as () => void)();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a stale lock whose takeover is already claimed is refused and left alone", () => {
    const stale = JSON.stringify({ pid: DEAD_PID, host: hostname() });
    writeFileSync(lockPath, stale);
    const claim = `${lockPath}.takeover-${new Bun.CryptoHasher("sha256").update(stale).digest("hex").slice(0, 16)}`;
    writeFileSync(claim, "{}");
    expect(acquireLock(dir, notDead)).toBe(
      `another batch is taking over the stale lock ${lockPath}; delete ${claim} if no batch is running`
    );
    expect(readFileSync(lockPath, "utf8")).toBe(stale);
  });

  test("release does not delete a lock someone else now holds", () => {
    const release = acquireLock(dir) as () => void;
    const other = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      nonce: "theirs",
    });
    writeFileSync(lockPath, other);
    release();
    expect(readFileSync(lockPath, "utf8")).toBe(other);
  });

  test("racers on a stale lock: exactly one wins", async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, host: hostname() })
    );
    const racer = join(
      import.meta.dir,
      "..",
      "fixtures",
      "batch-lock-racer.ts"
    );
    const startAt = String(Date.now() + 1500);
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn([process.execPath, racer, dir, startAt, String(DEAD_PID)], {
        stdout: "pipe",
        stderr: "inherit",
      })
    );
    const outputs = await Promise.all(
      procs.map(async (p) => {
        const text = await new Response(p.stdout).text();
        await p.exited;
        return text.trim();
      })
    );
    expect(outputs.filter((o) => o === "won")).toHaveLength(1);
    expect(outputs.filter((o) => o.startsWith("lost "))).toHaveLength(7);
    expect(readdirSync(dir)).toEqual([]);
  }, 30_000);
});
