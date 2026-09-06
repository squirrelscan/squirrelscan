import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEST_FILE,
  bunFilter,
  checkCoverage,
  planSuites,
  selectedBy,
  suiteNames,
  suiteRoot,
  suitesRunBy,
  testFilesIn,
} from "./test-suites.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A ci.yml stand-in that runs exactly the named suites. */
function workflowRunning(names: string[]): string {
  return names.map((n) => `      - run: bun run scripts/test-suites.ts --run ${n}\n`).join("");
}

/** One test file per suite, so the default fixture is a valid partition. */
const files = [
  "apps/cli/a.test.ts",
  "packages/audit-engine/a.test.ts",
  "packages/crawler/a.test.ts",
  "packages/rules/a.test.ts",
  "packages/report/a.test.ts",
  "scripts/a.test.ts",
];

describe("testFilesIn", () => {
  test("keeps every naming bun treats as a test file, whatever the case", () => {
    const tracked = ["a/x.test.ts", "a/y.spec.tsx", "a/z_test.mts", "a/Cloudflare.Test.ts"];
    expect(testFilesIn(tracked)).toEqual(tracked);
  });

  test("drops files bun would never run", () => {
    // Dot-directories are skipped by bun, so counting them as covered would
    // certify a file that never executes.
    expect(testFilesIn([".github/scripts/verify.test.ts"])).toEqual([]);
    expect(testFilesIn(["packages/a/src/index.ts", "packages/a/tests/helper.ts"])).toEqual([]);
    // Anchored: `e.test.helper.ts` is not a test file to bun either.
    expect(testFilesIn(["packages/a/e.test.helper.ts"])).toEqual([]);
  });

  test("the regex is case-insensitive, because bun's discovery is", () => {
    expect(TEST_FILE.test("Cloudflare.Test.ts")).toBe(true);
  });
});

describe("suiteRoot", () => {
  test("attributes apps/ and packages/ files to their workspace", () => {
    expect(suiteRoot("packages/rules/tests/a.test.ts")).toBe("packages/rules");
    expect(suiteRoot("apps/cli/tests/a.test.ts")).toBe("apps/cli");
  });

  test("attributes everything else to its top-level directory", () => {
    expect(suiteRoot("scripts/release-version.test.ts")).toBe("scripts");
    expect(suiteRoot("npm/scripts/postinstall.test.ts")).toBe("npm");
  });

  test("attributes a repo-root test file to itself, so bun can still target it", () => {
    expect(suiteRoot("smoke.test.ts")).toBe("smoke.test.ts");
    expect(selectedBy(["smoke.test.ts"], ["smoke.test.ts"])).toEqual(["smoke.test.ts"]);
  });
});

describe("bunFilter and selectedBy", () => {
  test("anchors the filter to a real path", () => {
    expect(bunFilter("packages/report")).toBe("./packages/report");
  });

  test("a package whose name extends another's is NOT selected", () => {
    // The reason for the `./`: bare `bun test packages/report` selects
    // packages/report-v2 too, by substring.
    const tree = ["packages/report/a.test.ts", "packages/report-v2/a.test.ts"];
    expect(selectedBy(["packages/report"], tree)).toEqual(["packages/report/a.test.ts"]);
  });

  test("a nested directory sharing a top-level name is NOT selected", () => {
    const tree = ["scripts/a.test.ts", "apps/cli/scripts/b.test.ts"];
    expect(selectedBy(["scripts"], tree)).toEqual(["scripts/a.test.ts"]);
  });
});

describe("planSuites", () => {
  test("puts an unnamed package in rest, not in a named suite", () => {
    const plan = planSuites(["packages/rules/a.test.ts", "packages/brand-new/a.test.ts"]);
    expect(plan.find((s) => s.name === "rest")?.roots).toEqual(["packages/brand-new"]);
    expect(plan.find((s) => s.name === "rules")?.roots).toEqual(["packages/rules"]);
  });

  test("the suites partition the tree: every file selected, by exactly one suite", () => {
    const tree = [...files, "packages/newthing/a.test.ts", "npm/scripts/a.test.ts"];
    const plan = planSuites(tree);
    const runs = tree.map((f) => plan.filter((s) => selectedBy(s.roots, [f]).length === 1));
    expect(runs.map((suites) => suites.length)).toEqual(tree.map(() => 1));
  });
});

describe("suitesRunBy", () => {
  test("reads the suite names ci.yml actually runs", () => {
    expect(suitesRunBy(workflowRunning(["cli", "rest"]))).toEqual(["cli", "rest"]);
  });

  test("ignores a commented-out step, which runs nothing", () => {
    const yaml = `${workflowRunning(["cli"])}      # - run: bun run scripts/test-suites.ts --run rest\n`;
    expect(suitesRunBy(yaml)).toEqual(["cli"]);
  });
});

describe("checkCoverage", () => {
  test("passes when ci.yml runs every suite once", () => {
    expect(checkCoverage(files, workflowRunning(suiteNames()))).toEqual([]);
  });

  test("fails when ci.yml drops a suite", () => {
    const dropped = suiteNames().filter((n) => n !== "rest");
    expect(checkCoverage(files, workflowRunning(dropped))).toContain(
      'ci.yml never runs suite "rest"',
    );
  });

  test("fails when ci.yml runs a suite twice", () => {
    expect(checkCoverage(files, workflowRunning([...suiteNames(), "rules"]))).toContain(
      'ci.yml runs suite "rules" 2 times',
    );
  });

  test("fails on a suite name ci.yml invents", () => {
    expect(checkCoverage(files, workflowRunning([...suiteNames(), "nope"]))).toContain(
      'ci.yml runs unknown suite "nope"',
    );
  });

  test("fails when a suite resolves to no directories, which would run the whole tree", () => {
    // Nothing outside the named suites, so `rest` is empty and a bare `bun test`
    // in that step would silently widen to every package.
    const named = files.filter((f) => !f.startsWith("scripts/"));
    expect(checkCoverage(named, workflowRunning(suiteNames()))).toContain(
      'suite "rest" resolves to no directories',
    );
  });

  test("fails when a named suite has gone stale, e.g. its package was renamed", () => {
    // packages/audit-engine -> packages/engine. The rename is invisible to the
    // complement (rest just absorbs it), but the named suite now runs nothing,
    // and bun exits non-zero on a filter matching no files.
    const renamed = files.map((f) => f.replace("packages/audit-engine/", "packages/engine/"));
    expect(checkCoverage(renamed, workflowRunning(suiteNames()))).toContain(
      'suite "audit-engine" points at packages/audit-engine/, which has no test files',
    );
  });

  test("names the file when two suites would both run it", () => {
    // `apps/stray.test.ts` makes `apps` a rest root, which also selects apps/cli.
    const overlapping = [...files, "apps/stray.test.ts"];
    expect(checkCoverage(overlapping, workflowRunning(suiteNames()))).toContain(
      'suites "cli" and "rest" both run apps/cli/a.test.ts',
    );
  });

  test("does NOT fail on a package whose name merely extends a named suite's", () => {
    // packages/report-v2 is a substring collision, but `./packages/report` does
    // not select it, so this is a legal tree and the gate must stay green.
    const extended = [...files, "packages/report-v2/a.test.ts"];
    expect(checkCoverage(extended, workflowRunning(suiteNames()))).toEqual([]);
  });

  test("does NOT fail on a nested scripts/ directory inside a named suite", () => {
    const nested = [...files, "apps/cli/scripts/gen.test.ts"];
    expect(checkCoverage(nested, workflowRunning(suiteNames()))).toEqual([]);
  });
});

describe("the real repository", () => {
  test("ci.yml runs every suite, and every test file has exactly one", async () => {
    const workflow = await Bun.file(join(repoRoot, ".github/workflows/ci.yml")).text();
    const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repoRoot });
    const tree = testFilesIn(tracked.stdout.toString().split("\0"));

    expect(tree.length).toBeGreaterThan(300);
    expect(checkCoverage(tree, workflow)).toEqual([]);
  });
});
