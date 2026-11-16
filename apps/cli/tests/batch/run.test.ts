// The batch orchestrator (#1231), driven with a fake child so no audit runs. Synthetic URLs only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeChildRecord } from "../../src/batch/child-record";
import { parseManifest, latestRecords } from "../../src/batch/manifest";
import {
  type ChildResult,
  type SpawnChild,
  cleanError,
  executeBatch,
  passthroughArgs,
  statusFromExit,
} from "../../src/batch/run";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "batch-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const urlsFile = (urls: string[]): string => {
  const p = join(dir, "urls.txt");
  writeFileSync(p, `${urls.join("\n")}\n`);
  return p;
};
const out = (): string => join(dir, "out");
const records = () =>
  parseManifest(readFileSync(join(out(), "results.jsonl"), "utf8")).records;

interface Plan {
  exit?: number;
  status?: "completed" | "partial" | "failed" | "blocked";
  delayMs?: number;
  hang?: boolean;
  signal?: string;
  stderr?: string;
}

const newStats = () => ({ active: 0, peak: 0, starts: [] as string[] });

/** A fake child: reads `-o` and `--batch-record` from its arguments, like the real audit does. */
function fakeSpawn(
  plans: (url: string) => Plan,
  stats: { active: number; peak: number; starts: string[] } = newStats()
): { spawn: SpawnChild; stats: typeof stats } {
  const spawn: SpawnChild = ({ args }) => {
    const url = args[1]!;
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    const plan = plans(url);
    stats.starts.push(url);
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    let stop!: (r: ChildResult) => void;
    const result = new Promise<ChildResult>((resolve) => {
      stop = resolve;
    });
    const timer = plan.hang
      ? undefined
      : setTimeout(() => {
          if (plan.signal === undefined) {
            if (plan.status)
              writeChildRecord(value("--batch-record"), {
                status: plan.status,
                score: 88,
                pages: 3,
                finalUrl: url,
              });
            writeFileSync(value("-o"), '{"ok":true}');
          }
          stats.active--;
          stop({
            exitCode: plan.signal ? null : (plan.exit ?? 0),
            signal: plan.signal ?? null,
            stderrTail: plan.stderr ?? "",
          });
        }, plan.delayMs ?? 5);
    const end = (signal: string) => {
      if (timer) clearTimeout(timer);
      stats.active--;
      stop({ exitCode: null, signal, stderrTail: "" });
    };
    return {
      result,
      terminate: () => end("SIGTERM"),
      kill: () => end("SIGKILL"),
    };
  };
  return { spawn, stats };
}

const run = (
  urls: string[],
  spawn: SpawnChild,
  extra: Partial<Parameters<typeof executeBatch>[0]> = {}
) =>
  executeBatch({
    urlsFile: urlsFile(urls),
    outDir: out(),
    spawn,
    log: () => {},
    ...extra,
  });

describe("executeBatch", () => {
  test("audits every URL, one report each, a record each, exit 0", async () => {
    const { spawn } = fakeSpawn(() => ({ status: "completed" }));
    const code = await run(["https://a.com", "https://b.com"], spawn);
    expect(code).toBe(0);
    const latest = [...latestRecords(records()).values()];
    expect(latest.map((r) => r.status)).toEqual(["completed", "completed"]);
    for (const r of latest) {
      expect(r.report).toMatch(/^[0-9a-f]{16}\.json$/);
      expect(existsSync(join(out(), r.report!))).toBe(true);
      expect(r.score).toBe(88);
      expect(r.pages).toBe(3);
    }
    expect(readdirSync(out()).filter((f) => f.startsWith("."))).toEqual([]);
  });

  test("a failing URL is recorded with its reason, does not stop the batch, exit 6", async () => {
    const { spawn, stats } = fakeSpawn((u) =>
      u.includes("bad")
        ? { exit: 5, stderr: "Error: dns\nCould not resolve bad.com\n" }
        : { status: "completed" }
    );
    const code = await run(["https://bad.com", "https://good.com"], spawn);
    expect(code).toBe(6);
    expect(stats.starts).toHaveLength(2);
    const byUrl = new Map(records().map((r) => [r.url, r]));
    const bad = [...byUrl.values()]
      .filter((r) => r.url.includes("bad"))
      .at(-1)!;
    expect(bad.status).toBe("unreachable");
    expect(bad.exitCode).toBe(5);
    expect(bad.error).toBe("Could not resolve bad.com");
  });

  test("a re-run does not redo completed URLs; --retry-failed re-runs failures with attempt 2", async () => {
    const first = fakeSpawn((u) =>
      u.includes("bad") ? { exit: 1 } : { status: "completed" }
    );
    const urls = ["https://ok.com", "https://bad.com"];
    expect(await run(urls, first.spawn)).toBe(6);
    const second = fakeSpawn(() => ({ status: "completed" }));
    expect(await run(urls, second.spawn)).toBe(6); // the failure stands
    expect(second.stats.starts).toEqual([]);
    const third = fakeSpawn(() => ({ status: "completed" }));
    expect(await run(urls, third.spawn, { retryFailed: true })).toBe(0);
    expect(third.stats.starts).toEqual(["https://bad.com/"]);
    const bad = latestRecords(records()).get(
      records().find((r) => r.url.includes("bad"))!.key
    )!;
    expect(bad.attempt).toBe(2);
    expect(bad.status).toBe("completed");
  });

  test("interrupting the batch then re-running finishes only what is left", async () => {
    const controller = new AbortController();
    const urls = ["https://a.com", "https://b.com", "https://c.com"];
    const first = fakeSpawn((u) =>
      u.includes("b.") ? { hang: true } : { status: "completed", delayMs: 1 }
    );
    const pending = run(urls, first.spawn, {
      concurrency: 1,
      stopSignal: controller.signal,
    });
    await Bun.sleep(150);
    controller.abort();
    expect(await pending).toBe(130);
    const second = fakeSpawn(() => ({ status: "completed" }));
    expect(await run(urls, second.spawn, { retryFailed: true })).toBe(0);
    expect(second.stats.starts.sort()).toEqual([
      "https://b.com/",
      "https://c.com/",
    ]);
  });

  test("a stale running record (a killed orchestrator) reads as crashed and is retried on request", async () => {
    const urls = ["https://a.com"];
    const ok = fakeSpawn(() => ({ status: "completed" }));
    await run(urls, ok.spawn);
    const first = records()[0]!;
    writeFileSync(
      join(out(), "results.jsonl"),
      `${JSON.stringify({ v: 1, url: first.url, key: first.key, status: "running", attempt: 1 })}\n{"v":1,"url":"cut`
    );
    const again = fakeSpawn(() => ({ status: "completed" }));
    expect(await run(urls, again.spawn)).toBe(6);
    expect(again.stats.starts).toEqual([]);
    expect(await run(urls, again.spawn, { retryFailed: true })).toBe(0);
  });

  test("never more than --concurrency children at once, and two URLs of one project never overlap", async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://site${i}.com`);
    const { spawn, stats } = fakeSpawn(() => ({
      status: "completed",
      delayMs: 20,
    }));
    await run(urls, spawn, { concurrency: 3 });
    expect(stats.peak).toBe(3);

    rmSync(out(), { recursive: true, force: true });
    const same = fakeSpawn(() => ({ status: "completed", delayMs: 20 }));
    await run(
      ["https://same.com/a", "https://same.com/b", "https://same.com/c"],
      same.spawn,
      { concurrency: 3 }
    );
    expect(same.stats.peak).toBe(1);
    expect(same.stats.starts).toHaveLength(3);
  });

  test("a child past --url-timeout is killed and recorded as timeout", async () => {
    const { spawn } = fakeSpawn(() => ({ hang: true }));
    const code = await run(["https://slow.com"], spawn, {
      urlTimeoutSeconds: 0.05,
    });
    expect(code).toBe(6);
    const last = records().at(-1)!;
    expect(last.status).toBe("timeout");
    expect(last.reason).toBe("url_timeout");
  });

  test("a child killed by a signal with no record is crashed", async () => {
    const { spawn } = fakeSpawn(() => ({ signal: "SIGKILL" }));
    expect(await run(["https://oom.com"], spawn)).toBe(6);
    const last = records().at(-1)!;
    expect(last.status).toBe("crashed");
    expect(last.reason).toBe("signal_SIGKILL");
    expect(last.exitCode).toBeUndefined();
  });

  test("exit 2 only when --fail-on tripped and nothing failed; 6 outranks 2", async () => {
    const gate = fakeSpawn(() => ({ exit: 2, status: "completed" }));
    expect(await run(["https://a.com"], gate.spawn)).toBe(2);
    rmSync(out(), { recursive: true, force: true });
    const mixed = fakeSpawn((u) =>
      u.includes("a.") ? { exit: 2, status: "completed" } : { exit: 3 }
    );
    expect(await run(["https://a.com", "https://b.com"], mixed.spawn)).toBe(6);
    expect(latestRecords(records()).size).toBe(2);
  });

  test("partial counts as success; rejected lines get a record and make the batch exit 6", async () => {
    const { spawn, stats } = fakeSpawn(() => ({ status: "partial" }));
    const code = await run(
      ["https://a.com", "ftp://files.com/x", "http://user:pw@c.com"],
      spawn
    );
    expect(code).toBe(6);
    expect(stats.starts).toHaveLength(1);
    const rejected = records().filter((r) => r.status === "rejected");
    expect(rejected.map((r) => r.reason).sort()).toEqual([
      "not-http",
      "userinfo",
    ]);
    expect(JSON.stringify(rejected)).not.toContain("pw");
    // The refusal is not recorded again on a re-run.
    await run(
      ["https://a.com", "ftp://files.com/x", "http://user:pw@c.com"],
      spawn
    );
    expect(records().filter((r) => r.status === "rejected")).toHaveLength(2);
  });

  test("private hosts are rejected unless allowed", async () => {
    const { spawn, stats } = fakeSpawn(() => ({ status: "completed" }));
    expect(await run(["http://127.0.0.1:3000"], spawn)).toBe(6);
    expect(stats.starts).toEqual([]);
    rmSync(out(), { recursive: true, force: true });
    expect(
      await run(["http://127.0.0.1:3000"], spawn, { allowPrivateHosts: true })
    ).toBe(0);
  });

  test("a live lock from another batch stops the run (exit 1); a stale one is taken over", async () => {
    const { spawn } = fakeSpawn(() => ({ status: "completed" }));
    const messages: string[] = [];
    await run(["https://a.com"], spawn); // creates out/
    const host = (await import("node:os")).hostname();
    writeFileSync(
      join(out(), ".batch.lock"),
      JSON.stringify({ pid: process.pid, host })
    );
    expect(
      await run(["https://a.com"], spawn, { log: (l) => messages.push(l) })
    ).toBe(1);
    expect(messages.join("\n")).toContain("another batch is running");
    writeFileSync(
      join(out(), ".batch.lock"),
      JSON.stringify({ pid: 2 ** 22 - 3, host })
    );
    expect(await run(["https://a.com"], spawn)).toBe(0);
    expect(existsSync(join(out(), ".batch.lock"))).toBe(false);
  });

  test("--restart moves the old results aside and audits everything again", async () => {
    const first = fakeSpawn(() => ({ status: "completed" }));
    await run(["https://a.com"], first.spawn);
    const second = fakeSpawn(() => ({ status: "completed" }));
    await run(["https://a.com"], second.spawn, { restart: true });
    expect(second.stats.starts).toHaveLength(1);
    expect(
      readdirSync(out()).filter((f) => /^results\..+\.jsonl$/.test(f))
    ).toHaveLength(1);
  });

  test("an unreadable or oversized urls file is exit 1 before anything runs", async () => {
    const { spawn, stats } = fakeSpawn(() => ({}));
    const code = await executeBatch({
      urlsFile: join(dir, "missing.txt"),
      outDir: out(),
      spawn,
      log: () => {},
    });
    expect(code).toBe(1);
    expect(
      await run(["https://a.com", "https://b.com"], spawn, {
        maxUrls: 1,
      })
    ).toBe(1);
    expect(stats.starts).toEqual([]);
  });

  test("reads the urls from stdin for -", async () => {
    const { spawn, stats } = fakeSpawn(() => ({ status: "completed" }));
    const code = await executeBatch({
      urlsFile: "-",
      outDir: out(),
      spawn,
      log: () => {},
      readStdin: async () => "https://a.com\n# note\n\n",
    });
    expect(code).toBe(0);
    expect(stats.starts).toHaveLength(1);
  });
});

describe("helpers", () => {
  test("passthroughArgs drops the batch and output flags and keeps the rest", () => {
    expect(
      passthroughArgs([
        "--urls-file",
        "u.txt",
        "--out-dir=o",
        "--concurrency",
        "4",
        "-f",
        "json",
        "--max-pages",
        "10",
        "--offline",
        "--retry-failed",
        "-C",
        "quick",
        "--allow-private-hosts",
      ])
    ).toEqual(["--max-pages", "10", "--offline", "-C", "quick"]);
  });

  test("statusFromExit follows the audit exit codes", () => {
    expect(statusFromExit(5, undefined).status).toBe("unreachable");
    expect(statusFromExit(4, undefined).status).toBe("redirected");
    expect(statusFromExit(3, { status: "failed" }).status).toBe("blocked");
    expect(
      statusFromExit(0, { status: "partial", reason: "max_duration" })
    ).toEqual({ status: "partial", reason: "max_duration" });
    expect(statusFromExit(1, undefined).status).toBe("failed");
    expect(statusFromExit(0, undefined).status).toBe("completed");
  });

  test("cleanError keeps the last line, strips control characters and clamps", () => {
    expect(cleanError("a\n\u001b[31mboom\u0007\n")).toBe("[31mboom");
    expect(cleanError("x".repeat(500)).length).toBe(300);
  });
});
