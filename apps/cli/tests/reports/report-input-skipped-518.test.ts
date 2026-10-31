// #518: `squirrel report --input` reads `skippedChecks` back, so a saved report that is re-rendered or
// re-exported still lists the pages a rule did not finish checking. The file is user-supplied: bad
// entries are dropped, never rendered. Skipped checks stay out of `issues`.

import { renderJson, type AuditReport } from "@squirrelscan/report";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReport } from "../../src/controllers/report";

const dir = mkdtempSync(join(tmpdir(), "sq-518-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const meta = (id: string, name: string) => ({
  id,
  name,
  description: `${name} description`,
  category: "content" as const,
  scope: "page" as const,
  severity: "warning" as const,
  weight: 1,
});

function report(ruleResults: AuditReport["ruleResults"]): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-31T10:00:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 1,
    failed: 0,
    ruleResults,
  } as unknown as AuditReport;
}

const skippedRules: AuditReport["ruleResults"] = {
  "content/hidden-text": {
    meta: meta("content/hidden-text", "Hidden text"),
    checks: [
      {
        name: "hidden-text",
        status: "skipped",
        message: "too big",
        pageUrl: "https://example.com/big",
        skipReason: "scan-truncated",
      },
      {
        name: "hidden-text",
        status: "skipped",
        message: "too big",
        pageUrl: "https://example.com/huge",
        skipReason: "scan-truncated",
      },
      {
        name: "hidden-text",
        status: "warn",
        message: "hidden link",
        pageUrl: "https://example.com/a",
      },
    ],
  },
  "content/dev-leakage": {
    meta: meta("content/dev-leakage", "Dev leakage"),
    checks: [
      {
        name: "dev-leakage",
        status: "skipped",
        message: "folded",
        pages: ["https://example.com/x", "https://example.com/y"],
        details: { pagesTruncated: 40 },
        skipReason: "scan-truncated",
      },
    ],
  },
  "security/leaked-secrets": {
    meta: meta("security/leaked-secrets", "Leaked Secrets"),
    checks: [
      {
        name: "leaked-secrets",
        status: "skipped",
        message: "timed out",
        skipReason: "rule-timed-out",
        details: { pages: 7, budgetMs: 1000 },
      },
    ],
  },
  "content/quality": {
    meta: meta("content/quality", "Content quality"),
    checks: [
      {
        name: "quality",
        status: "skipped",
        message: "threw",
        skipReason: "rule-timed-out",
        details: { errored: true, pages: 2 },
      },
    ],
  },
};

function writeJson(name: string, json: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json));
  return file;
}

function reload(file: string) {
  const loaded = loadReport(file);
  if (!loaded.ok) throw new Error(`load failed: ${JSON.stringify(loaded)}`);
  return JSON.parse(renderJson(loaded.data) as string) as {
    summary: { skipped?: number };
    skippedChecks?: Array<Record<string, unknown>>;
    issues: Array<{ ruleId: string }>;
  };
}

describe("report --input reads skipped checks back (#518)", () => {
  const original = JSON.parse(renderJson(report(skippedRules)) as string) as {
    summary: { skipped: number };
    skippedChecks: Array<Record<string, unknown>>;
  };
  const file = writeJson("saved.json", JSON.stringify(original));

  test("the saved report has skips to read back", () => {
    expect(
      original.skippedChecks.map((s) => `${s.ruleId}:${s.reason}`)
    ).toEqual([
      "content/dev-leakage:scan-truncated",
      "content/hidden-text:scan-truncated",
      "content/quality:rule-errored",
      "security/leaked-secrets:rule-timed-out",
    ]);
    expect(original.summary.skipped).toBeGreaterThan(0);
  });

  test("re-exporting a loaded report keeps skippedChecks and summary.skipped identical", () => {
    const again = reload(file);
    expect(again.skippedChecks).toEqual(original.skippedChecks);
    expect(again.summary.skipped).toBe(original.summary.skipped);
  });

  test("a folded skip keeps its page total and a clipped list", () => {
    const folded = reload(file).skippedChecks?.find(
      (s) => s.ruleId === "content/dev-leakage"
    );
    expect(folded).toMatchObject({ pagesCount: 40, pagesHasMore: true });
    expect(folded?.pages).toEqual([
      "https://example.com/x",
      "https://example.com/y",
    ]);
  });

  test("skipped checks never become issues", () => {
    const again = reload(file);
    expect(again.issues.map((i) => i.ruleId)).toEqual(["content/hidden-text"]);
  });

  test("a report with no skips has none after the round trip", () => {
    const clean = JSON.parse(renderJson(report({})) as string);
    const again = reload(writeJson("clean.json", clean));
    expect(again.skippedChecks).toBeUndefined();
    expect(again.summary.skipped ?? 0).toBe(0);
  });

  test("hostile entries are dropped: unlisted reason, non-string pages, bad counts, wrong types", () => {
    const hostile = {
      ...original,
      skippedChecks: [
        {
          ruleId: "content/x",
          name: "X",
          check: "x",
          reason: "totally-made-up",
          pages: ["https://example.com/"],
          pagesCount: 1,
          pagesHasMore: false,
        },
        { ruleId: 42, check: "x", reason: "scan-truncated" },
        null,
        "string",
        {
          ruleId: "content/ok",
          name: "Ok",
          check: "ok",
          reason: "scan-truncated",
          pages: ["https://example.com/p", 7, { a: 1 }],
          pagesCount: -5,
        },
        {
          ruleId: "content/ok2",
          name: "Ok2",
          check: "ok",
          reason: "scan-truncated",
          pages: [],
          pagesCount: 1e300,
        },
      ],
    };
    const again = reload(writeJson("hostile.json", hostile));
    expect(again.skippedChecks?.map((s) => s.ruleId)).toEqual([
      "content/ok",
      "content/ok2",
    ]);
    expect(again.skippedChecks?.[0]).toMatchObject({
      pages: ["https://example.com/p"],
      pagesCount: 1,
    });
    expect(again.skippedChecks?.[1]).toMatchObject({ pagesCount: 0 });
  });

  test("rule ids that are object keys cannot crash the read or reach the report", () => {
    const base = {
      reason: "scan-truncated",
      name: "N",
      check: "c",
      pages: ["https://example.com/p"],
      pagesCount: 1,
      pagesHasMore: false,
    };
    const hostile = {
      ...original,
      skippedChecks: [
        ...[
          "__proto__",
          "constructor",
          "toString",
          "hasOwnProperty",
          "valueOf",
          "constructor/x/y",
          "__proto__/a",
        ].map((ruleId) => ({ ...base, ruleId })),
        { ...base, ruleId: "constructor/real-looking" },
        { ...base, ruleId: "content/ok" },
      ],
    };
    const again = reload(writeJson("protos.json", hostile));
    expect(again.skippedChecks?.map((s) => s.ruleId)).toEqual([
      "constructor/real-looking",
      "content/ok",
    ]);
    // The plain object everything is read into is untouched.
    expect(({} as Record<string, unknown>).checks).toBeUndefined();
  });

  test("terminal escapes, C1 controls and bidi overrides in a name, check or page are stripped (#518)", () => {
    const ESC = String.fromCharCode(27);
    const evil = {
      ...original,
      skippedChecks: [
        {
          ruleId: "content/ok",
          name: `Hidden${ESC}[2J${ESC}]8;;https://evil.example${ESC}\\text\u009b31m\u202egnirts\nnext`,
          check: `chk${ESC}[1;1H\u2066x\u2069`,
          reason: "scan-truncated",
          pages: [
            `https://example.com/p${ESC}[2J\u009b0m\u202e/x\r\nHost: evil`,
          ],
          pagesCount: 1,
          pagesHasMore: false,
        },
      ],
    };
    const again = reload(writeJson("escapes.json", evil));
    const entry = again.skippedChecks?.[0] as {
      name: string;
      check: string;
      pages: string[];
    };
    for (const value of [entry.name, entry.check, ...entry.pages]) {
      const unsafe = [...value].filter((ch) => {
        const c = ch.charCodeAt(0);
        return (
          c <= 0x1f ||
          (c >= 0x7f && c <= 0x9f) ||
          (c >= 0x202a && c <= 0x202e) ||
          (c >= 0x2066 && c <= 0x2069)
        );
      });
      expect(unsafe).toEqual([]);
    }
    expect(entry.pages[0]).toBe("https://example.com/p[2J0m/xHost: evil");
    expect(entry.name.startsWith("Hidden")).toBe(true);
  });

  test("a forged page count cannot round-trip into summary.skipped", () => {
    const forged = {
      ...original,
      skippedChecks: [
        {
          ruleId: "content/ok",
          name: "N",
          check: "c",
          reason: "scan-truncated",
          pages: ["https://example.com/p"],
          pagesCount: 9e15,
          pagesHasMore: true,
        },
      ],
    };
    const again = reload(writeJson("huge.json", forged));
    expect(again.skippedChecks?.[0]).toMatchObject({
      pagesCount: 1,
      pagesHasMore: false,
    });
    expect(again.summary.skipped).toBe(1);
  });

  test("a file with skippedChecks that is not a list reads as none", () => {
    const again = reload(
      writeJson("notlist.json", { ...original, skippedChecks: { a: 1 } })
    );
    expect(again.skippedChecks).toBeUndefined();
  });
});
