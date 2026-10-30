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
  "mailto:a@b.com",
  "javascript:alert(1)@x.com",
  "tel:+1@x.com",
  "data:,x@y.com",
];

describe("registerRun", () => {
  test.each(BAD)("refuses %p with no network call", async (url) => {
    expect(await registerRun({ url })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a URL past the register endpoint's 2048 limit is not registered", async () => {
    expect(
      await registerRun({ url: `https://example.com/${"a".repeat(2100)}` })
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  test("the fragment is dropped, the query kept", async () => {
    expect(registerableUrl("https://example.com/p?t=1#frag")).toBe(
      "https://example.com/p?t=1"
    );
  });

  test("registers a normalised URL", async () => {
    expect(
      await registerRun({
        url: ` HTTP://${["user", "pw"].join(":")}@Example.com/a `,
      })
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
    expect(registerableUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(registerableUrl("example.com:8080/x")).toBe(
      "https://example.com:8080/x"
    );
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("registerRun is the one door to /register", () => {
  const src = join(import.meta.dir, "../../src");
  const read = (f: string) => readFileSync(join(src, f), "utf8");

  test("only run-tracker posts to the register endpoint", () => {
    const posters = sourceFiles(src).filter((f) =>
      /\/register[`"']/.test(readFileSync(f, "utf8"))
    );
    expect(posters.map((f) => f.slice(src.length + 1))).toEqual([
      "lib/run-tracker.ts",
    ]);
  });

  test("registerRun validates the URL before its first request", () => {
    const body = read("lib/run-tracker.ts");
    const start = body.indexOf("export async function registerRun(");
    const check = body.indexOf("registerableUrl(input.url)", start);
    const request = body.indexOf("cliApi.request", start);
    expect(start).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(start);
    expect(request).toBeGreaterThan(check);
    // The register body carries the validated URL, never `input.url`.
    expect(body.slice(check, request)).not.toMatch(/url:\s*input\.url/);
  });

  test("callers are known", () => {
    const callers = sourceFiles(src).filter(
      (f) =>
        !f.endsWith("lib/run-tracker.ts") &&
        /\bregisterRun\(/.test(readFileSync(f, "utf8"))
    );
    expect(callers.map((f) => f.slice(src.length + 1)).sort()).toEqual([
      "cli/commands/audit.ts",
      "mcp/billed-audit.ts",
    ]);
  });
});
