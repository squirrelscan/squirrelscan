// #626: no CLI test may publish or touch project data in the real ~/.squirrel.
//
// Bun reads `os.homedir()` once at process start, so `process.env.HOME = tmp`
// inside a test moves nothing, and a test that runs an audit or a publish with
// only that set reads and writes the developer's real store. On a machine with
// thousands of project databases those tests also time out. The isolation that
// works is `isolateSquirrelHome` (tests/helpers/scratch-squirrel-home.ts).
// This fails any test file that reaches a store-touching entry point without it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TESTS = import.meta.dir;

/** Calls that publish, or open a project database or the shared stores. */
const STORE_TOUCHING = new RegExp(
  [
    // A command run: `audit.run!(…)`, `report.run?.(…)`.
    String.raw`\b(?:audit|report|crawl)\.run(?:!|\?\.)?\(`,
    String.raw`\b(?:publishReport|savePublishedReportInfo|runAudit|runCrawl|createStorage|getStoredAudit|getStoredAuditByPrefix|getLatestAudit|listStoredAudits)\(`,
    // The local MCP tools that audit or read the projects: `name: "audit_website"`.
    String.raw`name:\s*"(?:audit_website|quick_check|list_entities|get_entity|get_entity_graph|get_entity_findings|compare_entities)"`,
  ].join("|")
);

/** A file that moves `homedir()` itself, which isolates every path too. */
const MOVES_HOMEDIR = /mock\.module\(\s*"node:os"/;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** Comment lines and blocks out, so a comment naming `runAudit()` is not a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Test files that reach the store without the helper or a moved homedir(). */
function unisolated(files: Array<{ path: string; source: string }>): string[] {
  return files
    .filter(({ source }) => {
      const body = code(source);
      return (
        STORE_TOUCHING.test(body) &&
        !/\bisolateSquirrelHome\(/.test(body) &&
        !MOVES_HOMEDIR.test(body)
      );
    })
    .map(({ path }) => path);
}

describe("CLI tests never touch the real ~/.squirrel (#626)", () => {
  test("every test file that publishes or opens project data uses a scratch home", () => {
    const files = testFiles(TESTS).map((path) => ({
      path: relative(TESTS, path),
      source: readFileSync(path, "utf-8"),
    }));
    expect(unisolated(files)).toEqual([]);
  });

  test("the guard catches the ways a test reaches the store", () => {
    const file = (source: string) => [{ path: "x.test.ts", source }];
    expect(unisolated(file(`await audit.run!({ args })`))).toEqual([
      "x.test.ts",
    ]);
    expect(unisolated(file(`await report.run?.({ args })`))).toEqual([
      "x.test.ts",
    ]);
    expect(unisolated(file(`await publishReport(r, {})`))).toEqual([
      "x.test.ts",
    ]);
    expect(
      unisolated(file(`client.callTool({ name: "list_entities", arguments })`))
    ).toEqual(["x.test.ts"]);
    expect(
      unisolated(file(`await savePublishedReportInfo(db, id, r, u, "public")`))
    ).toEqual(["x.test.ts"]);
    // Setting HOME is not isolation: homedir() was read at process start.
    expect(
      unisolated(file(`process.env.HOME = tmp;\nawait audit.run!({ args })`))
    ).toEqual(["x.test.ts"]);
    // Isolated, a comment, or no store at all: clean.
    expect(
      unisolated(file(`isolateSquirrelHome("x");\nawait audit.run!({ args })`))
    ).toEqual([]);
    expect(unisolated(file(`// runAudit() is too heavy to call here`))).toEqual(
      []
    );
    expect(unisolated(file(`expect(slimForPublish(r)).toBeDefined()`))).toEqual(
      []
    );
  });
});
