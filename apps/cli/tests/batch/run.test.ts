// The batch runner (repo#2214): fake children, a temp directory, no network.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childArgv } from "../../src/batch/command";
import { parseManifest } from "../../src/batch/manifest";
import { runBatch, type ChildResult } from "../../src/batch/run";
import { parseUrlsFile } from "../../src/batch/urls-file";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "batch-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const list = (text: string) => {
  const r = parseUrlsFile(text);
  if (!r.ok) throw new Error("refused");
  return r;
};

/** A child that writes a JSON report whose score depends on the host. */
const fakeChild =
  (calls: string[], fail: Set<string> = new Set()) =>
  async (url: string, file: string): Promise<ChildResult> => {
    calls.push(url);
    if (fail.has(url)) return { exitCode: 5, timedOut: false };
    writeFileSync(
      file,
      JSON.stringify({
        status: "completed",
        score: { overall: 80, groups: [{ group: "seo", score: 70 }] },
        meta: { totalPages: 3 },
      })
    );
    return { exitCode: 0, timedOut: false };
  };

const base = (outDir: string, parsed: ReturnType<typeof list>) => ({
  urls: parsed.urls,
  rejected: parsed.rejected,
  outDir,
  skipExisting: true,
  retryFailed: false,
  concurrency: 1,
  delayMs: 0,
  log: () => {},
  sleep: async () => {},
});

describe("runBatch", () => {
  test("audits each URL, writes one report per target and a summary", async () => {
    const out = tmp();
    const parsed = list(
      "https://a.example.com/\nhttps://b.example.com/\nftp://bad.example.com/\n"
    );
    const calls: string[] = [];
    const lines: string[] = [];
    const s = await runBatch({
      ...base(out, parsed),
      runChild: fakeChild(calls),
      log: (l) => lines.push(l),
    });
    expect(calls).toEqual(["https://a.example.com/", "https://b.example.com/"]);
    for (const u of parsed.urls)
      expect(
        JSON.parse(readFileSync(join(out, "reports", `${u.key}.json`), "utf8"))
          .status
      ).toBe("completed");
    expect(s.counts.completed).toBe(2);
    expect(s.counts.rejected).toBe(1);
    expect(s.averageScore).toBe(80);
    expect(s.exitCode).toBe(0);
    expect(lines.some((l) => l.includes("Batch summary"))).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.includes("a.example") && l.includes("score 80 (seo 70), 3 pages")
      )
    ).toBe(true);
  });

  test("--skip-existing skips completed targets on a re-run", async () => {
    const out = tmp();
    const parsed = list("https://a.example.com/\nhttps://b.example.com/\n");
    await runBatch({ ...base(out, parsed), runChild: fakeChild([]) });
    const calls: string[] = [];
    const s = await runBatch({
      ...base(out, parsed),
      runChild: fakeChild(calls),
    });
    expect(calls).toEqual([]);
    expect(s.skipped).toBe(2);
    expect(s.counts.completed).toBe(2);
  });

  test("without --skip-existing everything runs again as the next attempt", async () => {
    const out = tmp();
    const parsed = list("https://a.example.com/\n");
    await runBatch({ ...base(out, parsed), runChild: fakeChild([]) });
    const calls: string[] = [];
    await runBatch({
      ...base(out, parsed),
      skipExisting: false,
      runChild: fakeChild(calls),
    });
    expect(calls.length).toBe(1);
    const recs = parseManifest(
      readFileSync(join(out, "results.jsonl"), "utf8")
    ).records;
    expect(Math.max(...recs.map((r) => r.attempt))).toBe(2);
  });

  test("failures exit 6, are kept on resume and retried with --retry-failed", async () => {
    const out = tmp();
    const parsed = list("https://a.example.com/\nhttps://down.example.com/\n");
    const fail = new Set(["https://down.example.com/"]);
    const first = await runBatch({
      ...base(out, parsed),
      runChild: fakeChild([], fail),
    });
    expect(first.exitCode).toBe(6);
    expect(first.counts.unreachable).toBe(1);
    const calls: string[] = [];
    const kept = await runBatch({
      ...base(out, parsed),
      runChild: fakeChild(calls),
    });
    expect(calls).toEqual([]);
    expect(kept.exitCode).toBe(6);
    const retry = await runBatch({
      ...base(out, parsed),
      retryFailed: true,
      runChild: fakeChild(calls),
    });
    expect(calls).toEqual(["https://down.example.com/"]);
    expect(retry.exitCode).toBe(0);
  });

  test("a timeout is recorded as timeout and a signal death as crashed", async () => {
    const out = tmp();
    const parsed = list("https://a.example.com/\nhttps://b.example.com/\n");
    const s = await runBatch({
      ...base(out, parsed),
      runChild: async (url) =>
        url.includes("//a.")
          ? { exitCode: null, timedOut: true }
          : { exitCode: null, timedOut: false },
    });
    expect(s.counts.timeout).toBe(1);
    expect(s.counts.crashed).toBe(1);
  });

  test("a manifest cut mid-line is terminated before the next record", async () => {
    const out = tmp();
    const parsed = list("https://a.example.com/\n");
    await runBatch({
      ...base(out, parsed),
      skipExisting: false,
      runChild: fakeChild([]),
    });
    const file = join(out, "results.jsonl");
    writeFileSync(file, readFileSync(file, "utf8") + '{"v":1,"url":"htt');
    await runBatch({
      ...base(out, parsed),
      skipExisting: false,
      runChild: fakeChild([]),
    });
    const parsedManifest = parseManifest(readFileSync(file, "utf8"));
    expect(parsedManifest.skipped).toBe(1);
    expect(parsedManifest.records.at(-1)?.status).toBe("completed");
  });

  test("concurrency runs every URL once", async () => {
    const out = tmp();
    const parsed = list(
      "https://a.example.com/\nhttps://b.example.com/\nhttps://c.example.com/\n"
    );
    const calls: string[] = [];
    await runBatch({
      ...base(out, parsed),
      concurrency: 2,
      runChild: fakeChild(calls),
    });
    expect(calls.sort()).toEqual(parsed.urls.map((u) => u.url).sort());
  });
});

describe("childArgv", () => {
  test("forwards the audit flags and writes a JSON report", () => {
    const argv = childArgv(
      "https://a.example.com/",
      "/o/r.json",
      { level: "surface", "max-pages": "5", offline: true, "urls-file": "x" },
      "/bin/squirrel"
    );
    expect(argv).toEqual([
      "/bin/squirrel",
      "audit",
      "https://a.example.com/",
      "-f",
      "json",
      "-o",
      "/o/r.json",
      "--max-pages",
      "5",
      "--level",
      "surface",
      "--offline",
    ]);
  });

  test("under bun the script is part of the command", () => {
    expect(
      childArgv(
        "https://a.example.com/",
        "r",
        {},
        "/usr/bin/bun",
        "/app/cli.ts"
      ).slice(0, 3)
    ).toEqual(["/usr/bin/bun", "/app/cli.ts", "audit"]);
  });
});
