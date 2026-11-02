// The results file of a batch audit (#1231): written as records finish, read back to resume. Synthetic URLs only.

import { describe, expect, test } from "bun:test";

import {
  BATCH_STATUSES,
  type BatchRecord,
  type BatchStatus,
  formatRecord,
  isRetryableStatus,
  latestRecords,
  parseManifest,
  planBatch,
} from "../../src/batch/manifest";
import { type BatchUrl, urlKey } from "../../src/batch/urls-file";
import { BATCH_MANIFEST_MAX_LINES } from "../../src/constants";

const entry = (name: string, line = 1): BatchUrl => {
  const url = `https://${name}.example/`;
  return { url, key: urlKey(url), line };
};
const record = (
  e: BatchUrl,
  status: BatchStatus,
  attempt = 1,
  extra: Partial<BatchRecord> = {}
): BatchRecord => ({
  v: 1,
  url: e.url,
  key: e.key,
  status,
  attempt,
  ...extra,
});

describe("records", () => {
  test("a record is one line of JSON and reads back as written", () => {
    const e = entry("a");
    const full = record(e, "completed", 2, {
      reason: "ok",
      exitCode: 0,
      startedAt: "2026-11-02T10:00:00.000Z",
      durationMs: 1234,
      report: "reports/abc.json",
      score: 91,
      pages: 30,
      finalUrl: "https://www.a.example/",
      error: "none",
      notes: ["retention retired 1 audit"],
    });
    const line = formatRecord(full);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseManifest(line)).toEqual({
      records: [full],
      skipped: 0,
      truncated: false,
    });
  });

  test("a text with a newline in it stays on one line", () => {
    const e = entry("a");
    const line = formatRecord(
      record(e, "failed", 1, { error: "line one\nline two\r\nthree" })
    );
    expect(line.split("\n")).toHaveLength(2);
    expect(parseManifest(line).records[0]!.error).toBe(
      "line one\nline two\r\nthree"
    );
  });

  test("every status of the vocabulary is accepted, and nothing else", () => {
    const e = entry("a");
    expect(BATCH_STATUSES).toEqual([
      "completed",
      "partial",
      "blocked",
      "unreachable",
      "redirected",
      "failed",
      "timeout",
      "crashed",
      "rejected",
      "skipped-budget",
    ]);
    for (const status of BATCH_STATUSES)
      expect(
        parseManifest(formatRecord(record(e, status))).records
      ).toHaveLength(1);
    const bad = JSON.stringify({
      v: 1,
      url: e.url,
      key: e.key,
      status: "done",
      attempt: 1,
    });
    expect(parseManifest(bad)).toEqual({
      records: [],
      skipped: 1,
      truncated: false,
    });
  });
});

describe("parseManifest tolerates what a crash or an edit leaves", () => {
  const e = entry("a");
  const good = formatRecord(record(e, "completed"));

  test("a last line cut short is counted and skipped, the lines before it are kept", () => {
    const cut = good.slice(0, 40);
    const r = parseManifest(good + good + cut);
    expect(r.records).toHaveLength(2);
    expect(r.skipped).toBe(1);
  });

  test("blank lines, text that is not JSON, JSON that is not a record, and another format version", () => {
    const r = parseManifest(
      [
        "",
        "not json",
        "[]",
        "null",
        "42",
        JSON.stringify({
          v: 2,
          url: e.url,
          key: e.key,
          status: "completed",
          attempt: 1,
        }),
        JSON.stringify({
          v: 1,
          url: 5,
          key: e.key,
          status: "completed",
          attempt: 1,
        }),
        JSON.stringify({
          v: 1,
          url: e.url,
          key: e.key,
          status: "completed",
          attempt: 0,
        }),
        JSON.stringify({
          v: 1,
          url: e.url,
          key: e.key,
          status: "completed",
          attempt: 1.5,
        }),
        good.trim(),
      ].join("\n")
    );
    expect(r.records).toHaveLength(1);
    expect(r.skipped).toBe(8);
  });

  test("fields of the wrong type are dropped, not trusted", () => {
    const line = JSON.stringify({
      v: 1,
      url: e.url,
      key: e.key,
      status: "completed",
      attempt: 1,
      score: "high",
      pages: null,
      report: 7,
      exitCode: Infinity,
      notes: ["ok", 3],
    });
    expect(parseManifest(line).records[0]).toEqual({
      v: 1,
      url: e.url,
      key: e.key,
      status: "completed",
      attempt: 1,
      notes: ["ok"],
    });
  });

  test("a file of more lines than the cap is read to the cap and says so", () => {
    const r = parseManifest(good.repeat(7), 5);
    expect(r.truncated).toBe(true);
    expect(r.records).toHaveLength(5);
    // exactly the cap is not truncated
    expect(parseManifest(good.repeat(5), 5)).toMatchObject({
      truncated: false,
    });
    expect(parseManifest(good.repeat(5), 5).records).toHaveLength(5);
  });

  test("the real cap: a million short lines are read in bounded time and the next one is not", () => {
    const started = performance.now();
    const r = parseManifest("x\n".repeat(BATCH_MANIFEST_MAX_LINES + 1));
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(r).toMatchObject({
      truncated: true,
      skipped: BATCH_MANIFEST_MAX_LINES,
      records: [],
    });
    expect(parseManifest("x\n".repeat(BATCH_MANIFEST_MAX_LINES))).toMatchObject(
      { truncated: false, skipped: BATCH_MANIFEST_MAX_LINES }
    );
  }, 30_000);
});

describe("latestRecords and planBatch resume a batch", () => {
  const a = entry("a", 1);
  const b = entry("b", 2);
  const c = entry("c", 3);
  const d = entry("d", 4);

  test("the last record of a URL, by attempt, says where it stands", () => {
    const latest = latestRecords([
      record(a, "failed", 1),
      record(a, "completed", 2),
      record(b, "timeout", 1),
    ]);
    expect(latest.get(a.key)?.status).toBe("completed");
    expect(latest.get(b.key)?.status).toBe("timeout");
    // a later line with an older attempt number does not win
    expect(
      latestRecords([record(a, "completed", 2), record(a, "failed", 1)]).get(
        a.key
      )?.status
    ).toBe("completed");
  });

  test("no record runs; a finished one is left alone; the order of the file is kept", () => {
    const plan = planBatch(
      [a, b, c, d],
      [record(a, "completed"), record(c, "partial")]
    );
    expect(plan.run.map((x) => [x.entry.url, x.attempt])).toEqual([
      [b.url, 1],
      [d.url, 1],
    ]);
    expect(plan.done).toBe(2);
    expect(plan.failedKept).toBe(0);
  });

  test("a retryable failure is left alone, and run again as the next attempt with retry", () => {
    const records = [
      record(a, "failed"),
      record(b, "unreachable", 2),
      record(c, "timeout"),
      record(d, "crashed"),
    ];
    const kept = planBatch([a, b, c, d], records);
    expect(kept.run).toEqual([]);
    expect(kept.failedKept).toBe(4);
    const retried = planBatch([a, b, c, d], records, { retryFailed: true });
    expect(retried.run.map((x) => [x.entry.url, x.attempt])).toEqual([
      [a.url, 2],
      [b.url, 3],
      [c.url, 2],
      [d.url, 2],
    ]);
    expect(retried.failedKept).toBe(0);
  });

  test("blocked, redirected and rejected are results a retry cannot change: left alone with retry too", () => {
    const records = [
      record(a, "blocked"),
      record(b, "redirected"),
      record(c, "rejected"),
    ];
    const plan = planBatch([a, b, c], records, { retryFailed: true });
    expect(plan.run).toEqual([]);
    expect(plan.done).toBe(3);
  });

  test("a URL that was not started runs, as the next attempt", () => {
    const plan = planBatch([a], [record(a, "skipped-budget", 1)]);
    expect(plan.run.map((x) => [x.entry.url, x.attempt])).toEqual([[a.url, 2]]);
  });

  test("a URL retried and completed is done; one retried and failed again stays a failure", () => {
    expect(
      planBatch([a], [record(a, "failed", 1), record(a, "completed", 2)], {
        retryFailed: true,
      }).done
    ).toBe(1);
    expect(
      planBatch([a], [record(a, "failed", 1), record(a, "failed", 2)])
        .failedKept
    ).toBe(1);
  });

  test("records of URLs that are no longer in the file do not matter", () => {
    expect(planBatch([a], [record(b, "completed")]).run).toHaveLength(1);
  });

  test("which statuses are retryable", () => {
    expect(BATCH_STATUSES.filter((s) => isRetryableStatus(s))).toEqual([
      "unreachable",
      "failed",
      "timeout",
      "crashed",
    ]);
  });
});
