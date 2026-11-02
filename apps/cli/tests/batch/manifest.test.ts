// The results file of a batch audit (#1231): written as records finish, read back to resume. Synthetic URLs only.

import { describe, expect, test } from "bun:test";

import {
  BATCH_STATUSES,
  type BatchRecord,
  type BatchStatus,
  formatRecord,
  effectiveStatus,
  isFailedStatus,
  isRetryableStatus,
  latestRecords,
  parseManifest,
  planBatch,
} from "../../src/batch/manifest";
import { type BatchUrl, urlKey } from "../../src/batch/urls-file";
import {
  BATCH_MANIFEST_MAX_LINE_CHARS,
  BATCH_MANIFEST_MAX_LINES,
} from "../../src/constants";

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
      finishedAt: "2026-11-02T10:00:01.234Z",
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
      "running",
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

  test("blocked and redirected are failures a retry can change (#1231 spec); rejected is not", () => {
    const records = [
      record(a, "blocked"),
      record(b, "redirected"),
      record(c, "rejected"),
    ];
    const kept = planBatch([a, b, c], records);
    expect(kept.run).toEqual([]);
    expect([kept.failedKept, kept.done]).toEqual([2, 1]);
    const retried = planBatch([a, b, c], records, { retryFailed: true });
    expect(retried.run.map((x) => [x.entry.url, x.attempt])).toEqual([
      [a.url, 2],
      [b.url, 2],
    ]);
    expect(retried.done).toBe(1);
  });

  test("a `running` line that is the last record is a process that died: read as crashed", () => {
    expect(effectiveStatus(record(a, "running"))).toBe("crashed");
    expect(effectiveStatus(record(a, "completed"))).toBe("completed");
    const records = [
      record(a, "running", 1),
      record(b, "running", 1),
      record(b, "completed", 1),
    ];
    const kept = planBatch([a, b], records);
    expect([kept.failedKept, kept.done]).toEqual([1, 1]); // a died; b's `running` was followed by its result
    expect(
      planBatch([a], records, { retryFailed: true }).run.map((x) => x.attempt)
    ).toEqual([2]);
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
    const failed: BatchStatus[] = [
      "blocked",
      "unreachable",
      "redirected",
      "failed",
      "timeout",
      "crashed",
      "running",
    ];
    expect(BATCH_STATUSES.filter((s) => isRetryableStatus(s))).toEqual(failed);
    expect(BATCH_STATUSES.filter((s) => isFailedStatus(s))).toEqual(failed);
  });
});

describe("a manifest read back is validated, not trusted (#1547 review)", () => {
  const e = entry("a");
  const line = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      v: 1,
      url: e.url,
      key: e.key,
      status: "completed",
      attempt: 1,
      ...extra,
    });
  const one = (extra: Record<string, unknown>) => parseManifest(line(extra));

  test("a key that is not 16 hex characters is not a record", () => {
    for (const key of [
      "../../x",
      "",
      "ABCDEF0123456789",
      "abc",
      `${e.key}0`,
      "0123456789abcdeg",
    ]) {
      expect(one({ key }), key).toMatchObject({ records: [], skipped: 1 });
    }
  });

  test("a report path outside the batch directory is dropped, a relative one kept", () => {
    for (const report of [
      "../x.json",
      "a/../../x.json",
      "/etc/passwd",
      "a\\b.json",
      "..",
      ".",
      "a//b",
      "a/./b",
      "C:x",
      "a\u0000b",
      "",
    ]) {
      expect(
        one({ report }).records[0]!.report,
        JSON.stringify(report)
      ).toBeUndefined();
    }
    expect(
      one({ report: "reports/0123456789abcdef.json" }).records[0]!.report
    ).toBe("reports/0123456789abcdef.json");
  });

  test("an attempt out of range is not a record: a tampered 1e308 cannot mask later records", () => {
    expect(one({ attempt: 1e308 }).records).toEqual([]);
    expect(one({ attempt: 1001 }).records).toEqual([]);
    expect(one({ attempt: 1000 }).records).toHaveLength(1);
    const masked = [record(e, "failed", 1), record(e, "completed", 2)];
    expect(
      planBatch(
        [e],
        [
          ...masked,
          ...parseManifest(line({ attempt: 1e308, status: "failed" })).records,
        ]
      ).done
    ).toBe(1);
  });

  test("numbers out of range or not finite are dropped (1e999 reads as Infinity)", () => {
    const raw = `{"v":1,"url":${JSON.stringify(e.url)},"key":"${e.key}","status":"completed","attempt":1,"score":1e999,"pages":1e999,"exitCode":1e999,"durationMs":1e999}`;
    expect(parseManifest(raw).records[0]).toEqual({
      v: 1,
      url: e.url,
      key: e.key,
      status: "completed",
      attempt: 1,
    });
    expect(
      parseManifest(raw.replace('"attempt":1', '"attempt":1e999')).records
    ).toEqual([]);
    const r = one({ score: 101, pages: -1, exitCode: 256, durationMs: -5 })
      .records[0]!;
    expect([r.score, r.pages, r.exitCode, r.durationMs]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const ok = one({ score: 0, pages: 0, exitCode: 6, durationMs: 0 })
      .records[0]!;
    expect([ok.score, ok.pages, ok.exitCode, ok.durationMs]).toEqual([
      0, 0, 6, 0,
    ]);
    expect(
      one({ pages: 2.5, exitCode: 1.5 }).records[0]!.pages
    ).toBeUndefined();
  });

  test("a URL longer than the URL cap, and a text field past its cap, are not trusted", () => {
    expect(
      one({ url: `https://a.example/${"x".repeat(3_000)}` }).records
    ).toEqual([]);
    expect(
      one({ error: "e".repeat(10_001) }).records[0]!.error
    ).toBeUndefined();
    expect(one({ error: "e".repeat(10_000) }).records[0]!.error).toHaveLength(
      10_000
    );
    expect(
      one({ notes: Array.from({ length: 80 }, () => "n") }).records[0]!.notes
    ).toHaveLength(50);
  });

  test("a line over the line cap is skipped without being parsed", () => {
    const long = line({ error: "x".repeat(BATCH_MANIFEST_MAX_LINE_CHARS) });
    expect(long.length).toBeGreaterThan(BATCH_MANIFEST_MAX_LINE_CHARS);
    const good = formatRecord(record(e, "completed"));
    expect(parseManifest(`${long}\n${good}`)).toMatchObject({
      skipped: 1,
      truncated: false,
    });
    expect(parseManifest(`${long}\n${good}`).records).toHaveLength(1);
  });
});

describe("the plan is derived from the urls file alone", () => {
  const a = entry("a");
  const b = entry("b");

  test("a record whose url differs from its key does not count as done", () => {
    const forged = record(a, "completed", 1, { url: b.url }); // a's key, b's URL
    const plan = planBatch([a], [forged]);
    expect(plan.done).toBe(0);
    expect(plan.run.map((x) => x.entry.url)).toEqual([a.url]);
  });

  test("a forged record with a higher attempt does not mask the URL's real record", () => {
    const real = record(a, "completed", 1);
    const forged = record(a, "failed", 9, { url: b.url });
    expect(planBatch([a], [real, forged]).done).toBe(1);
  });

  test("a record of a URL that is not in the file adds nothing to the plan", () => {
    const plan = planBatch([a], [record(b, "failed")]);
    expect([plan.run.length, plan.done, plan.failedKept]).toEqual([1, 0, 0]);
  });
});

describe("the same attempt twice", () => {
  const a = entry("a");
  test("the later line wins a tie, in either order of status", () => {
    expect(
      latestRecords([record(a, "running", 1), record(a, "completed", 1)]).get(
        a.key
      )?.status
    ).toBe("completed");
    expect(
      latestRecords([record(a, "completed", 1), record(a, "failed", 1)]).get(
        a.key
      )?.status
    ).toBe("failed");
  });
});
