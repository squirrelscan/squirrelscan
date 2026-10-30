// registerRun is the one call that creates a billable cloud run, so it only
// ever sees a URL the audit can start on: http(s), a host, no credentials.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { registerableUrl, registerRun } from "@/lib/run-tracker";

const originalFetch = globalThis.fetch;
const originalToken = process.env.SQUIRREL_API_TOKEN;
let calls: string[] = [];

beforeEach(() => {
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(input.toString());
    return Response.json(
      { runId: "R", auditId: "A", websiteId: "W" },
      { status: 201 }
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.SQUIRREL_API_TOKEN;
  else process.env.SQUIRREL_API_TOKEN = originalToken;
});

const BAD = [
  "ftp://example.com/",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "data:text/html,hi",
  "ht!tp://example.com/",
  "https://",
  "://example.com",
  "x://",
  "",
  " ",
  `ftp://example.com/${"a".repeat(5000)}`,
];

describe("registerRun", () => {
  test.each(BAD)("refuses %p with no network call", async (url) => {
    expect(await registerRun({ url })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("registers a normalised URL", async () => {
    expect(
      await registerRun({ url: " HTTP://user:pw@Example.com/a " })
    ).not.toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("registerableUrl", () => {
  test("normalises and strips credentials", () => {
    expect(registerableUrl("example.com")).toBe("https://example.com/");
    expect(registerableUrl("https://u:p@example.com/x")).toBe(
      "https://example.com/x"
    );
    expect(registerableUrl("ftp://example.com")).toBeNull();
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("every registerRun caller validates the URL first", () => {
  test("callers are known and import registerableUrl", () => {
    const src = join(import.meta.dir, "../../src");
    const callers = sourceFiles(src).filter(
      (f) =>
        !f.endsWith("lib/run-tracker.ts") &&
        /\bregisterRun\(/.test(readFileSync(f, "utf8"))
    );
    expect(callers.map((f) => f.slice(src.length + 1)).sort()).toEqual([
      "cli/commands/audit.ts",
      "mcp/billed-audit.ts",
    ]);
    for (const f of callers) {
      expect(readFileSync(f, "utf8")).toContain("registerableUrl");
    }
  });
});
